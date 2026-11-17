/**
 * API の契約テスト。応答を @art-sky/api のスキーマ（フロントエンドが使うものと同じ）で検証するので、
 * ここが通っていれば、フロントエンドとバックエンドで形が食い違うことはない。
 */
import { ArtworkRecord, ErrorBody, routes } from "@art-sky/api";
import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createGalleryIndex, type GalleryIndex } from "../gallery/index.ts";
import { createJobRepository, type JobRepository } from "../jobs/repository.ts";
import { createUserRepository, type UserRepository } from "../users.ts";
import { type AppDeps, createApp } from "./app.ts";

const ALICE = "did:plc:alice";
const BOB = "did:plc:bob";
const SECRET = "test-secret-0123456789";
const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";

let users: UserRepository;
let jobs: JobRepository;
let gallery: GalleryIndex;
let app: ReturnType<typeof createApp>;
let cookie: string;
let loginAs: string;
let authorizeArgs: unknown[];
let kicks: number;
let loggedIn: string[];
let fetchedImages: string[];
let deps: AppDeps;

const record = (title: string, createdAt: string) => ({
  $type: "com.example.artsky.artwork",
  kind: "genesis",
  renderer: { runtime: "canvas2d", version: "1", animated: false },
  code: "export default function draw(ctx, env) { ctx.fillRect(0, 0, env.width, env.height); }",
  params: { hue: 200 },
  seed: 1,
  aspectRatio: { width: 1, height: 1 },
  title,
  generator: { id: "artsky-rules", version: "0.2.0" },
  state: {},
  createdAt,
});

beforeEach(async () => {
  const db = openDatabase(":memory:");
  users = createUserRepository(db);
  jobs = createJobRepository(db);
  gallery = createGalleryIndex(db);
  loginAs = ALICE;
  authorizeArgs = [];
  kicks = 0;
  loggedIn = [];
  fetchedImages = [];
  let tid = 0;
  deps = {
    users,
    jobs,
    gallery,
    oauth: {
      clientMetadata: {},
      jwks: { keys: [] },
      async authorize(...args: unknown[]) {
        authorizeArgs = args;
        return new URL("https://auth.example/authorize");
      },
      async callback(params: URLSearchParams) {
        if (params.get("error")) throw new Error("denied");
        return { session: { did: loginAs }, state: params.get("state") };
      },
      async revoke() {},
    } as unknown as AppDeps["oauth"],
    resolveProfile: async (did) =>
      did === ALICE ? { handle: "alice.test", displayName: "Alice", avatar: "https://cdn.example/alice.jpg" } : { handle: "bob.test" },
    fetchImage: async (url) => {
      fetchedImages.push(url);
      return new Response(new Uint8Array([1, 2, 3]), { headers: { "content-type": "image/jpeg" } });
    },
    newTid: () => `3tid${++tid}`,
    onLogin: async (did) => void loggedIn.push(did),
    onJobQueued: () => void kicks++,
    cookieSecret: SECRET,
    secureCookie: false,
    frontendUrl: "http://127.0.0.1:5173",
  };
  app = createApp(deps);
  cookie = await login(ALICE);
});

async function login(did: string, state = "/manage"): Promise<string> {
  loginAs = did;
  const res = await app.request(`/oauth/callback?code=x&state=${encodeURIComponent(state)}`);
  expect(res.status).toBe(302);
  return res.headers.get("set-cookie")!.split(";")[0]!;
}

const call = (path: string, init: RequestInit = {}, as: string | null = cookie) =>
  app.request(path, { ...init, headers: { ...(as ? { cookie: as } : {}), "content-type": "application/json", ...init.headers } });

const post = (path: string, body?: unknown, as: string | null = cookie) =>
  call(path, { method: "POST", ...(body !== undefined ? { body: JSON.stringify(body) } : {}) }, as);

const CONSENT = { consent: { publish: true } };

async function expectError(res: Response, status: number, code: string) {
  expect(res.status).toBe(status);
  expect(ErrorBody.parse(await res.json()).error).toBe(code);
}

describe("認証", () => {
  it("ログインは戻り先を state に入れて認可サーバーへ送る", async () => {
    const res = await app.request("/oauth/login?handle=@alice.test&returnTo=/manage");
    expect(res.status).toBe(302);
    expect(res.headers.get("location")).toBe("https://auth.example/authorize");
    expect(authorizeArgs).toEqual(["alice.test", expect.objectContaining({ state: "/manage" })]);
  });

  it("このサイトからは投稿しないので、投稿の権限を求めない", async () => {
    expect((authorizeArgs[1] as { scope?: string } | undefined)?.scope ?? "").not.toContain("app.bsky.feed.post");
  });

  it("コールバックは Cookie を発行して、フロントエンドの戻り先へ送る", async () => {
    const res = await app.request("/oauth/callback?code=x&state=%2Fmanage");
    expect(res.headers.get("location")).toBe("http://127.0.0.1:5173/manage");
    expect(res.headers.get("set-cookie")).toMatch(/HttpOnly/i);
    expect(loggedIn).toContain(ALICE);
  });

  it("外部サイトへは戻さない。失敗したらログイン画面へ送る", async () => {
    const res = await app.request(`/oauth/callback?code=x&state=${encodeURIComponent("//evil.example")}`);
    expect(res.headers.get("location")).toBe("http://127.0.0.1:5173/");
    const bad = await app.request("/oauth/login?handle=a&returnTo=https://evil.example");
    expect(bad.headers.get("location")).toBe("http://127.0.0.1:5173/login?error=invalid_handle");
    const denied = await app.request("/oauth/callback?error=access_denied&state=x");
    expect(denied.headers.get("location")).toBe("http://127.0.0.1:5173/login?error=access_denied");
  });

  it("ログアウトすると未ログインに戻る", async () => {
    const res = await post("/oauth/logout");
    expect(res.status).toBe(204);
    expect(res.headers.get("set-cookie")).toMatch(/artsky_sid=;/);
  });
});

describe("内部 API", () => {
  it("未ログインの /api/me は user が null。ほかは 401", async () => {
    expect(routes.getMe.response.parse(await (await call("/api/me", {}, null)).json()).user).toBeNull();
    await expectError(await call("/api/jobs", {}, null), 401, "AuthRequired");
    await expectError(await post("/api/register", CONSENT, null), 401, "AuthRequired");
  });

  it("改ざんした Cookie は未ログイン扱い", async () => {
    const forged = `artsky_sid=${encodeURIComponent("did:plc:mallory.xxx")}`;
    expect(routes.getMe.response.parse(await (await call("/api/me", {}, forged)).json()).user).toBeNull();
  });

  it("ログイン直後は未登録で、設定は null", async () => {
    const me = routes.getMe.response.parse(await (await call("/api/me")).json()).user;
    expect(me).toMatchObject({ did: ALICE, handle: "alice.test", displayName: "Alice", registered: false, settings: null });
    await expectError(await call("/api/jobs"), 409, "NotRegistered");
    await expectError(await call("/api/settings"), 409, "NotRegistered");
  });

  it("同意なしでは登録できない。登録すると genesis ジョブができ、投稿の監視に加わる", async () => {
    await expectError(await post("/api/register", {}), 400, "InvalidRequest");
    await expectError(await post("/api/register", { consent: { publish: false } }), 400, "InvalidRequest");

    const res = await post("/api/register", CONSENT);
    expect(res.status).toBe(routes.register.status);
    const body = routes.register.response.parse(await res.json());
    expect(body.me).toMatchObject({ registered: true, settings: { generationEnabled: true, listed: true } });
    expect(body.job).toMatchObject({ kind: "genesis", status: "queued", attempts: 0 });
    expect(kicks).toBe(1); // 次の定期実行を待たずに生成を始める

    await expectError(await post("/api/register", CONSENT), 409, "AlreadyRegistered");
    expect(await jobs.listByDid(ALICE)).toHaveLength(1);
  });

  it("投稿の API はない", async () => {
    await post("/api/register", CONSENT);
    await expectError(await post("/api/posts", { text: "a" }), 404, "NotFound");
  });

  it("ジョブの一覧・取得・再試行", async () => {
    const { job } = routes.register.response.parse(await (await post("/api/register", CONSENT)).json());
    await jobs.enqueueEvolution(ALICE, `at://${ALICE}/app.bsky.feed.post/3post1`, "3post1", CID);

    const list = routes.listJobs.response.parse(await (await call("/api/jobs")).json());
    expect(list.jobs.map((j) => j.kind)).toEqual(["evolution", "genesis"]); // 新しい順
    expect(list.jobs[0]?.trigger).toEqual({ uri: `at://${ALICE}/app.bsky.feed.post/3post1`, cid: CID });
    const firstPage = routes.listJobs.response.parse(await (await call("/api/jobs?limit=1")).json());
    expect(firstPage.jobs).toHaveLength(1);
    expect(firstPage.cursor).toBeDefined();
    const queued = routes.listJobs.response.parse(await (await call("/api/jobs?status=done")).json());
    expect(queued.jobs).toHaveLength(0);

    await expectError(await post(`/api/jobs/${job.id}/retry`), 409, "JobNotRetryable");
    await jobs.claimNext();
    await jobs.fail(Number(job.id), "生成したコードが何も描きませんでした", "validation_failed");
    const failed = routes.getJob.response.parse(await (await call(`/api/jobs/${job.id}`)).json()).job;
    expect(failed).toMatchObject({ status: "failed", error: { code: "validation_failed", retryable: true }, attempts: 1 });

    const kicksBefore = kicks;
    const retried = await post(`/api/jobs/${job.id}/retry`);
    expect(retried.status).toBe(routes.retryJob.status);
    expect(routes.retryJob.response.parse(await retried.json()).job.status).toBe("queued");
    expect(kicks).toBe(kicksBefore + 1);

    await jobs.claimNext();
    await jobs.complete(Number(job.id), { uri: `at://${ALICE}/com.example.artsky.artwork/3tid1`, cid: CID });
    const done = routes.getJob.response.parse(await (await call(`/api/jobs/${job.id}`)).json()).job;
    expect(done).toMatchObject({ status: "done", artwork: { cid: CID } });
    expect(done.error).toBeUndefined();
  });

  it("他人のジョブは見えない", async () => {
    await post("/api/register", CONSENT);
    const bob = await login(BOB);
    await post("/api/register", CONSENT, bob);
    await expectError(await call("/api/jobs/1", {}, bob), 404, "NotFound");
    await expectError(await call("/api/jobs/abc"), 404, "NotFound");
  });

  it("アバターは本人の Bluesky のアバターだけを中継する", async () => {
    expect((await call("/api/avatar", {}, null)).status).toBe(401);
    // Alice のアバターは cdn.bsky.app ではないので、取りに行かない
    expect((await call("/api/avatar")).status).toBe(404);
    expect(fetchedImages).toEqual([]);

    deps.resolveProfile = async () => ({ handle: "alice.test", avatar: "https://cdn.bsky.app/img/avatar/plain/did:plc:alice/bafy@jpeg" });
    app = createApp(deps);
    const res = await call("/api/avatar");
    expect(res.status).toBe(200);
    expect(res.headers.get("content-type")).toBe("image/jpeg");
    expect(new Uint8Array(await res.arrayBuffer())).toEqual(new Uint8Array([1, 2, 3]));
    expect(fetchedImages).toEqual(["https://cdn.bsky.app/img/avatar/plain/did:plc:alice/bafy@jpeg"]);

    // アバターのない人は 404
    deps.resolveProfile = async () => ({ handle: "alice.test" });
    app = createApp(deps);
    expect((await call("/api/avatar")).status).toBe(404);
  });

  it("設定は PATCH で、送った項目だけ変わる", async () => {
    await post("/api/register", CONSENT);
    const res = await call("/api/settings", { method: "PATCH", body: JSON.stringify({ listed: false }) });
    expect(routes.updateSettings.response.parse(await res.json()).settings).toEqual({ generationEnabled: true, listed: false });
    expect(routes.getSettings.response.parse(await (await call("/api/settings")).json()).settings.listed).toBe(false);
    await expectError(await call("/api/settings", { method: "PATCH", body: "{}" }), 400, "InvalidRequest");
    await expectError(await call("/api/settings", { method: "PUT", body: JSON.stringify({ listed: true }) }), 404, "NotFound");
  });
});

describe("ギャラリー API", () => {
  beforeEach(async () => {
    await post("/api/register", CONSENT);
    const bob = await login(BOB);
    await post("/api/register", CONSENT, bob);
    await gallery.upsert({ did: ALICE, rkey: "3aaa1", cid: CID, record: record("はじまり", "2026-11-10T00:00:00.000Z") });
    await gallery.upsert({ did: ALICE, rkey: "3aaa2", cid: CID, record: record("二作目", "2026-11-12T00:00:00.000Z") });
    await gallery.upsert({ did: ALICE, rkey: "3aaa3", cid: CID, record: record("三作目", "2026-11-14T00:00:00.000Z") });
    await gallery.upsert({ did: BOB, rkey: "3bbb1", cid: CID, record: record("ボブの作品", "2026-11-13T00:00:00.000Z") });
  });

  it("listLatest は参加者ごとに最新の 1 件を、新しい順に返す（ログイン不要）", async () => {
    const res = await call(routes.listLatest.path, {}, null);
    const out = routes.listLatest.response.parse(await res.json());
    expect(out.items.map((i) => ArtworkRecord.parse(i.record).title)).toEqual(["三作目", "ボブの作品"]);
    expect(out.items[0]?.author).toEqual({ did: ALICE, handle: "alice.test", displayName: "Alice", avatar: "https://cdn.example/alice.jpg" });
    expect(out.cursor).toBeUndefined();

    const first = routes.listLatest.response.parse(await (await call(`${routes.listLatest.path}?limit=1`, {}, null)).json());
    expect(first.items).toHaveLength(1);
    const second = routes.listLatest.response.parse(
      await (await call(`${routes.listLatest.path}?limit=1&cursor=${first.cursor}`, {}, null)).json(),
    );
    expect(ArtworkRecord.parse(second.items[0]?.record).title).toBe("ボブの作品");
    expect(second.cursor).toBeUndefined();
  });

  it("listByActor は DID でもハンドル名でも引け、最新の作品 1 件だけを返す", async () => {
    for (const actor of [ALICE, "alice.test", "ALICE.test"]) {
      const out = routes.listByActor.response.parse(
        await (await call(`${routes.listByActor.path}?actor=${encodeURIComponent(actor)}`, {}, null)).json(),
      );
      expect(out.author.did).toBe(ALICE);
      expect(out.items.map((i) => ArtworkRecord.parse(i.record).title)).toEqual(["三作目"]);
    }
    await expectError(await call(`${routes.listByActor.path}?actor=nobody.test`, {}, null), 404, "ActorNotFound");
    await expectError(await call(routes.listByActor.path, {}, null), 400, "InvalidRequest");
  });

  it("getArtwork は最新の作品だけを返す（過去の作品は索引に残さない）", async () => {
    const uri = (rkey: string) => `at://${ALICE}/com.example.artsky.artwork/${rkey}`;
    const get = async (rkey: string) =>
      routes.getArtwork.response.parse(
        await (await call(`${routes.getArtwork.path}?uri=${encodeURIComponent(uri(rkey))}`, {}, null)).json(),
      );
    const latest = await get("3aaa3");
    expect(latest.previous).toBeUndefined();
    expect(latest.next).toBeUndefined();
    await expectError(await call(`${routes.getArtwork.path}?uri=${encodeURIComponent(uri("3aaa2"))}`, {}, null), 404, "NotFound");
    await expectError(await call(`${routes.getArtwork.path}?uri=${encodeURIComponent(uri("3zzz9"))}`, {}, null), 404, "NotFound");
  });

  it("掲載をやめた人の作品は、どの API からも返らない", async () => {
    await call("/api/settings", { method: "PATCH", body: JSON.stringify({ listed: false }) });
    const latest = routes.listLatest.response.parse(await (await call(routes.listLatest.path, {}, null)).json());
    expect(latest.items.map((i) => i.author.did)).toEqual([BOB]);
    await expectError(await call(`${routes.listByActor.path}?actor=alice.test`, {}, null), 404, "ActorNotFound");
    const uri = encodeURIComponent(`at://${ALICE}/com.example.artsky.artwork/3aaa1`);
    await expectError(await call(`${routes.getArtwork.path}?uri=${uri}`, {}, null), 404, "NotFound");
  });

  it("形式の正しくないレコードは索引に入らない", async () => {
    expect(await gallery.upsert({ did: BOB, rkey: "3bbb2", cid: CID, record: { ...record("x", "2026-11-14T00:00:00.000Z"), seed: -1 } })).toBe(false);
    expect(await gallery.upsert({ did: BOB, rkey: "3bbb3", cid: CID, record: "<script>" })).toBe(false);
    expect(await gallery.listByDid(BOB, 10, 0)).toHaveLength(1);
  });
});
