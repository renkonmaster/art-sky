/**
 * Jetstream（AT Protocol の更新を JSON で流す公開サービス）を購読して、登録済みの人の
 *   - Bluesky への新しい投稿   → 作品を変化させるジョブ（evolution）を作る
 *   - 作品レコードの作成・削除 → ギャラリーの索引を更新する
 * を行う（docs/tech-stack.md「投稿の監視」）。
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
export function handleEvent(deps: ConsumerDeps, event: JetstreamEvent): "job" | "indexed" | "removed" | "ignored" {
  const commit = event.commit;
  if (event.kind !== "commit" || !commit) return "ignored";
  const user = deps.users.get(event.did);
  // 登録していない人のレコードは扱わない（購読の絞り込みをすり抜けた場合の備え）。
  if (!user || user.consentedAt === null) return "ignored";

  if (commit.collection === ARTWORK_COLLECTION) {
    if (commit.operation === "delete") {
      deps.gallery.remove(event.did, commit.rkey);
      return "removed";
    }
    if (!commit.cid) return "ignored";
    return deps.gallery.upsert({ did: event.did, rkey: commit.rkey, cid: commit.cid, record: commit.record }) ? "indexed" : "ignored";
  }

  if (commit.collection === POST_COLLECTION && commit.operation === "create") {
    if (!user.generationEnabled) return "ignored"; // 生成を止めている間の投稿では作らない
    if (!isPlainPost(commit.record)) return "ignored";
    // 登録より前の投稿は対象外（カーソルを巻き戻して再生したときの備え）。
    if (event.time_us / 1000 < Date.parse(user.consentedAt)) return "ignored";
    deps.jobs.enqueueEvolution(event.did, `at://${event.did}/${POST_COLLECTION}/${commit.rkey}`, commit.rkey, commit.cid ?? null);
    return "job";
  }
  return "ignored";
}

export interface ConsumerOptions {
  /** Jetstream のエンドポイント。 */
  url?: string;
  /** カーソル（最後に処理したイベントの時刻）の読み書き。 */
  loadCursor(): number | undefined;
  saveCursor(cursor: number): void;
  /** 接続を作る。テストで差し替えられるようにしている。 */
  createSocket?: (url: string) => WebSocket;
  log?: (message: string) => void;
}

const DEFAULT_URL = "wss://jetstream2.us-east.bsky.network/subscribe";
/** 一度に購読できる DID の上限（Jetstream の仕様）。 */
const MAX_WANTED_DIDS = 10_000;

/**
 * Jetstream への接続を保ち、イベントを handleEvent に渡す。
 *
 * - 購読は登録済みの DID に絞る。登録者が増えたら refresh() で接続し直す。
 * - 切れたら間隔を空けて接続し直し、保存したカーソルの少し前から再開するので、
 *   止まっていた間の投稿も拾える（重複して届いても handleEvent は同じ結果になる）。
 */
export function startConsumer(deps: ConsumerDeps, options: ConsumerOptions): { refresh(): void; stop(): void } {
  const log = options.log ?? ((m: string) => console.log(`[jetstream] ${m}`));
  const createSocket = options.createSocket ?? ((url: string) => new WebSocket(url));
  let socket: WebSocket | null = null;
  let stopped = false;
  let retryTimer: NodeJS.Timeout | undefined;
  let saveTimer: NodeJS.Timeout | undefined;
  let backoffMs = 1000;
  let cursor = options.loadCursor();
  let subscribed = "";

  const flush = () => {
    if (cursor !== undefined) options.saveCursor(cursor);
  };

  function connect() {
    if (stopped) return;
    const dids = deps.users.listRegistered().map((u) => u.did);
    subscribed = dids.join(",");
    if (dids.length === 0) return; // 登録者がいない間はつながない（refresh で始める）
    if (dids.length > MAX_WANTED_DIDS) log(`登録者が ${MAX_WANTED_DIDS} 人を超えています。超えた分の投稿は拾えません`);

    const params = new URLSearchParams();
    params.append("wantedCollections", POST_COLLECTION);
    params.append("wantedCollections", ARTWORK_COLLECTION);
    for (const did of dids.slice(0, MAX_WANTED_DIDS)) params.append("wantedDids", did);
    // 取りこぼしを避けるため、最後に処理した時刻の 5 秒前から再開する。
    if (cursor !== undefined) params.set("cursor", String(cursor - 5_000_000));

    const ws = createSocket(`${options.url ?? DEFAULT_URL}?${params}`);
    socket = ws;
    ws.addEventListener("open", () => {
      backoffMs = 1000;
      log(`接続しました（${dids.length} 人を監視）`);
    });
    ws.addEventListener("message", (message) => {
      try {
        const event = JSON.parse(String(message.data)) as JetstreamEvent;
        if (typeof event.time_us !== "number") return;
        const result = handleEvent(deps, event);
        if (result !== "ignored") log(`${event.did} ${event.commit?.collection}/${event.commit?.rkey}: ${result}`);
        cursor = event.time_us;
      } catch (err) {
        log(`イベントを処理できませんでした: ${(err as Error).message}`);
      }
    });
    ws.addEventListener("close", () => {
      if (socket !== ws) return; // refresh で自分から閉じた
      socket = null;
      if (stopped) return;
      log(`切断されました。${Math.round(backoffMs / 1000)} 秒後に接続し直します`);
      retryTimer = setTimeout(connect, backoffMs);
      backoffMs = Math.min(backoffMs * 2, 60_000);
    });
    ws.addEventListener("error", () => {
      // close も続けて届くので、接続し直しはそちらで行う。
    });
  }

  connect();
  saveTimer = setInterval(flush, 5000);

  return {
    /** 登録者が変わったときに呼ぶ。監視する人が変わっていれば接続し直す。 */
    refresh() {
      if (stopped) return;
      const next = deps.users.listRegistered().map((u) => u.did).join(",");
      if (next === subscribed && socket) return;
      clearTimeout(retryTimer);
      const old = socket;
      socket = null;
      old?.close();
      connect();
    },
    stop() {
      stopped = true;
      clearTimeout(retryTimer);
      clearInterval(saveTimer);
      flush();
      const old = socket;
      socket = null;
      old?.close();
    },
  };
}
