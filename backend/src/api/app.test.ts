import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createJobRepository, type JobRepository } from "../jobs/repository.ts";
import { createUserRepository } from "../users.ts";
import { createApp, SessionExpiredError, type AppDeps } from "./app.ts";

const DID = "did:plc:alice";
const SECRET = "test-secret-0123456789";

let jobs: JobRepository;
let app: ReturnType<typeof createApp>;
let posted: string[];
let cookie: string;
let sessionExpired: boolean;

beforeEach(async () => {
  const db = openDatabase(":memory:");
  const users = createUserRepository(db);
  jobs = createJobRepository(db);
  posted = [];
  sessionExpired = false;
  let tid = 0;
  const deps: AppDeps = {
    users,
    jobs,
    oauth: {
      clientMetadata: {},
      jwks: { keys: [] },
      async authorize() {
        return new URL("https://auth.example/authorize");
      },
      async callback() {
        return { session: { did: DID } };
      },
      async revoke() {},
    } as unknown as AppDeps["oauth"],
    resolveHandle: async () => "alice.test",
    async createPost(_did, text) {
      if (sessionExpired) throw new SessionExpiredError("expired");
      posted.push(text);
      return { uri: `at://${DID}/app.bsky.feed.post/3p${posted.length}`, cid: "cid" };
    },
    newTid: () => `tid${++tid}`,
    cookieSecret: SECRET,
    secureCookie: false,
    frontendUrl: "http://127.0.0.1:5173",
  };
  app = createApp(deps);

  // ログインして Cookie を受け取る
  const res = await app.request("/oauth/callback?code=x&state=y");
  expect(res.status).toBe(302);
  cookie = res.headers.get("set-cookie")!.split(";")[0]!;
});

const call = (path: string, init: RequestInit = {}) =>
  app.request(path, { ...init, headers: { cookie, "content-type": "application/json", ...init.headers } });

describe("API", () => {
  it("Cookie がなければ 401", async () => {
    expect((await app.request("/api/me")).status).toBe(401);
  });

  it("改ざんした Cookie は 401", async () => {
    const res = await app.request("/api/me", { headers: { cookie: `artsky_sid=${encodeURIComponent("did:plc:mallory.xxx")}` } });
    expect(res.status).toBe(401);
  });

  it("ログイン直後は未登録", async () => {
    expect(await (await call("/api/me")).json()).toMatchObject({ did: DID, handle: "alice.test", registered: false });
  });

  it("同意なしでは登録できない。登録すると genesis ジョブができる", async () => {
    expect((await call("/api/register", { method: "POST", body: "{}" })).status).toBe(400);
    const res = await call("/api/register", { method: "POST", body: JSON.stringify({ consent: true }) });
    expect(res.status).toBe(202);
    expect(await res.json()).toMatchObject({ job: { kind: "genesis", status: "queued" } });
    // もう一度押しても同じジョブ
    const again = await (await call("/api/register", { method: "POST", body: JSON.stringify({ consent: true }) })).json();
    expect(jobs.listByDid(DID)).toHaveLength(1);
    expect(again).toMatchObject({ job: { id: 1 } });
  });

  it("投稿すると evolution ジョブができ、作品のキーは投稿と同じ", async () => {
    expect((await call("/api/posts", { method: "POST", body: JSON.stringify({ text: "a" }) })).status).toBe(409);
    await call("/api/register", { method: "POST", body: JSON.stringify({ consent: true }) });

    const res = await call("/api/posts", { method: "POST", body: JSON.stringify({ text: "初雪" }) });
    expect(res.status).toBe(201);
    const body = (await res.json()) as { job: { id: number; kind: string } };
    expect(body.job.kind).toBe("evolution");
    expect(jobs.get(body.job.id)?.rkey).toBe("3p1");
  });

  it("生成を止めていれば投稿だけする", async () => {
    await call("/api/register", { method: "POST", body: JSON.stringify({ consent: true }) });
    await call("/api/settings", { method: "PUT", body: JSON.stringify({ generationEnabled: false }) });
    const body = await (await call("/api/posts", { method: "POST", body: JSON.stringify({ text: "x" }) })).json();
    expect(body).toMatchObject({ job: null });
    expect(posted).toEqual(["x"]);
  });

  it("長すぎる投稿と、セッション切れを区別して返す", async () => {
    await call("/api/register", { method: "POST", body: JSON.stringify({ consent: true }) });
    expect((await call("/api/posts", { method: "POST", body: JSON.stringify({ text: "あ".repeat(301) }) })).status).toBe(400);
    sessionExpired = true;
    expect((await call("/api/posts", { method: "POST", body: JSON.stringify({ text: "x" }) })).status).toBe(401);
  });

  it("再試行は自分の failed ジョブだけ", async () => {
    await call("/api/register", { method: "POST", body: JSON.stringify({ consent: true }) });
    expect((await call("/api/jobs/1/retry", { method: "POST" })).status).toBe(409);
    jobs.claimNext();
    jobs.fail(1, "boom");
    expect((await call("/api/jobs/1")).status).toBe(200);
    expect((await call("/api/jobs/1/retry", { method: "POST" })).status).toBe(202);
    expect((await call("/api/jobs/999")).status).toBe(404);
  });
});
