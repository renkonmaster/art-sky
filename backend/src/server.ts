/**
 * バックエンドの起動。API とジョブワーカーを同じプロセスで動かす。
 *   pnpm dev   （.env を読み、変更で再起動）
 */
import { mkdirSync } from "node:fs";
import path from "node:path";
import { serve } from "@hono/node-server";
import { Agent, AtpAgent, RichText } from "@atproto/api";
import { TID } from "@atproto/common-web";
import { createApp, SessionExpiredError } from "./api/app.ts";
import { createOAuthClient } from "./auth/oauth.ts";
import { fetchProfileStats } from "./bluesky/posts.ts";
import { loadClaudeConfig } from "./config.ts";
import { openDatabase } from "./db/database.ts";
import { generateArtwork } from "./generation/claude.ts";
import { createJobRepository } from "./jobs/repository.ts";
import { startWorker } from "./jobs/worker.ts";
import { createUserRepository } from "./users.ts";

const env = process.env;
const PORT = Number(env.PORT) || 3000;
const PUBLIC_URL = env.PUBLIC_URL || undefined;
const COOKIE_SECRET = env.COOKIE_SECRET ?? "";
const DB_PATH = env.DB_PATH ?? "data/art-sky.sqlite";
const FRONTEND_URL = env.FRONTEND_URL ?? "http://127.0.0.1:5173";
const TZ_NAME = env.TZ_NAME ?? "Asia/Tokyo";

if (COOKIE_SECRET.length < 16 || COOKIE_SECRET === "change-me-to-a-long-random-string") {
  console.error("COOKIE_SECRET を 16 文字以上のランダムな文字列にしてください（backend/.env）");
  process.exit(1);
}

if (DB_PATH !== ":memory:") mkdirSync(path.dirname(DB_PATH), { recursive: true });
const db = openDatabase(DB_PATH);
const users = createUserRepository(db);
const jobs = createJobRepository(db);
const oauth = createOAuthClient({ db, publicUrl: PUBLIC_URL, port: PORT });
const publicAgent = new AtpAgent({ service: "https://public.api.bsky.app" });

async function getUserAgent(did: string): Promise<Agent> {
  try {
    return new Agent(await oauth.restore(did));
  } catch (err) {
    throw new SessionExpiredError(`セッションを復元できません: ${(err as Error).message}`);
  }
}

const app = createApp({
  users,
  jobs,
  oauth,
  async resolveHandle(did) {
    return (await fetchProfileStats(publicAgent, did)).handle;
  },
  async createPost(did, text) {
    const agent = await getUserAgent(did);
    const rt = new RichText({ text });
    await rt.detectFacets(agent); // リンクとメンションを有効にする
    return agent.post({ text: rt.text, facets: rt.facets, createdAt: new Date().toISOString() });
  },
  newTid: () => TID.nextStr(),
  cookieSecret: COOKIE_SECRET,
  secureCookie: PUBLIC_URL?.startsWith("https://") ?? false,
  frontendUrl: FRONTEND_URL,
});

const worker = startWorker({
  jobs,
  publicAgent,
  getUserAgent,
  // API キーがなくてもサーバーは起動できるよう、生成のたびに読む
  generate: (input) => generateArtwork(input, loadClaudeConfig()),
  validate: async () => {},
  timeZone: TZ_NAME,
});

const server = serve({ fetch: app.fetch, port: PORT, hostname: PUBLIC_URL ? "0.0.0.0" : "127.0.0.1" }, () => {
  console.log(`backend: ${PUBLIC_URL ?? `http://127.0.0.1:${PORT}`}`);
  if (!PUBLIC_URL) console.log("（開発モード：localhost ではなく 127.0.0.1 で開いてください）");
  if (!env.ANTHROPIC_API_KEY) console.log("（ANTHROPIC_API_KEY が未設定です。生成ジョブは失敗します）");
});

async function shutdown() {
  await worker.stop();
  server.close();
  db.close();
  process.exit(0);
}
process.on("SIGINT", shutdown);
process.on("SIGTERM", shutdown);
