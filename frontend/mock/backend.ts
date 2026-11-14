import {
  type ArtworkRecord,
  type ArtworkView,
  type AuthorView,
  ERRORS,
  type ErrorCode,
  GetArtworkParams,
  type Job,
  type JobStatus,
  ListByActorParams,
  ListJobsQuery,
  ListLatestParams,
  LoginQuery,
  type Me,
  RegisterRequest,
  type Settings,
  UpdateSettingsRequest,
} from "@art-sky/api";
import type { z } from "zod";
import { hash32, isAnimated, SEED_AUTHORS, STYLE_NAMES, type StyleName, styleCode, tidFromTime } from "./data.ts";

/**
 * バックエンドの代わりをするモック。docs/api.md の API をメモリ上で再現する。
 *
 * - 状態はメモリにあるだけなので、開発サーバーを再起動すると最初に戻る。
 * - ログインは、入力したハンドル名でそのままログインできる（認可画面は出ない）。
 * - 生成ジョブは時間の経過で進み、約 7 秒で完了して新しい作品が増える。
 * - このサイトに投稿機能はない。本物のバックエンドは Bluesky 上の投稿を見つけて作品を作る。
 *   モックでは POST /__mock/post { handle, fail? } で「Bluesky に投稿があった」ことにできる。
 *   fail を true にすると、そのジョブは失敗する（再試行すると成功する）。
 */

const COLLECTION = "com.example.artsky.artwork";
const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const SESSION_COOKIE = "mock_session";

/** ジョブの各状態にとどまる時間（ミリ秒）。 */
const STAGES: ReadonlyArray<[JobStatus, number]> = [
  ["queued", 1000],
  ["generating", 4000],
  ["validating", 1000],
  ["saving", 1000],
];

export interface MockRequest {
  method: string;
  path: string;
  query: URLSearchParams;
  body?: unknown;
  cookie?: string | undefined;
}

export interface MockResponse {
  status: number;
  body?: unknown;
  headers?: Record<string, string>;
}

interface User {
  did: string;
  handle: string;
  displayName?: string;
  style: StyleName;
  aspectRatio: { width: number; height: number };
  postsCount: number;
  registeredAt?: number;
  settings: Settings;
}

interface Artwork {
  uri: string;
  did: string;
  record: ArtworkRecord;
  indexedAt: number;
}

interface JobState {
  id: string;
  did: string;
  kind: "genesis" | "evolution";
  trigger?: { uri: string; cid: string };
  /** 今回の試行を始めた時刻。 */
  startedAt: number;
  createdAt: number;
  attempts: number;
  willFail: boolean;
  finished?: { status: "done" | "failed"; at: number; artworkUri?: string };
}

class ApiError extends Error {
  readonly code: ErrorCode;
  constructor(code: ErrorCode, message: string) {
    super(message);
    this.code = code;
  }
}

function ok(body: unknown, status = 200): MockResponse {
  return { status, body };
}

function parse<T extends z.ZodType>(schema: T, value: unknown): z.output<T> {
  const result = schema.safeParse(value);
  if (!result.success) throw new ApiError("InvalidRequest", result.error.issues[0]?.message ?? "不正なリクエストです");
  return result.data;
}

function queryObject(query: URLSearchParams): Record<string, string> {
  return Object.fromEntries(query.entries());
}

function paginate<T>(items: T[], limit: number, cursor: string | undefined): { page: T[]; cursor?: string } {
  const offset = cursor ? Number.parseInt(cursor, 10) || 0 : 0;
  const page = items.slice(offset, offset + limit);
  const next = offset + limit;
  return next < items.length ? { page, cursor: String(next) } : { page };
}

/** 数値を少し増減させ、配列（配色）を 1 つ回す。作品の「変化」をそれらしく見せる。 */
function evolveParams(params: Record<string, unknown>, seed: number): Record<string, unknown> {
  const out: Record<string, unknown> = {};
  let i = 0;
  for (const [key, value] of Object.entries(params)) {
    const r = ((hash32(`${seed}:${key}:${i++}`) % 1000) / 1000) * 0.3 + 0.95; // 0.95〜1.25
    if (typeof value === "number") {
      out[key] = Number.isInteger(value) ? Math.max(1, Math.round(value * r)) : Math.round(value * r * 100) / 100;
    } else if (Array.isArray(value) && value.length > 1) {
      out[key] = [...value.slice(1), value[0]];
    } else {
      out[key] = value;
    }
  }
  return out;
}

export class MockBackend {
  private readonly now: () => number;
  private readonly users = new Map<string, User>();
  private artworks: Artwork[] = [];
  private readonly jobs = new Map<string, JobState>();
  private jobSeq = 0;

  constructor(now: () => number = Date.now) {
    this.now = now;
    const start = now();
    for (const seed of SEED_AUTHORS) {
      const firstPiece = seed.pieces[0];
      this.users.set(seed.did, {
        did: seed.did,
        handle: seed.handle,
        displayName: seed.displayName,
        style: seed.style,
        aspectRatio: seed.aspectRatio,
        postsCount: seed.postsCount,
        registeredAt: start - (firstPiece?.minutesAgo ?? 0) * 60_000,
        settings: { generationEnabled: true, listed: true },
      });
      seed.pieces.forEach((piece, index) => {
        const user = this.users.get(seed.did) as User;
        this.addArtwork(user, {
          at: start - piece.minutesAgo * 60_000,
          title: piece.title,
          params: piece.params,
          postsCount: seed.postsCount - (seed.pieces.length - 1 - index),
        });
      });
    }
  }

  // ---- 作品 ----

  private artworksOf(did: string): Artwork[] {
    return this.artworks.filter((a) => a.did === did).sort((a, b) => a.indexedAt - b.indexedAt);
  }

  private addArtwork(
    user: User,
    input: {
      at: number;
      title: string;
      params: Record<string, unknown>;
      postsCount: number;
      trigger?: { uri: string; cid: string } | undefined;
    },
  ): Artwork {
    const previous = this.artworksOf(user.did).at(-1);
    // evolution のレコードキーは、きっかけの投稿と同じにする（docs/lexicon.md）。
    const rkey = input.trigger?.uri.split("/").at(-1) ?? tidFromTime(input.at);
    const createdAt = new Date(input.at).toISOString();
    const record: ArtworkRecord = {
      $type: COLLECTION,
      kind: previous ? "evolution" : "genesis",
      ...(previous
        ? {
            trigger: input.trigger ?? { uri: `at://${user.did}/app.bsky.feed.post/${rkey}`, cid: CID },
            previous: { uri: previous.uri, cid: CID },
          }
        : {}),
      renderer: { runtime: "canvas2d", version: "1", animated: isAnimated(user.style) },
      code: styleCode(user.style),
      params: input.params,
      // 何番目の作品かで決める。開発サーバーを再起動しても同じ絵になる。
      seed: hash32(`${user.did}:${this.artworksOf(user.did).length}`),
      aspectRatio: user.aspectRatio,
      title: input.title,
      generator: { id: "artsky-mock", version: "0.1.0" },
      inputs: {
        postsSampled: previous ? 1 : Math.min(100, input.postsCount),
        newestPostAt: createdAt,
        profile: { postsCount: input.postsCount },
      },
      state: { pieces: this.artworksOf(user.did).length + 1 },
      createdAt,
    };
    const artwork: Artwork = { uri: `at://${user.did}/${COLLECTION}/${rkey}`, did: user.did, record, indexedAt: input.at };
    this.artworks.push(artwork);
    return artwork;
  }

  private authorView(user: User): AuthorView {
    return { did: user.did, handle: user.handle, ...(user.displayName ? { displayName: user.displayName } : {}) };
  }

  private artworkView(artwork: Artwork): ArtworkView {
    const user = this.users.get(artwork.did) as User;
    return {
      uri: artwork.uri,
      cid: CID,
      author: this.authorView(user),
      record: artwork.record,
      indexedAt: new Date(artwork.indexedAt).toISOString(),
    };
  }

  private findListedUser(actor: string): User | undefined {
    const user = actor.startsWith("did:")
      ? this.users.get(actor)
      : [...this.users.values()].find((u) => u.handle === actor);
    return user?.registeredAt !== undefined && user.settings.listed ? user : undefined;
  }

  // ---- ジョブ ----

  /** 時間の経過に合わせてジョブを進め、終わったものは作品を作る。 */
  private advanceJobs(): void {
    const now = this.now();
    const total = STAGES.reduce((sum, [, ms]) => sum + ms, 0);
    const pending = [...this.jobs.values()].filter((j) => !j.finished).sort((a, b) => a.createdAt - b.createdAt);
    for (const job of pending) {
      const finishAt = job.startedAt + total;
      if (now < finishAt) continue;
      if (job.willFail) {
        job.finished = { status: "failed", at: finishAt };
        continue;
      }
      const user = this.users.get(job.did) as User;
      const previous = this.artworksOf(user.did).at(-1);
      const count = this.artworksOf(user.did).length;
      const artwork = this.addArtwork(user, {
        at: finishAt,
        title: previous ? `${previous.record.title?.replace(/ #\d+$/, "") ?? "無題"} #${count + 1}` : "はじまり",
        params: previous ? evolveParams(previous.record.params ?? {}, finishAt) : {},
        postsCount: user.postsCount,
        trigger: job.trigger,
      });
      job.finished = { status: "done", at: finishAt, artworkUri: artwork.uri };
    }
  }

  private jobView(job: JobState): Job {
    let status: JobStatus = job.finished?.status ?? "queued";
    if (!job.finished) {
      let elapsed = this.now() - job.startedAt;
      for (const [stage, ms] of STAGES) {
        status = stage;
        if (elapsed < ms) break;
        elapsed -= ms;
      }
    }
    return {
      id: job.id,
      kind: job.kind,
      status,
      ...(job.trigger ? { trigger: job.trigger } : {}),
      ...(job.finished?.artworkUri ? { artwork: { uri: job.finished.artworkUri, cid: CID } } : {}),
      ...(job.finished?.status === "failed"
        ? {
            error: {
              code: "validation_failed" as const,
              message: "生成したコードが検証に通りませんでした（モックで失敗を指定しています）",
              retryable: true,
            },
          }
        : {}),
      attempts: job.attempts,
      createdAt: new Date(job.createdAt).toISOString(),
      updatedAt: new Date(job.finished?.at ?? this.now()).toISOString(),
    };
  }

  private createJob(user: User, kind: JobState["kind"], options: { trigger?: JobState["trigger"]; willFail?: boolean }): JobState {
    const now = this.now();
    // 同じ人のジョブは 1 つずつ処理するので、前のジョブが終わる時刻から始める。
    const total = STAGES.reduce((sum, [, ms]) => sum + ms, 0);
    const busyUntil = Math.max(
      now,
      ...[...this.jobs.values()].filter((j) => j.did === user.did && !j.finished).map((j) => j.startedAt + total),
    );
    const job: JobState = {
      id: `job-${++this.jobSeq}`,
      did: user.did,
      kind,
      ...(options.trigger ? { trigger: options.trigger } : {}),
      startedAt: busyUntil,
      createdAt: now,
      attempts: 1,
      willFail: options.willFail === true,
    };
    this.jobs.set(job.id, job);
    return job;
  }

  // ---- セッション ----

  private sessionUser(cookie: string | undefined): User | undefined {
    const match = cookie?.match(new RegExp(`(?:^|;\\s*)${SESSION_COOKIE}=([^;]+)`));
    return match?.[1] ? this.users.get(decodeURIComponent(match[1])) : undefined;
  }

  private requireUser(cookie: string | undefined): User {
    const user = this.sessionUser(cookie);
    if (!user) throw new ApiError("AuthRequired", "ログインが必要です");
    return user;
  }

  private requireRegistered(cookie: string | undefined): User {
    const user = this.requireUser(cookie);
    if (user.registeredAt === undefined) throw new ApiError("NotRegistered", "初回登録がまだです");
    return user;
  }

  private me(user: User): Me {
    const registered = user.registeredAt !== undefined;
    return {
      did: user.did,
      handle: user.handle,
      ...(user.displayName ? { displayName: user.displayName } : {}),
      registered,
      ...(registered ? { registeredAt: new Date(user.registeredAt as number).toISOString() } : {}),
      settings: registered ? user.settings : null,
    };
  }

  private login(query: URLSearchParams): MockResponse {
    const parsed = LoginQuery.safeParse(queryObject(query));
    if (!parsed.success) return { status: 302, headers: { location: "/login?error=invalid_handle" } };
    const handle = parsed.data.handle.replace(/^@/, "").toLowerCase();
    let user = [...this.users.values()].find((u) => u.handle === handle);
    if (!user) {
      const h = hash32(handle);
      user = {
        did: `did:plc:mock${h.toString(36).padStart(7, "0")}newuser${String(this.users.size).padStart(4, "0")}`,
        handle,
        style: STYLE_NAMES[h % STYLE_NAMES.length] as StyleName,
        aspectRatio: [{ width: 1, height: 1 }, { width: 4, height: 5 }, { width: 3, height: 2 }][h % 3] as User["aspectRatio"],
        postsCount: 100 + (h % 5000),
        settings: { generationEnabled: true, listed: true },
      };
      this.users.set(user.did, user);
    }
    return {
      status: 302,
      headers: {
        location: parsed.data.returnTo,
        "set-cookie": `${SESSION_COOKIE}=${encodeURIComponent(user.did)}; Path=/; HttpOnly; SameSite=Lax`,
      },
    };
  }

  // ---- 入口 ----

  handle(req: MockRequest): MockResponse {
    try {
      this.advanceJobs();
      return this.route(req);
    } catch (err) {
      if (err instanceof ApiError) return { status: ERRORS[err.code], body: { error: err.code, message: err.message } };
      throw err;
    }
  }

  private route(req: MockRequest): MockResponse {
    const { method, path, query, cookie } = req;
    const key = `${method} ${path}`;

    switch (key) {
      case "GET /oauth/login":
        return this.login(query);
      case "POST /oauth/logout":
        return { status: 204, headers: { "set-cookie": `${SESSION_COOKIE}=; Path=/; Max-Age=0` } };

      case "GET /api/me": {
        const user = this.sessionUser(cookie);
        return ok({ user: user ? this.me(user) : null });
      }

      case "POST /api/register": {
        const user = this.requireUser(cookie);
        parse(RegisterRequest, req.body);
        if (user.registeredAt !== undefined) throw new ApiError("AlreadyRegistered", "初回登録は済んでいます");
        user.registeredAt = this.now();
        const job = this.createJob(user, "genesis", {});
        return ok({ me: this.me(user), job: this.jobView(job) }, 202);
      }

      // モック専用：Bluesky に投稿があったことにする（本物のバックエンドにはない）。
      case "POST /__mock/post": {
        const body = (req.body ?? {}) as { handle?: unknown; fail?: unknown };
        const user = [...this.users.values()].find((u) => u.handle === body.handle);
        if (!user || user.registeredAt === undefined) throw new ApiError("ActorNotFound", "登録済みの参加者ではありません");
        user.postsCount++;
        const post = { uri: `at://${user.did}/app.bsky.feed.post/${tidFromTime(this.now())}`, cid: CID };
        const job = user.settings.generationEnabled
          ? this.createJob(user, "evolution", { trigger: post, willFail: body.fail === true })
          : null;
        return ok({ post, job: job ? this.jobView(job) : null }, 202);
      }

      case "GET /api/jobs": {
        const user = this.requireRegistered(cookie);
        const q = parse(ListJobsQuery, queryObject(query));
        const all = [...this.jobs.values()]
          .filter((j) => j.did === user.did)
          .sort((a, b) => b.createdAt - a.createdAt)
          .map((j) => this.jobView(j))
          .filter((j) => !q.status || j.status === q.status);
        const { page, cursor: next } = paginate(all, q.limit, q.cursor);
        return ok({ jobs: page, ...(next ? { cursor: next } : {}) });
      }

      case "GET /api/settings":
        return ok({ settings: this.requireRegistered(cookie).settings });

      case "PATCH /api/settings": {
        const user = this.requireRegistered(cookie);
        user.settings = { ...user.settings, ...parse(UpdateSettingsRequest, req.body) };
        return ok({ settings: user.settings });
      }

      case "GET /xrpc/com.example.artsky.gallery.listLatest": {
        const q = parse(ListLatestParams, queryObject(query));
        const latest = [...this.users.values()]
          .filter((u) => u.registeredAt !== undefined && u.settings.listed)
          .map((u) => this.artworksOf(u.did).at(-1))
          .filter((a): a is Artwork => a !== undefined)
          .sort((a, b) => b.indexedAt - a.indexedAt);
        const { page, cursor: next } = paginate(latest, q.limit, q.cursor);
        return ok({ items: page.map((a) => this.artworkView(a)), ...(next ? { cursor: next } : {}) });
      }

      case "GET /xrpc/com.example.artsky.gallery.listByActor": {
        const q = parse(ListByActorParams, queryObject(query));
        const user = this.findListedUser(q.actor);
        if (!user) throw new ApiError("ActorNotFound", "参加者が見つかりません");
        const all = this.artworksOf(user.did).reverse();
        const { page, cursor: next } = paginate(all, q.limit, q.cursor);
        return ok({
          author: this.authorView(user),
          items: page.map((a) => this.artworkView(a)),
          ...(next ? { cursor: next } : {}),
        });
      }

      case "GET /xrpc/com.example.artsky.gallery.getArtwork": {
        const q = parse(GetArtworkParams, queryObject(query));
        const artwork = this.artworks.find((a) => a.uri === q.uri);
        if (!artwork || !this.findListedUser(artwork.did)) throw new ApiError("NotFound", "作品が見つかりません");
        const history = this.artworksOf(artwork.did);
        const index = history.indexOf(artwork);
        const previous = history[index - 1];
        const next = history[index + 1];
        return ok({
          artwork: this.artworkView(artwork),
          ...(previous ? { previous: previous.uri } : {}),
          ...(next ? { next: next.uri } : {}),
        });
      }
    }

    const jobMatch = path.match(/^\/api\/jobs\/([^/]+)(\/retry)?$/);
    if (jobMatch && ((method === "GET" && !jobMatch[2]) || (method === "POST" && jobMatch[2]))) {
      const user = this.requireRegistered(cookie);
      const job = this.jobs.get(jobMatch[1] as string);
      if (!job || job.did !== user.did) throw new ApiError("NotFound", "ジョブが見つかりません");
      if (!jobMatch[2]) return ok({ job: this.jobView(job) });
      if (job.finished?.status !== "failed") throw new ApiError("JobNotRetryable", "失敗したジョブだけ再試行できます");
      delete job.finished;
      job.startedAt = this.now();
      job.attempts++;
      job.willFail = false;
      return ok({ job: this.jobView(job) }, 202);
    }

    throw new ApiError("NotFound", `${key} はありません`);
  }
}
