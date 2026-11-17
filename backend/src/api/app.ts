/**
 * バックエンドの HTTP API（docs/api.md）。
 *
 * - 認証（画面遷移）：/oauth/login、/oauth/callback、/oauth/logout
 * - 内部 API（セッション Cookie）：/api/me、/api/register、/api/jobs、/api/settings
 * - ギャラリー API（ログイン不要、XRPC）：/xrpc/com.example.artsky.gallery.*
 *
 * リクエストとレスポンスの形は @art-sky/api のスキーマで決まっていて、フロントエンドも同じものを使う。
 * このサイトに投稿機能はない。作品が変化するきっかけは、Bluesky 上の投稿の監視（jetstream/consumer.ts）。
 */
import {
  type ErrorCode,
  ERRORS,
  GALLERY_NSID,
  GetArtworkParams,
  type Job as ApiJob,
  ListByActorParams,
  ListJobsQuery,
  ListLatestParams,
  LoginQuery,
  type Me,
  RegisterRequest,
  UpdateSettingsRequest,
} from "@art-sky/api";
import type { NodeOAuthClient } from "@atproto/oauth-client-node";
import { type Context, Hono } from "hono";
import { deleteCookie, getSignedCookie, setSignedCookie } from "hono/cookie";
import type { z } from "zod";
import { SCOPE } from "../auth/oauth.ts";
import { artworkView, authorView, type GalleryIndex } from "../gallery/index.ts";
import type { Job, JobRepository } from "../jobs/repository.ts";
import type { ProfileInfo, User, UserRepository } from "../users.ts";

const COOKIE = "artsky_sid";
const MAX_AGE = 60 * 60 * 24 * 30; // 30 日

export interface AppDeps {
  users: UserRepository;
  jobs: JobRepository;
  gallery: GalleryIndex;
  oauth: Pick<NodeOAuthClient, "authorize" | "callback" | "revoke" | "clientMetadata" | "jwks">;
  /** ログイン直後に、公開プロフィールからハンドル名などを調べる。 */
  resolveProfile(did: string): Promise<ProfileInfo>;
  /** 作品のレコードキーにする TID を発行する。 */
  newTid(): string;
  /** ログインした直後に呼ぶ。その人の作品を PDS から読み直して索引に入れる、などに使う。失敗しても無視する。 */
  onLogin?(did: string): Promise<void>;
  /** 登録者が増えたときに呼ぶ。投稿の監視の対象に加える。 */
  onRegistered?(did: string): void;
  cookieSecret: string;
  secureCookie: boolean;
  /** ログイン後に戻す先（フロントエンドのオリジン）。 */
  frontendUrl: string;
}

type Env = { Variables: { user: User } };

/** docs/api.md のエラー。XRPC と同じ { error, message } の形で返す。 */
class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("InvalidRequest", result.error.issues[0]?.message ?? "リクエストの形式が正しくありません");
  return result.data;
}

async function readJson(c: Context): Promise<unknown> {
  try {
    return await c.req.json();
  } catch {
    return undefined;
  }
}

/** どの失敗なら再試行に意味があるか。 */
const RETRYABLE = true;

export function jobJson(j: Job): ApiJob {
  return {
    id: String(j.id),
    kind: j.kind,
    status: j.status,
    ...(j.triggerUri && j.triggerCid ? { trigger: { uri: j.triggerUri, cid: j.triggerCid } } : {}),
    ...(j.artworkUri && j.artworkCid ? { artwork: { uri: j.artworkUri, cid: j.artworkCid } } : {}),
    ...(j.status === "failed"
      ? { error: { code: j.errorCode ?? "internal", message: j.error ?? "原因不明のエラー", retryable: RETRYABLE } }
      : {}),
    attempts: j.attempts,
    createdAt: j.createdAt,
    updatedAt: j.updatedAt,
  };
}

export function meJson(u: User): Me {
  const registered = u.consentedAt !== null;
  return {
    did: u.did,
    handle: u.handle,
    ...(u.displayName ? { displayName: u.displayName } : {}),
    ...(u.avatar ? { avatar: u.avatar } : {}),
    registered,
    ...(u.consentedAt ? { registeredAt: u.consentedAt } : {}),
    settings: registered ? { generationEnabled: u.generationEnabled, listed: u.listed } : null,
  };
}

function paginate<T>(fetchPage: (limit: number, offset: number) => T[], limit: number, cursor: string | undefined): { page: T[]; cursor?: string } {
  const offset = cursor && /^\d+$/.test(cursor) ? Number(cursor) : 0;
  // 1 件多く取って、続きがあるかを調べる。
  const rows = fetchPage(limit + 1, offset);
  return rows.length > limit ? { page: rows.slice(0, limit), cursor: String(offset + limit) } : { page: rows };
}

export function createApp(deps: AppDeps) {
  const app = new Hono<Env>();
  const frontend = deps.frontendUrl.replace(/\/$/, "");

  const sessionUser = async (c: Context): Promise<User | undefined> => {
    const did = await getSignedCookie(c, deps.cookieSecret, COOKIE);
    return did ? deps.users.get(did) : undefined;
  };

  // ------------------------------------------------------------ OAuth（画面遷移）

  app.get("/client-metadata.json", (c) => c.json(deps.oauth.clientMetadata));
  app.get("/jwks.json", (c) => c.json(deps.oauth.jwks));

  app.get("/oauth/login", async (c) => {
    const query = LoginQuery.safeParse(c.req.query());
    if (!query.success) return c.redirect(`${frontend}/login?error=invalid_handle`);
    const handle = query.data.handle.trim().replace(/^@/, "");
    try {
      // 戻り先は OAuth の state に入れて持ち回る（認可サーバーを経由しても失われない）。
      const url = await deps.oauth.authorize(handle, { scope: SCOPE, state: query.data.returnTo });
      return c.redirect(url.toString());
    } catch (err) {
      console.error("[oauth] authorize:", err);
      return c.redirect(`${frontend}/login?error=invalid_handle`);
    }
  });

  app.get("/oauth/callback", async (c) => {
    const params = new URL(c.req.url).searchParams;
    try {
      const { session, state } = await deps.oauth.callback(params);
      deps.users.touch(session.did, await deps.resolveProfile(session.did));
      await setSignedCookie(c, COOKIE, session.did, deps.cookieSecret, {
        httpOnly: true,
        sameSite: "Lax",
        path: "/",
        maxAge: MAX_AGE,
        secure: deps.secureCookie,
      });
      await deps.onLogin?.(session.did).catch((err) => console.error("[oauth] onLogin:", err));
      // サイト内のパスだけを戻り先として受け付ける（外部サイトへ飛ばされないようにする）。
      const returnTo = state && /^\/(?!\/)/.test(state) ? state : "/";
      return c.redirect(`${frontend}${returnTo}`);
    } catch (err) {
      console.error("[oauth] callback:", err);
      const denied = params.get("error") === "access_denied";
      return c.redirect(`${frontend}/login?error=${denied ? "access_denied" : "failed"}`);
    }
  });

  app.post("/oauth/logout", async (c) => {
    const did = await getSignedCookie(c, deps.cookieSecret, COOKIE);
    if (did) await deps.oauth.revoke(did).catch(() => {}); // 失効済みなら無視
    deleteCookie(c, COOKIE, { path: "/" });
    return c.body(null, 204);
  });

  // ------------------------------------------------------------ 内部 API

  // ログインしていなくても 401 にはしない（フロントエンドが起動時に呼ぶため）。
  app.get("/api/me", async (c) => {
    const user = await sessionUser(c);
    return c.json({ user: user ? meJson(user) : null });
  });

  const api = new Hono<Env>();

  api.use(async (c, next) => {
    const user = await sessionUser(c);
    if (!user) throw new ApiError("AuthRequired", "ログインが必要です");
    c.set("user", user);
    await next();
  });

  const requireRegistered = (c: Context<Env>): User => {
    const user = c.get("user");
    if (user.consentedAt === null) throw new ApiError("NotRegistered", "初回登録がまだです");
    return user;
  };

  api.post("/register", async (c) => {
    const user = c.get("user");
    // 推定結果が作品と一緒に公開されることへの同意が必須。
    parse(RegisterRequest, await readJson(c));
    if (user.consentedAt !== null) throw new ApiError("AlreadyRegistered", "初回登録は済んでいます");
    const registered = deps.users.consent(user.did);
    const job = deps.jobs.enqueueGenesis(user.did, deps.newTid());
    deps.onRegistered?.(user.did);
    return c.json({ me: meJson(registered), job: jobJson(job) }, 202);
  });

  api.get("/jobs", (c) => {
    const user = requireRegistered(c);
    const query = parse(ListJobsQuery, c.req.query());
    const { page, cursor } = paginate(
      (limit, offset) => deps.jobs.listByDid(user.did, limit, offset, query.status),
      query.limit,
      query.cursor,
    );
    return c.json({ jobs: page.map(jobJson), ...(cursor ? { cursor } : {}) });
  });

  const ownJob = (c: Context<Env>): Job => {
    const user = requireRegistered(c);
    const id = c.req.param("id") ?? "";
    const job = /^\d+$/.test(id) ? deps.jobs.get(Number(id)) : undefined;
    if (!job || job.did !== user.did) throw new ApiError("NotFound", "ジョブが見つかりません");
    return job;
  };

  api.get("/jobs/:id", (c) => c.json({ job: jobJson(ownJob(c)) }));

  api.post("/jobs/:id/retry", (c) => {
    const job = ownJob(c);
    if (!deps.jobs.retry(job.id)) throw new ApiError("JobNotRetryable", "失敗したジョブだけ再試行できます");
    return c.json({ job: jobJson(deps.jobs.get(job.id)!) }, 202);
  });

  api.get("/settings", (c) => {
    const user = requireRegistered(c);
    return c.json({ settings: { generationEnabled: user.generationEnabled, listed: user.listed } });
  });

  api.patch("/settings", async (c) => {
    const user = requireRegistered(c);
    const patch = parse(UpdateSettingsRequest, await readJson(c));
    const next = deps.users.updateSettings(user.did, {
      generationEnabled: patch.generationEnabled ?? user.generationEnabled,
      listed: patch.listed ?? user.listed,
    });
    return c.json({ settings: { generationEnabled: next.generationEnabled, listed: next.listed } });
  });

  app.route("/api", api);

  // ------------------------------------------------------------ ギャラリー API（XRPC、ログイン不要）

  /** 掲載中（登録済みで、掲載を止めていない）の参加者。 */
  const listedUser = (actor: string): User | undefined => {
    const user = deps.users.find(actor);
    return user && user.consentedAt !== null && user.listed ? user : undefined;
  };

  app.get(`/xrpc/${GALLERY_NSID.listLatest}`, (c) => {
    const query = parse(ListLatestParams, c.req.query());
    const { page, cursor } = paginate((limit, offset) => deps.gallery.listLatest(limit, offset), query.limit, query.cursor);
    const items = page.flatMap((artwork) => {
      const author = deps.users.get(artwork.did);
      return author ? [artworkView(artwork, author)] : [];
    });
    return c.json({ items, ...(cursor ? { cursor } : {}) });
  });

  app.get(`/xrpc/${GALLERY_NSID.listByActor}`, (c) => {
    const query = parse(ListByActorParams, c.req.query());
    const author = listedUser(query.actor);
    if (!author) throw new ApiError("ActorNotFound", "参加者が見つかりません");
    const { page, cursor } = paginate((limit, offset) => deps.gallery.listByDid(author.did, limit, offset), query.limit, query.cursor);
    return c.json({ author: authorView(author), items: page.map((a) => artworkView(a, author)), ...(cursor ? { cursor } : {}) });
  });

  app.get(`/xrpc/${GALLERY_NSID.getArtwork}`, (c) => {
    const query = parse(GetArtworkParams, c.req.query());
    const artwork = deps.gallery.get(query.uri);
    const author = artwork ? listedUser(artwork.did) : undefined;
    if (!artwork || !author) throw new ApiError("NotFound", "作品が見つかりません");
    const { previous, next } = deps.gallery.neighbors(artwork);
    return c.json({
      artwork: artworkView(artwork, author),
      ...(previous ? { previous: previous.uri } : {}),
      ...(next ? { next: next.uri } : {}),
    });
  });

  // ------------------------------------------------------------ エラー

  app.onError((err, c) => {
    if (err instanceof ApiError) return c.json({ error: err.code, message: err.message }, ERRORS[err.code]);
    console.error(err);
    return c.json({ error: "InternalError", message: "サーバーでエラーが発生しました" }, 500);
  });

  // フロントエンドのファイル配信（server.ts）より先に、API の「見つからない」を JSON で返す。
  for (const prefix of ["/api/*", "/xrpc/*", "/oauth/*"]) {
    app.all(prefix, (c) => c.json({ error: "NotFound", message: `${c.req.method} ${c.req.path} はありません` }, 404));
  }

  return app;
}
