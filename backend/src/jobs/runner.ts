/**
 * 1 つのジョブを実行する：入力を集める → 生成 → 検証 → 本人の PDS に保存。
 * 作品は 1 人 1 件（レコードキー self）で、生成のたびに上書きする。
 * 外部とのやりとりは deps で受け取り、テストで差し替えられるようにする。
 */
import type { Agent } from "@atproto/api";
import { fetchProfileStats, fetchRecentPosts } from "../bluesky/posts.ts";
import { computeFeatures } from "../features/stats.ts";
import { ARTWORK_COLLECTION, ARTWORK_RKEY, buildArtworkRecord, type ArtworkRecord, type RecordRefs, type StrongRef } from "../generation/record.ts";
import type { GenerationInput, GenerationResult, ProfileStats } from "../generation/types.ts";
import type { Job, JobErrorCode, JobRepository } from "./repository.ts";

/** 公開 AppView から読むための Agent（ログイン不要）。 */
type PublicAgent = Pick<Agent, "getProfile" | "getAuthorFeed">;
/** 本人の PDS を読み書きするための Agent（OAuth セッション）。 */
type UserAgent = {
  com: { atproto: { repo: Pick<Agent["com"]["atproto"]["repo"], "getRecord" | "listRecords" | "putRecord" | "deleteRecord"> } };
};

export interface RunnerDeps {
  jobs: JobRepository;
  publicAgent: PublicAgent;
  getUserAgent(did: string): Promise<UserAgent>;
  generate(input: GenerationInput): Promise<GenerationResult>;
  /**
   * 保存前の検証（validation/chromium.ts）。Chromium 上の renderer で code を実行して確かめる。
   * 通らなければ JobError("validation_failed") を投げる。
   */
  validate(record: ArtworkRecord): Promise<void>;
  /** PDS に保存した作品を、ギャラリーの索引にすぐ入れる。 */
  onSaved?(artwork: { did: string; rkey: string; cid: string; record: ArtworkRecord }): void;
  timeZone: string;
}

/** 失敗の理由が利用者に見せてよい内容であることを示す。code は docs/api.md の JobErrorCode。 */
export class JobError extends Error {
  override name = "JobError";
  readonly code: JobErrorCode;
  constructor(message: string, code: JobErrorCode = "internal") {
    super(message);
    this.code = code;
  }
}

async function profileOf(deps: RunnerDeps, did: string): Promise<ProfileStats> {
  const { did: _did, handle: _handle, ...stats } = await fetchProfileStats(deps.publicAgent, did);
  return stats;
}

function isArtworkRecord(value: unknown): value is ArtworkRecord {
  const v = value as Partial<ArtworkRecord> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.code === "string" &&
    typeof v.renderer?.runtime === "string" &&
    typeof v.aspectRatio?.width === "number" &&
    typeof v.aspectRatio?.height === "number"
  );
}

/** いまの作品（レコードキー self）。なければ、以前の方式で投稿ごとに作った作品のうち最新のもの。 */
async function findPrevious(agent: UserAgent, did: string): Promise<{ ref: StrongRef; record: ArtworkRecord }> {
  let prev: { uri: string; cid?: string; value: unknown } | undefined;
  try {
    const { data } = await agent.com.atproto.repo.getRecord({ repo: did, collection: ARTWORK_COLLECTION, rkey: ARTWORK_RKEY });
    prev = data;
  } catch {
    const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: ARTWORK_COLLECTION, limit: 1 });
    prev = data.records[0];
  }
  if (!prev || !prev.cid) throw new JobError("前の作品が PDS に見つかりません", "upstream_error");
  if (!isArtworkRecord(prev.value)) throw new JobError(`前の作品の形式が正しくありません: ${prev.uri}`);
  return { ref: { uri: prev.uri, cid: prev.cid }, record: prev.value };
}

/**
 * self 以外の作品レコード（以前の方式で投稿ごとに作ったもの）を PDS から消す。
 * 失敗しても作品の保存は済んでいるので、ジョブは失敗にしない。
 */
async function deleteOldArtworks(agent: UserAgent, did: string): Promise<number> {
  const old: string[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: ARTWORK_COLLECTION, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const r of data.records) {
      const rkey = r.uri.slice(r.uri.lastIndexOf("/") + 1);
      if (rkey !== ARTWORK_RKEY) old.push(rkey);
    }
    cursor = data.records.length > 0 ? data.cursor : undefined;
  } while (cursor);
  for (const rkey of old) await agent.com.atproto.repo.deleteRecord({ repo: did, collection: ARTWORK_COLLECTION, rkey });
  return old.length;
}

type Built = { input: GenerationInput; refs: RecordRefs; applied?: undefined } | { applied: StrongRef };

async function buildInput(deps: RunnerDeps, job: Job, agent: UserAgent): Promise<Built> {
  const profile = await profileOf(deps, job.did);

  if (job.kind === "genesis") {
    const posts = await fetchRecentPosts(deps.publicAgent, job.did);
    return {
      input: {
        kind: "genesis",
        did: job.did,
        timeZone: deps.timeZone,
        posts: posts.map((p) => ({ text: p.text, createdAt: p.createdAt, langs: p.langs })),
        profile,
        features: computeFeatures(posts, { timeZone: deps.timeZone }),
      },
      refs: { kind: "genesis" },
    };
  }

  const { data: post } = await agent.com.atproto.repo.getRecord({ repo: job.did, collection: "app.bsky.feed.post", rkey: job.rkey });
  const value = post.value as { text?: unknown; createdAt?: unknown; langs?: unknown };
  if (!post.cid || typeof value.text !== "string") {
    throw new JobError("元の投稿を読めません（削除された可能性があります）", "upstream_error");
  }
  const previous = await findPrevious(agent, job.did);
  // 同じ投稿をもう反映済み（再試行や Jetstream の再配信）なら、作り直さない
  if (previous.record.trigger?.uri === post.uri) return { applied: previous.ref };
  return {
    input: {
      kind: "evolution",
      did: job.did,
      timeZone: deps.timeZone,
      post: {
        text: value.text,
        createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString(),
        langs: Array.isArray(value.langs) ? value.langs.filter((l): l is string => typeof l === "string") : undefined,
      },
      profile,
      previous: {
        title: previous.record.title,
        code: previous.record.code,
        params: previous.record.params ?? {},
        state: previous.record.state ?? {},
        animated: previous.record.renderer.animated ?? false,
        aspectRatio: previous.record.aspectRatio,
      },
    },
    refs: { kind: "evolution", trigger: { uri: post.uri, cid: post.cid }, previous: previous.ref },
  };
}

export async function runJob(deps: RunnerDeps, job: Job): Promise<StrongRef> {
  const agent = await deps.getUserAgent(job.did);
  const built = await buildInput(deps, job, agent);
  if (built.applied) {
    deps.jobs.complete(job.id, built.applied);
    return built.applied;
  }
  const { input, refs } = built;
  const result = await deps.generate(input);
  // 描画の乱数のシードは params.seed と同じにする（AI なしの生成では DID から作る）
  const seed = result.artwork.params.seed;
  const record = buildArtworkRecord(input, result, refs, typeof seed === "number" ? { seed } : {});

  deps.jobs.setStatus(job.id, "validating");
  await deps.validate(record);

  deps.jobs.setStatus(job.id, "saving");
  let saved: { uri: string; cid: string };
  try {
    const { data } = await agent.com.atproto.repo.putRecord({
      repo: job.did,
      collection: ARTWORK_COLLECTION,
      rkey: ARTWORK_RKEY,
      record: record as unknown as Record<string, unknown>,
    });
    saved = { uri: data.uri, cid: data.cid };
  } catch (err) {
    throw new JobError(`PDS に保存できませんでした: ${(err as Error).message}`, "pds_write_failed");
  }
  deps.jobs.complete(job.id, saved);
  deps.onSaved?.({ did: job.did, rkey: ARTWORK_RKEY, cid: saved.cid, record });
  try {
    const n = await deleteOldArtworks(agent, job.did);
    if (n > 0) console.log(`[worker] ${job.did}: 以前の方式の作品 ${n} 件を PDS から削除しました`);
  } catch (err) {
    console.error(`[worker] ${job.did}: 以前の方式の作品を削除できませんでした`, err);
  }
  return saved;
}
