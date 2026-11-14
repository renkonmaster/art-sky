/**
 * 認証と、登録・投稿・ジョブ・設定の API（docs/roles.md「API」）。
 * ギャラリーの XRPC は索引と一緒に別途作る。
 */
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import { Hono, type Context } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import { SCOPE } from "../auth/oauth.ts";
import type { Job, JobRepository } from "../jobs/repository.ts";
import type { User, UserRepository } from "../users.ts";

const COOKIE = "artsky_sid";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 日
/** Bluesky の投稿の上限（書記素数） */
const MAX_POST_GRAPHEMES = 300;

export interface AppDeps {
  users: UserRepository;
  jobs: JobRepository;
  oauth: Pick<NodeOAuthClient, "authorize" | "callback" | "revoke" | "clientMetadata" | "jwks">;
  /** ログイン直後にハンドル名を調べる */
  resolveHandle(did: string): Promise<string>;
  /** 本人として Bluesky に投稿する。セッションが切れていたら SessionExpiredError */
  createPost(did: string, text: string): Promise<{ uri: string; cid: string }>;
  /** 作品のレコードキーにする TID を発行する */
  newTid(): string;
  cookieSecret: string;
  secureCookie: boolean;
  /** ログイン後に戻す先（フロントエンド） */
  frontendUrl: string;
}

export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
}

type Env = { Variables: { did: string } };

const graphemes = (s: string) => [...new Intl.Segmenter("ja", { granularity: "grapheme" }).segment(s)].length;

/** at://did/collection/rkey の rkey */
const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

const jobJson = (j: Job) => ({
  id: j.id,
  kind: j.kind,
  status: j.status,
  attempts: j.attempts,
  error: j.error,
  triggerUri: j.triggerUri,
  artworkUri: j.artworkUri,
  createdAt: j.createdAt,
  updatedAt: j.updatedAt,
});

const meJson = (u: User) => ({
  did: u.did,
  handle: u.handle,
  registered: u.consentedAt !== null,
  settings: { generationEnabled: u.generationEnabled, listed: u.listed },
});

async function readJson(c: Context): Promise<Record<string, unknown>> {
  try {
    const body: unknown = await c.req.json();
    return typeof body === "object" && body !== null ? (body as Record<string, unknown>) : {};
  } catch {
    return {};
  }
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();

  // ------------------------------------------------------------ OAuth

  app.get("/client-metadata.json", (c) => c.json(deps.oauth.clientMetadata));
  app.get("/jwks.json", (c) => c.json(deps.oauth.jwks));

  app.get("/oauth/login", async (c) => {
    const handle = (c.req.query("handle") ?? "").trim().replace(/^@/, "");
    if (!handle) return c.json({ error: "handle を指定してください" }, 400);
    try {
      const url = await deps.oauth.authorize(handle, { scope: SCOPE });
      return c.redirect(url.toString());
    } catch (err) {
      return c.json({ error: `ログインを始められませんでした: ${(err as Error).message}` }, 400);
    }
  });

  app.get("/oauth/callback", async (c) => {
    try {
      const { session } = await deps.oauth.callback(new URL(c.req.url).searchParams);
      deps.users.touch(session.did, await deps.resolveHandle(session.did));
      await setSignedCookie(c, COOKIE, session.did, deps.cookieSecret, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: MAX_AGE,
        secure: deps.secureCookie,
      });
      return c.redirect(deps.frontendUrl);
    } catch (err) {
      return c.json({ error: `認証に失敗しました: ${(err as Error).message}` }, 400);
    }
  });

  app.post("/oauth/logout", async (c) => {
    const did = await getSignedCookie(c, deps.cookieSecret, COOKIE);
    if (did) {
      await deps.oauth.revoke(did).catch(() => {}); // 失効済みなら無視
    }
    deleteCookie(c, COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ ログインが必要な API

  const api = new Hono<Env>();

  api.use(async (c, next) => {
    const did = await getSignedCookie(c, deps.cookieSecret, COOKIE);
    if (!did || !deps.users.get(did)) return c.json({ error: "ログインしてください" }, 401);
    c.set("did", did);
    await next();
  });

  api.get("/me", (c) => c.json(meJson(deps.users.get(c.get("did"))!)));

  api.post("/register", async (c) => {
    const body = await readJson(c);
    if (body.consent !== true) {
      return c.json({ error: "投稿を外部 AI に送ることと、推定結果が公開されることへの同意が必要です" }, 400);
    }
    const did = c.get("did");
    deps.users.consent(did);
    const job = deps.jobs.enqueueGenesis(did, deps.newTid());
    return c.json({ job: jobJson(job) }, 202);
  });

  api.post("/posts", async (c) => {
    const did = c.get("did");
    const user = deps.users.get(did)!;
    if (user.consentedAt === null) return c.json({ error: "先に初回登録をしてください" }, 409);

    const { text } = await readJson(c);
    if (typeof text !== "string" || text.trim() === "") return c.json({ error: "text を指定してください" }, 400);
    if (graphemes(text) > MAX_POST_GRAPHEMES) return c.json({ error: `投稿は ${MAX_POST_GRAPHEMES} 文字までです` }, 400);

    let post: { uri: string; cid: string };
    try {
      post = await deps.createPost(did, text);
    } catch (err) {
      if (err instanceof SessionExpiredError) return c.json({ error: "ログインの有効期限が切れました。もう一度ログインしてください" }, 401);
      throw err;
    }

    // 投稿と生成は別の処理。ここから先で失敗しても投稿は残る（Plan.md 5.3）
    const job = user.generationEnabled ? deps.jobs.enqueueEvolution(did, post.uri, rkeyOf(post.uri)) : null;
    return c.json({ post, job: job ? jobJson(job) : null }, 201);
  });

  api.get("/jobs", (c) => c.json({ jobs: deps.jobs.listByDid(c.get("did")).map(jobJson) }));

  const ownJob = (c: Context<Env>): Job | undefined => {
    const job = deps.jobs.get(Number(c.req.param("id")));
    return job && job.did === c.get("did") ? job : undefined;
  };

  api.get("/jobs/:id", (c) => {
    const job = ownJob(c);
    return job ? c.json({ job: jobJson(job) }) : c.json({ error: "ジョブが見つかりません" }, 404);
  });

  api.post("/jobs/:id/retry", (c) => {
    const job = ownJob(c);
    if (!job) return c.json({ error: "ジョブが見つかりません" }, 404);
    if (!deps.jobs.retry(job.id)) return c.json({ error: "失敗したジョブだけ再試行できます" }, 409);
    return c.json({ job: jobJson(deps.jobs.get(job.id)!) }, 202);
  });

  api.get("/settings", (c) => c.json(meJson(deps.users.get(c.get("did"))!).settings));

  api.put("/settings", async (c) => {
    const body = await readJson(c);
    const current = deps.users.get(c.get("did"))!;
    const next = {
      generationEnabled: typeof body.generationEnabled === "boolean" ? body.generationEnabled : current.generationEnabled,
      listed: typeof body.listed === "boolean" ? body.listed : current.listed,
    };
    return c.json(meJson(deps.users.updateSettings(c.get("did"), next)).settings);
  });

  app.route("/api", api);

  app.onError((err, c) => {
    console.error(err);
    return c.json({ error: "サーバーでエラーが発生しました" }, 500);
  });

  return app;
}
