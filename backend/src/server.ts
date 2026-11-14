/**
 * バックエンドの起動。API、ジョブワーカー、Bluesky の投稿の監視を同じプロセスで動かす。
 *   pnpm dev     （.env を読み、変更で再起動）
 *   pnpm start   （本番。frontend をビルドしてあれば、その画面も同じサーバーから配る）
 */
import { randomBytes } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Agent, AtpAgent } from "@atproto/api";
import { TID } from "@atproto/common-web";
import { serve } from "@hono/node-server";
import { serveStatic } from "@hono/node-server/serve-static";
import { createApp } from "./api/app.ts";
import { createOAuthClient } from "./auth/oauth.ts";
import { loadClaudeConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { createGalleryIndex } from "./gallery/index.ts";
import { syncArtworksFromPds } from "./gallery/sync.ts";
import { generateArtwork } from "./generation/claude.ts";
import { startConsumer } from "./jetstream/consumer.ts";
import { createJobRepository } from "./jobs/repository.ts";
import { SessionExpiredError, startWorker } from "./jobs/worker.ts";
import { createUserRepository } from "./users.ts";
import { createChromiumValidator } from "./validation/chromium.ts";

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const PUBLIC_URL = env.PUBLIC_URL || undefined;
const DATA_DIR = path.dirname(env.DB_PATH ?? "data/art-sky.sqlite");
const DB_PATH = env.DB_PATH ?? "data/art-sky.sqlite";
const TZ_NAME = env.TZ_NAME ?? "Asia/Tokyo";
const JETSTREAM_URL = env.JETSTREAM_URL || undefined;
/** off にすると、生成したコードを Chromium で確かめずに保存する（Chromium を入れられない環境用）。 */
const VALIDATE = env.VALIDATE !== "off";
const FRONTEND_DIST = path.resolve(
  env.FRONTEND_DIST ?? path.join(path.dirname(fileURLToPath(import.meta.url)), "../../frontend/dist"),
);
/** 本番（pnpm start）では、ビルドした画面もこのサーバーから配る。開発では frontend の開発サーバーを使う。 */
const serveFrontend = env.NODE_ENV === "production" && existsSync(path.join(FRONTEND_DIST, "index.html"));
/**
 * ログイン後に戻す先。
 * - 本番（PUBLIC_URL あり）：同じサーバーが画面も配るので PUBLIC_URL
 * - 開発：frontend の開発サーバー。ビルド済みの画面があるならこのサーバー自身
 */
const FRONTEND_URL =
  env.FRONTEND_URL ?? PUBLIC_URL ?? (serveFrontend ? `http://127.0.0.1:${PORT}` : "http://127.0.0.1:5173");

/**
 * Cookie の署名に使う秘密鍵。
 * - 本番（PUBLIC_URL あり）：COOKIE_SECRET の設定が必須
 * - 開発：未設定なら最初の起動時に作って data/ に保存し、以後はそれを使う（設定の手間をなくす）
 */
function loadCookieSecret(): string {
  const configured = env.COOKIE_SECRET ?? "";
  if (configured.length >= 16 && configured !== "change-me-to-a-long-random-string") return configured;
  if (PUBLIC_URL) {
    console.error("COOKIE_SECRET を 16 文字以上のランダムな文字列にしてください（backend/.env）");
    process.exit(1);
  }
  const file = path.join(DATA_DIR, "cookie-secret");
  if (existsSync(file)) return readFileSync(file, "utf8").trim();
  mkdirSync(DATA_DIR, { recursive: true });
  const secret = randomBytes(32).toString("hex");
  writeFileSync(file, `${secret}\n`, { mode: 0o600 });
  return secret;
}
const COOKIE_SECRET = loadCookieSecret();

if (DB_PATH !== ":memory:") mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = openDatabase(DB_PATH);
const users = createUserRepository(db);
const jobs = createJobRepository(db);
const gallery = createGalleryIndex(db);
const oauth = createOAuthClient({ db, publicUrl: PUBLIC_URL, port: PORT });
const publicAgent = new AtpAgent({ service: "https://public.api.bsky.app" });

async function getUserAgent(did: string): Promise<Agent> {
  try {
    return new Agent(await oauth.restore(did));
  } catch (err) {
    throw new SessionExpiredError(`セッションを復元できません: ${(err as Error).message}`);
  }
}

const kvGet = db.prepare("SELECT value FROM kv WHERE key = ?");
const kvSet = db.prepare("INSERT INTO kv (key, value) VALUES (?, ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value");

const consumer = startConsumer(
  { users, jobs, gallery },
  {
    ...(JETSTREAM_URL ? { url: JETSTREAM_URL } : {}),
    loadCursor() {
      const row = kvGet.get("jetstream_cursor") as { value: string } | undefined;
      return row ? Number(row.value) : undefined;
    },
    saveCursor: (cursor) => void kvSet.run("jetstream_cursor", String(cursor)),
  },
);

const app = createApp({
  users,
  jobs,
  gallery,
  oauth,
  async resolveProfile(did) {
    const { data } = await publicAgent.getProfile({ actor: did });
    return { handle: data.handle, displayName: data.displayName || undefined, avatar: data.avatar };
  },
  newTid: () => TID.nextStr(),
  // ログインのたびに、その人の作品を PDS から読み直して索引をそろえる（索引は PDS から作り直せる）。
  async onLogin(did) {
    const count = await syncArtworksFromPds(await getUserAgent(did), did, gallery);
    if (count > 0) console.log(`[gallery] ${did} の作品 ${count} 件を PDS から読み直しました`);
  },
  onRegistered: () => consumer.refresh(),
  cookieSecret: COOKIE_SECRET,
  secureCookie: PUBLIC_URL?.startsWith("https://") ?? false,
  frontendUrl: FRONTEND_URL,
});

// frontend をビルドしてあれば、その画面も配る（/u/... などの画面のパスは index.html を返す）。
if (serveFrontend) {
  const root = path.relative(process.cwd(), FRONTEND_DIST) || ".";
  app.use("*", serveStatic({ root }));
  app.get("*", serveStatic({ root, path: "index.html" }));
}

const validator = VALIDATE ? createChromiumValidator() : null;

const worker = startWorker({
  jobs,
  publicAgent,
  getUserAgent,
  // API キーがなくてもサーバーは起動できるよう、生成のたびに読む
  generate: (input) => generateArtwork(input, loadClaudeConfig()),
  validate: async (record) => {
    await validator?.validate(record);
  },
  onSaved: (artwork) => void gallery.upsert(artwork),
  timeZone: TZ_NAME,
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: PUBLIC_URL ? "0.0.0.0" : "127.0.0.1" }, () => {
  console.log(`backend: ${PUBLIC_URL ?? `http://127.0.0.1:${PORT}`}`);
  console.log(serveFrontend ? `画面: ${FRONTEND_URL}（${FRONTEND_DIST} を配信）` : `画面: ${FRONTEND_URL}（frontend の開発サーバー）`);
  if (env.NODE_ENV === "production" && !serveFrontend) console.log("（frontend/dist がありません。pnpm build を実行してください）");
  if (!PUBLIC_URL) console.log("（開発モード：localhost ではなく 127.0.0.1 で開いてください）");
  if (!env.ANTHROPIC_API_KEY) console.log("（ANTHROPIC_API_KEY が未設定です。生成ジョブは失敗します）");
  if (!VALIDATE) console.log("（VALIDATE=off：生成したコードを確かめずに保存します）");
});

async function shutdown() {
  consumer.stop();
  await worker.stop();
  await validator?.close();
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
