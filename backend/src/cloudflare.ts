/**
 * Cloudflare Workers の入口（wrangler.toml の main）。Node.js の server.ts と同じ部品を使う。
 *   - fetch     ：API、XRPC、OAuth。画面（frontend/dist）は Static Assets が直接配る
 *   - scheduled ：1 分ごとの Cron。投稿の取り込みとジョブの処理（cron.ts）
 *
 * Node.js 版との違い
 *   - DB は D1（db/d1.ts）
 *   - 生成した作品の Chromium での検証はしない（描画モジュールは全員共通の固定コードで、テストで確かめている）
 *   - 登録・再試行の直後のジョブは、応答を返したあと waitUntil で 1 件だけ処理する
 */
/**
 * Workers は Request の redirect: "error" に対応していない（作る時点で例外になる）。
 * AT Protocol のライブラリは ID の解決などで "error" を使うので、"manual" に読み替える。
 * "manual" ではリダイレクトをたどらず 3xx がそのまま返り、ライブラリ側で「成功ではない」として失敗になる。
 */
const NativeRequest = globalThis.Request;
globalThis.Request = class extends NativeRequest {
  constructor(input: RequestInfo | URL, init?: RequestInit) {
    super(input, init?.redirect === "error" ? { ...init, redirect: "manual" } : init);
  }
} as typeof Request;

import { Agent, AtpAgent } from "@atproto/api";
import { TID } from "@atproto/common-web";
import { createApp } from "./api/app.ts";
import { createOAuthClient } from "./auth/oauth.ts";
import { runCron } from "./cron.ts";
import { type D1Like, d1Sql } from "./db/d1.ts";
import { cursorStore } from "./db/sql.ts";
import { createGalleryIndex } from "./gallery/index.ts";
import { syncArtworksFromPds } from "./gallery/sync.ts";
import { generateWithoutAi } from "./generation/rules.ts";
import { createJobRepository } from "./jobs/repository.ts";
import type { RunnerDeps } from "./jobs/runner.ts";
import { runQueuedJobs, SessionExpiredError } from "./jobs/worker.ts";
import { createUserRepository } from "./users.ts";

export interface Env {
  DB: D1Like;
  /**
   * 公開する URL（https://...）。OAuth のクライアント ID と、ログイン後に戻す先に使う。
   * 空ならローカルの開発用（wrangler dev、http://127.0.0.1:8787 のループバッククライアント）。
   */
  PUBLIC_URL?: string;
  /** Cookie の署名に使う秘密鍵（wrangler secret put COOKIE_SECRET）。 */
  COOKIE_SECRET: string;
  TZ_NAME?: string;
  JETSTREAM_URL?: string;
}

/** wrangler dev のポート（PUBLIC_URL が空のとき、OAuth の戻り先に使う）。 */
const DEV_PORT = 8787;

/** Workers の ExecutionContext のうち使う部分。 */
interface Ctx {
  waitUntil(promise: Promise<unknown>): void;
}

/**
 * Workers の外向き WebSocket（fetch で Upgrade する）を、ブラウザの WebSocket と同じ形にする。
 * pullOnce は open / message / close を受け取れればよい。
 */
function workersSocket(url: string): WebSocket {
  const target = new EventTarget() as EventTarget & { close(): void };
  let socket: { accept(): void; close(): void; addEventListener: EventTarget["addEventListener"] } | null = null;
  let closed = false;
  target.close = () => {
    closed = true;
    try {
      socket?.close();
    } catch {
      // すでに閉じている
    }
    target.dispatchEvent(new Event("close"));
  };
  fetch(url.replace(/^ws/, "http"), { headers: { Upgrade: "websocket" } })
    .then((res) => {
      const ws = (res as Response & { webSocket?: typeof socket }).webSocket;
      if (!ws) throw new Error(`WebSocket に切り替えられませんでした（${res.status}）`);
      if (closed) return ws.close();
      socket = ws;
      ws.accept();
      ws.addEventListener("message", (e) => target.dispatchEvent(new MessageEvent("message", { data: (e as MessageEvent).data })));
      ws.addEventListener("close", () => {
        if (!closed) target.close();
      });
      target.dispatchEvent(new Event("open"));
    })
    .catch((err) => {
      console.error("[jetstream]", err);
      if (!closed) target.close();
    });
  return target as unknown as WebSocket;
}

function services(env: Env) {
  const db = d1Sql(env.DB);
  const users = createUserRepository(db);
  const jobs = createJobRepository(db);
  const gallery = createGalleryIndex(db);
  const oauth = createOAuthClient({ db, publicUrl: env.PUBLIC_URL || undefined, port: DEV_PORT });
  const publicAgent = new AtpAgent({ service: "https://public.api.bsky.app" });

  async function getUserAgent(did: string): Promise<Agent> {
    try {
      return new Agent(await oauth.restore(did));
    } catch (err) {
      throw new SessionExpiredError(`セッションを復元できません: ${(err as Error).message}`);
    }
  }

  const runner: RunnerDeps = {
    jobs,
    publicAgent,
    getUserAgent,
    generate: async (input) => generateWithoutAi(input),
    validate: async () => {},
    onSaved: (artwork) => gallery.upsert(artwork),
    timeZone: env.TZ_NAME ?? "Asia/Tokyo",
  };
  return { db, users, jobs, gallery, oauth, publicAgent, getUserAgent, runner };
}

export default {
  async fetch(request: Request, env: Env, ctx: Ctx): Promise<Response> {
    const s = services(env);
    const app = createApp({
      users: s.users,
      jobs: s.jobs,
      gallery: s.gallery,
      oauth: s.oauth,
      async resolveProfile(did) {
        const { data } = await s.publicAgent.getProfile({ actor: did });
        return { handle: data.handle, displayName: data.displayName || undefined, avatar: data.avatar };
      },
      newTid: () => TID.nextStr(),
      async onLogin(did) {
        await syncArtworksFromPds(await s.getUserAgent(did), did, s.gallery);
      },
      // 応答を返したあとに 1 件だけ処理する（残りは Cron が処理する）
      onJobQueued: () => ctx.waitUntil(runQueuedJobs(s.runner, { maxJobs: 1 })),
      cookieSecret: env.COOKIE_SECRET,
      secureCookie: env.PUBLIC_URL?.startsWith("https://") ?? false,
      frontendUrl: env.PUBLIC_URL || `http://127.0.0.1:${DEV_PORT}`,
    });
    return app.fetch(request);
  },

  async scheduled(_event: unknown, env: Env, ctx: Ctx): Promise<void> {
    const s = services(env);
    ctx.waitUntil(
      runCron({
        consumer: { users: s.users, jobs: s.jobs, gallery: s.gallery },
        pull: {
          ...(env.JETSTREAM_URL ? { url: env.JETSTREAM_URL } : {}),
          ...cursorStore(s.db),
          createSocket: workersSocket,
          feedAgent: s.publicAgent,
        },
        runner: s.runner,
        jobs: { maxJobs: 5, budgetMs: 15_000 },
      }),
    );
  },
};
