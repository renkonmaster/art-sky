/**
 * Jetstream（AT Protocol の更新を JSON で流す公開サービス）を購読して、登録済みの人の
 *   - Bluesky への新しい投稿   → 作品を変化させるジョブ（evolution）を作る
 *   - 作品レコードの作成・削除 → ギャラリーの索引を更新する
 * を行う（docs/tech-stack.md「投稿の監視」）。
 *
 * 接続はつなぎっぱなしにしない。定期実行（Cron）のたびに pullOnce で
 * 前回の続きから今までの分を受け取り、追いついたら切断する（Cloudflare Workers でも動く形）。
 *
 * このサイトに投稿機能はない。利用者は Bluesky でふつうに投稿し、ここでそれを見つける。
 */
import type { GalleryIndex } from "../gallery/index.ts";
import { ARTWORK_COLLECTION } from "../generation/record.ts";
import type { JobRepository } from "../jobs/repository.ts";
import type { UserRepository } from "../users.ts";

const POST_COLLECTION = "app.bsky.feed.post";

/** Jetstream の commit イベント（使う部分だけ）。 */
export interface JetstreamEvent {
  did: string;
  time_us: number;
  kind: string;
  commit?: {
    operation: "create" | "update" | "delete";
    collection: string;
    rkey: string;
    cid?: string;
    record?: unknown;
  };
}

export interface ConsumerDeps {
  users: UserRepository;
  jobs: JobRepository;
  gallery: GalleryIndex;
}

/** 返信・引用は対象外（Plan.md 10 節）。リポストは別のコレクションなので届かない。 */
function isPlainPost(record: unknown): boolean {
  const r = record as { reply?: unknown; embed?: { $type?: unknown } } | null;
  if (typeof r !== "object" || r === null) return false;
  if (r.reply) return false;
  const embed = r.embed?.$type;
  return embed !== "app.bsky.embed.record" && embed !== "app.bsky.embed.recordWithMedia";
}

/**
 * イベント 1 件を処理する。何をしたかを返す（ログとテスト用）。
 * 同じイベントが二度届いても結果は変わらない（ジョブは元投稿ごとに 1 つ、索引は上書き）。
 */
export async function handleEvent(deps: ConsumerDeps, event: JetstreamEvent): Promise<"job" | "indexed" | "removed" | "ignored"> {
  const commit = event.commit;
  if (event.kind !== "commit" || !commit) return "ignored";
  const user = await deps.users.get(event.did);
  // 登録していない人のレコードは扱わない（購読の絞り込みをすり抜けた場合の備え）。
  if (!user || user.consentedAt === null) return "ignored";

  if (commit.collection === ARTWORK_COLLECTION) {
    if (commit.operation === "delete") {
      await deps.gallery.remove(event.did, commit.rkey);
      return "removed";
    }
    if (!commit.cid) return "ignored";
    return (await deps.gallery.upsert({ did: event.did, rkey: commit.rkey, cid: commit.cid, record: commit.record })) ? "indexed" : "ignored";
  }

  if (commit.collection === POST_COLLECTION && commit.operation === "create") {
    if (!user.generationEnabled) return "ignored"; // 生成を止めている間の投稿では作らない
    if (!isPlainPost(commit.record)) return "ignored";
    // 登録より前の投稿は対象外（カーソルを巻き戻して再生したときの備え）。
    if (event.time_us / 1000 < Date.parse(user.consentedAt)) return "ignored";
    await deps.jobs.enqueueEvolution(event.did, `at://${event.did}/${POST_COLLECTION}/${commit.rkey}`, commit.rkey, commit.cid ?? null);
    return "job";
  }
  return "ignored";
}

export interface PullOptions {
  /** Jetstream のエンドポイント。 */
  url?: string;
  /** カーソル（最後に処理したイベントの時刻、マイクロ秒）の読み書き。 */
  loadCursor(): Promise<number | undefined> | number | undefined;
  saveCursor(cursor: number): Promise<void> | void;
  /** 接続を作る。テストで差し替えられるようにしている。 */
  createSocket?: (url: string) => WebSocket;
  /** カーソルが古すぎて続きを読めないときに、投稿を取り直すのに使う（公開 AppView）。 */
  feedAgent?: FeedAgent;
  /** 何も届かない時間がこれだけ続いたら、追いついたとみなして切断する。 */
  idleMs?: number;
  /**
   * 最初のイベントが届くまでに待つ時間。Jetstream は DID で絞ってから送るので、さかのぼって読む間は
   * 対象の投稿が見つかるまで何も届かない。idleMs より長く待つ。
   */
  firstIdleMs?: number;
  /** 1 回の接続の上限時間。 */
  maxMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

export interface PullResult {
  /** 何をしたか。 */
  outcome: "pulled" | "no-users" | "failed";
  /** 受け取ったイベントの数と、作ったジョブの数。 */
  events: number;
  jobs: number;
  /** カーソルが古すぎたので、投稿を取り直した人数。 */
  backfilled: number;
}

/** 投稿の取り直しに使う部分だけ（AtpAgent の getAuthorFeed）。 */
export type FeedAgent = {
  getAuthorFeed(params: { actor: string; limit: number; filter: "posts_no_replies" }): Promise<{
    data: { feed: { post: { uri: string; cid: string; author: { did: string }; record: unknown }; reason?: unknown }[] };
  }>;
};

const DEFAULT_URL = "wss://jetstream2.us-east.bsky.network/subscribe";
/** 一度に購読できる DID の上限（Jetstream の仕様）。 */
const MAX_WANTED_DIDS = 10_000;
/** 取りこぼしを避けるため、最後に処理した時刻のこれだけ前から読み直す。 */
const REWIND_US = 5_000_000;
/**
 * 追いついたと判定しても、カーソルは接続した時刻のこれだけ前までしか進めない。
 * 「何も届かない＝追いついた」という判定は、届くのが遅れただけの場合に外れるので、
 * 直近の分は次回も読み直して拾えるようにする（ジョブは投稿ごとに 1 つなので重複しない）。
 */
const REREAD_US = 3 * 60 * 1_000_000;
/** Jetstream がさかのぼれるのはおよそ 1 日分。これより古いカーソルは続きを読めないものとして扱う。 */
const MAX_CURSOR_AGE_US = 20 * 3600 * 1_000_000;
/** 取り直すときに見る、1 人あたりの直近の投稿数。 */
const BACKFILL_POSTS = 5;

/**
 * Jetstream に 1 回だけつなぎ、前回の続きから今までのイベントを handleEvent に渡して切断する。
 *
 * - 購読は登録済みの DID と、投稿・作品の 2 つのコレクションに絞る。
 * - 次のどれかで切断し、カーソルを保存する。
 *     1. 接続した時刻のイベントまで追いついた
 *     2. 何も届かない時間が続いた（最初のイベントまでは firstIdleMs、そのあとは idleMs）
 *     3. maxMs を過ぎた（残りは次回）
 *   1 と 2 では、カーソルを「接続した時刻の 3 分前」まで進める（直近の分は次回も読み直す）。
 *   3 と、処理に失敗したイベントがあったときは、確実に処理したところまでしか進めない。
 * - 同じイベントが二度届いても handleEvent は同じ結果になるので、少し前から読み直してよい。
 * - カーソルが古すぎる（止まっていた）ときは、各人の直近の投稿を公開 AppView から取り直し、
 *   今の時刻から読み始める。
 */
export async function pullOnce(deps: ConsumerDeps, options: PullOptions): Promise<PullResult> {
  const log = options.log ?? ((m: string) => console.log(`[jetstream] ${m}`));
  const now = options.now ?? Date.now;
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  const idleMs = options.idleMs ?? 2000;
  const firstIdleMs = options.firstIdleMs ?? 6000;
  const maxMs = options.maxMs ?? 20_000;
  const result: PullResult = { outcome: "pulled", events: 0, jobs: 0, backfilled: 0 };

  const dids = (await deps.users.listRegistered()).map((u) => u.did);
  if (dids.length === 0) return { ...result, outcome: "no-users" };
  if (dids.length > MAX_WANTED_DIDS) log(`登録者が ${MAX_WANTED_DIDS} 人を超えています。超えた分の投稿は拾えません`);

  const startedUs = now() * 1000;
  let cursor = await options.loadCursor();
  if (cursor !== undefined && startedUs - cursor > MAX_CURSOR_AGE_US) {
    log(`カーソルが古すぎるので（${new Date(cursor / 1000).toISOString()}）、直近の投稿を取り直します`);
    if (options.feedAgent) result.backfilled = await backfill(deps, options.feedAgent, dids, cursor, log, result);
    cursor = undefined;
  }

  const params = new URLSearchParams();
  params.append("wantedCollections", POST_COLLECTION);
  params.append("wantedCollections", ARTWORK_COLLECTION);
  for (const did of dids.slice(0, MAX_WANTED_DIDS)) params.append("wantedDids", did);
  if (cursor !== undefined) params.set("cursor", String(cursor - REWIND_US));

  let last = cursor;
  let opened = false;
  /** 今までの分を受け取り終えたか（何も届かなくなった、または接続した時刻に追いついた）。 */
  let caughtUp = false;
  /** 処理に失敗した最初のイベントの時刻。カーソルはこれより先に進めない。 */
  let failedAt: number | undefined;
  let firstMessageMs: number | undefined;
  let ending = "";
  await new Promise<void>((resolve) => {
    let ws: WebSocket;
    try {
      ws = createSocket(`${options.url ?? DEFAULT_URL}?${params}`);
    } catch (err) {
      log(`接続できませんでした: ${(err as Error).message}`);
      result.outcome = "failed";
      resolve();
      return;
    }
    let idle: ReturnType<typeof setTimeout> | undefined;
    let done = false;
    /** イベントは届いた順に 1 件ずつ処理する（DB への書き込みが非同期なので、順番を保つ）。 */
    let queue: Promise<void> = Promise.resolve();
    const finish = () => {
      if (done) return;
      done = true;
      clearTimeout(idle);
      clearTimeout(limit);
      try {
        ws.close();
      } catch {
        // すでに閉じている
      }
      void queue.then(resolve); // 処理中のイベントを終えてから返す
    };
    const limit = setTimeout(() => {
      ending = "上限時間";
      finish();
    }, maxMs);
    const resetIdle = () => {
      clearTimeout(idle);
      idle = setTimeout(
        () => {
          caughtUp = true;
          ending = "受信なし";
          finish();
        },
        firstMessageMs === undefined ? firstIdleMs : idleMs,
      );
    };

    ws.addEventListener("open", () => {
      opened = true;
      resetIdle();
    });
    ws.addEventListener("message", (message) => {
      if (done) return;
      firstMessageMs ??= now() - startedUs / 1000;
      resetIdle();
      let event: JetstreamEvent;
      try {
        event = JSON.parse(String(message.data)) as JetstreamEvent;
      } catch {
        return;
      }
      if (typeof event.time_us !== "number") return;
      if (event.time_us >= startedUs) {
        caughtUp = true; // 接続した時刻まで追いついた。このイベントまで処理して終える
        ending = "追いついた";
        clearTimeout(idle);
      }
      queue = queue.then(async () => {
        try {
          const handled = await handleEvent(deps, event);
          result.events++;
          if (handled === "job") result.jobs++;
          if (handled !== "ignored") log(`${event.did} ${event.commit?.collection}/${event.commit?.rkey}: ${handled}`);
          last = event.time_us;
        } catch (err) {
          failedAt ??= event.time_us;
          log(`イベントを処理できませんでした: ${(err as Error).message}`);
        }
      });
      if (caughtUp) finish();
    });
    ws.addEventListener("close", () => {
      if (!opened && !done) {
        log("接続できませんでした");
        result.outcome = "failed";
      }
      ending ||= "切断された";
      finish();
    });
    ws.addEventListener("error", () => {
      // close も続けて届くので、そちらで終える。
    });
  });

  // 追いついたなら、イベントがなくてもカーソルを進める（直近 3 分は次回も読み直す）。後ろには戻さない。
  let next = last;
  if (caughtUp) next = Math.max(cursor ?? 0, startedUs - REREAD_US);
  if (failedAt !== undefined && next !== undefined) next = Math.min(next, failedAt - 1);
  if (next !== undefined && next !== cursor) await options.saveCursor(next);
  log(
    `取り込み：${result.outcome}、${ending || "-"}、イベント ${result.events} 件、ジョブ ${result.jobs} 件、` +
      `最初の受信まで ${firstMessageMs ?? "-"}ms、${now() - startedUs / 1000}ms`,
  );
  return result;
}

/** 各人の直近の投稿を、Jetstream のイベントと同じ形にして handleEvent に渡す。取り直せた人数を返す。 */
async function backfill(
  deps: ConsumerDeps,
  agent: FeedAgent,
  dids: string[],
  sinceUs: number,
  log: (m: string) => void,
  result: PullResult,
): Promise<number> {
  let count = 0;
  for (const did of dids) {
    try {
      const { data } = await agent.getAuthorFeed({ actor: did, limit: BACKFILL_POSTS, filter: "posts_no_replies" });
      const posts = data.feed
        .filter((item) => !item.reason && item.post.author.did === did)
        .map((item) => {
          const createdAt = Date.parse((item.post.record as { createdAt?: string }).createdAt ?? "");
          const rkey = item.post.uri.slice(item.post.uri.lastIndexOf("/") + 1);
          return { createdAt, rkey, cid: item.post.cid, record: item.post.record };
        })
        .filter((p) => Number.isFinite(p.createdAt) && p.createdAt * 1000 > sinceUs)
        .sort((a, b) => a.createdAt - b.createdAt);
      for (const p of posts) {
        const handled = await handleEvent(deps, {
          did,
          time_us: p.createdAt * 1000,
          kind: "commit",
          commit: { operation: "create", collection: POST_COLLECTION, rkey: p.rkey, cid: p.cid, record: p.record },
        });
        if (handled === "job") result.jobs++;
      }
      count++;
    } catch (err) {
      log(`${did} の投稿を取り直せませんでした: ${(err as Error).message}`);
    }
  }
  return count;
}
