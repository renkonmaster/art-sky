/**
 * 生成ジョブ（docs/tech-stack.md「ジョブ」）。
 *
 * - 同じきっかけのジョブは 1 つだけ（dedupe_key の一意制約）。
 * - 状態は queued → generating → validating → saving → done、失敗したら failed。
 * - 再試行は failed を queued に戻すだけ。作品のレコードキーはジョブ作成時に決まっているので、
 *   保存が二重に走っても同じレコードへの putRecord になり、作品は重複しない。
 * - 1 人のジョブは古い順に 1 つずつ処理する。evolution は genesis が終わるまで待つ。
 */
import { nowIso, type Database } from "../db/database.ts";

export type JobKind = "genesis" | "evolution";
export type JobStatus = "queued" | "generating" | "validating" | "saving" | "done" | "failed";
/** 失敗の種類（docs/api.md）。 */
export type JobErrorCode =
  | "refusal"
  | "invalid_output"
  | "validation_failed"
  | "pds_write_failed"
  | "auth_expired"
  | "upstream_error"
  | "internal";
const ACTIVE = "('generating', 'validating', 'saving')";

export interface Job {
  id: number;
  did: string;
  kind: JobKind;
  triggerUri: string | null;
  triggerCid: string | null;
  rkey: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  errorCode: JobErrorCode | null;
  artworkUri: string | null;
  artworkCid: string | null;
  createdAt: string;
  updatedAt: string;
}

interface JobRow {
  id: number;
  did: string;
  kind: JobKind;
  trigger_uri: string | null;
  trigger_cid: string | null;
  rkey: string;
  status: JobStatus;
  attempts: number;
  error: string | null;
  error_code: JobErrorCode | null;
  artwork_uri: string | null;
  artwork_cid: string | null;
  created_at: string;
  updated_at: string;
}

const toJob = (r: JobRow): Job => ({
  id: r.id,
  did: r.did,
  kind: r.kind,
  triggerUri: r.trigger_uri,
  triggerCid: r.trigger_cid,
  rkey: r.rkey,
  status: r.status,
  attempts: r.attempts,
  error: r.error,
  errorCode: r.error_code,
  artworkUri: r.artwork_uri,
  artworkCid: r.artwork_cid,
  createdAt: r.created_at,
  updatedAt: r.updated_at,
});

export function createJobRepository(db: Database) {
  const insert = db.prepare(
    `INSERT INTO jobs (did, kind, dedupe_key, trigger_uri, trigger_cid, rkey, status, created_at, updated_at)
     VALUES (?, ?, ?, ?, ?, ?, 'queued', ?, ?)
     ON CONFLICT (dedupe_key) DO NOTHING`,
  );
  const byDedupe = db.prepare("SELECT * FROM jobs WHERE dedupe_key = ?");
  const byId = db.prepare("SELECT * FROM jobs WHERE id = ?");
  const listByDid = db.prepare(
    "SELECT * FROM jobs WHERE did = ? AND (? IS NULL OR status = ?) ORDER BY id DESC LIMIT ? OFFSET ?",
  );
  // 処理できる最も古いジョブ：同じ人の処理中のジョブがなく、生成が止められていない。
  // evolution は、その人の genesis が終わっているものだけ。
  const nextQueued = db.prepare(
    `SELECT j.* FROM jobs j JOIN users u ON u.did = j.did
     WHERE j.status = 'queued'
       AND u.generation_enabled = 1
       AND NOT EXISTS (SELECT 1 FROM jobs a WHERE a.did = j.did AND a.status IN ${ACTIVE})
       AND (j.kind = 'genesis'
            OR EXISTS (SELECT 1 FROM jobs g WHERE g.did = j.did AND g.kind = 'genesis' AND g.status = 'done'))
     ORDER BY j.id LIMIT 1`,
  );
  const claim = db.prepare(
    "UPDATE jobs SET status = 'generating', attempts = attempts + 1, error = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'queued'",
  );
  const setStatus = db.prepare("UPDATE jobs SET status = ?, updated_at = ? WHERE id = ?");
  const complete = db.prepare(
    "UPDATE jobs SET status = 'done', artwork_uri = ?, artwork_cid = ?, error = NULL, error_code = NULL, updated_at = ? WHERE id = ?",
  );
  const fail = db.prepare("UPDATE jobs SET status = 'failed', error = ?, error_code = ?, updated_at = ? WHERE id = ?");
  const retry = db.prepare("UPDATE jobs SET status = 'queued', error = NULL, error_code = NULL, updated_at = ? WHERE id = ? AND status = 'failed'");
  const resetActive = db.prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status IN ${ACTIVE}`);
  const resetStale = db.prepare(`UPDATE jobs SET status = 'queued', updated_at = ? WHERE status IN ${ACTIVE} AND updated_at < ?`);

  function enqueue(
    did: string,
    kind: JobKind,
    dedupeKey: string,
    trigger: { uri: string; cid: string | null } | null,
    rkey: string,
  ): Job {
    const now = nowIso();
    insert.run(did, kind, dedupeKey, trigger?.uri ?? null, trigger?.cid ?? null, rkey, now, now);
    return toJob(byDedupe.get(dedupeKey) as unknown as JobRow);
  }

  return {
    /** 1 人につき 1 つだけ。すでにあればそれを返す。 */
    enqueueGenesis(did: string, rkey: string): Job {
      return enqueue(did, "genesis", `genesis:${did}`, null, rkey);
    },
    /** 同じ投稿からは 1 つだけ。レコードキーは元投稿と同じにする。 */
    enqueueEvolution(did: string, postUri: string, rkey: string, postCid: string | null = null): Job {
      return enqueue(did, "evolution", postUri, { uri: postUri, cid: postCid }, rkey);
    },
    get(id: number): Job | undefined {
      const row = byId.get(id) as JobRow | undefined;
      return row ? toJob(row) : undefined;
    },
    /** 新しい順。status を渡すと、その状態のものだけ。 */
    listByDid(did: string, limit = 50, offset = 0, status?: JobStatus): Job[] {
      return (listByDid.all(did, status ?? null, status ?? null, limit, offset) as unknown as JobRow[]).map(toJob);
    },
    /** 次に処理するジョブを generating にして返す。なければ undefined。 */
    claimNext(): Job | undefined {
      const row = nextQueued.get() as JobRow | undefined;
      if (!row) return undefined;
      if (claim.run(nowIso(), row.id).changes === 0) return undefined;
      return this.get(row.id);
    },
    setStatus(id: number, status: "validating" | "saving"): void {
      setStatus.run(status, nowIso(), id);
    },
    complete(id: number, artwork: { uri: string; cid: string }): void {
      complete.run(artwork.uri, artwork.cid, nowIso(), id);
    },
    fail(id: number, error: string, code: JobErrorCode = "internal"): void {
      fail.run(error.slice(0, 2000), code, nowIso(), id);
    },
    /** failed のジョブを queued に戻す。戻せたら true。 */
    retry(id: number): boolean {
      return retry.run(nowIso(), id).changes > 0;
    },
    /** 起動時に呼ぶ。前回の停止で処理中のまま残ったジョブをやり直す。 */
    resetInterrupted(): number {
      return Number(resetActive.run(nowIso()).changes);
    },
    /** 処理中のまま olderThanMs 以上たったジョブ（実行が途中で打ち切られたもの）をやり直す。 */
    resetStale(olderThanMs: number): number {
      return Number(resetStale.run(nowIso(), new Date(Date.now() - olderThanMs).toISOString()).changes);
    },
  };
}

export type JobRepository = ReturnType<typeof createJobRepository>;
