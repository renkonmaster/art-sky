import { ArtworkRecord, ErrorBody, routes } from "@art-sky/api";
import { describe, expect, it } from "vitest";
import { MockBackend, type MockRequest, type MockResponse } from "./backend.ts";

function setup() {
  let now = Date.parse("2026-11-14T08:00:00.000Z");
  const backend = new MockBackend(() => now);
  let cookie: string | undefined;
  const call = (method: string, url: string, body?: unknown): MockResponse => {
    const u = new URL(url, "http://mock");
    const req: MockRequest = { method, path: u.pathname, query: u.searchParams, body, cookie };
    const res = backend.handle(req);
    const setCookie = res.headers?.["set-cookie"];
    if (setCookie) cookie = setCookie.split(";")[0];
    return res;
  };
  return { call, advance: (ms: number) => void (now += ms) };
}

describe("ギャラリー API", () => {
  it("listLatest は参加者ごとに最新の 1 件を新しい順に返す", () => {
    const { call } = setup();
    const res = call("GET", routes.listLatest.path);
    const out = routes.listLatest.response.parse(res.body);
    expect(out.items).toHaveLength(8);
    expect(new Set(out.items.map((i) => i.author.did)).size).toBe(8);
    const times = out.items.map((i) => Date.parse(i.indexedAt));
    expect(times).toEqual([...times].sort((a, b) => b - a));
    for (const item of out.items) ArtworkRecord.parse(item.record);
  });

  it("limit と cursor でページを送れる", () => {
    const { call } = setup();
    const first = routes.listLatest.response.parse(call("GET", `${routes.listLatest.path}?limit=5`).body);
    expect(first.items).toHaveLength(5);
    const second = routes.listLatest.response.parse(
      call("GET", `${routes.listLatest.path}?limit=5&cursor=${first.cursor}`).body,
    );
    expect(second.items).toHaveLength(3);
    expect(second.cursor).toBeUndefined();
  });

  it("listByActor と getArtwork で歴史をたどれる", () => {
    const { call } = setup();
    const list = routes.listByActor.response.parse(call("GET", `${routes.listByActor.path}?actor=yui.example.com`).body);
    expect(list.items).toHaveLength(5);
    const oldest = list.items.at(-1);
    const detail = routes.getArtwork.response.parse(
      call("GET", `${routes.getArtwork.path}?uri=${encodeURIComponent(oldest?.uri ?? "")}`).body,
    );
    expect(detail.previous).toBeUndefined();
    expect(detail.next).toBe(list.items.at(-2)?.uri);
  });

  it("いない人は ActorNotFound", () => {
    const { call } = setup();
    const res = call("GET", `${routes.listByActor.path}?actor=nobody.example.com`);
    expect(res.status).toBe(404);
    expect(ErrorBody.parse(res.body).error).toBe("ActorNotFound");
  });
});

describe("ログインから作品の変化まで", () => {
  it("未ログインなら user は null、ログインが必要な API は 401", () => {
    const { call } = setup();
    expect(routes.getMe.response.parse(call("GET", "/api/me").body).user).toBeNull();
    expect(call("GET", "/api/jobs").status).toBe(401);
    expect(call("POST", "/api/posts", { text: "a" }).status).toBe(404); // 投稿 API はない
  });

  it("新しい人が登録すると、最初の作品ができてギャラリーの先頭に並ぶ", () => {
    const { call, advance } = setup();
    expect(call("GET", "/oauth/login?handle=newbie.example.com&returnTo=/studio").headers?.location).toBe("/studio");
    expect(call("POST", "/api/register", { consent: { externalAi: false } }).status).toBe(400);
    const reg = routes.register.response.parse(call("POST", "/api/register", { consent: { externalAi: true } }).body);
    expect(reg.job).toMatchObject({ kind: "genesis", status: "queued" });
    expect(call("POST", "/api/register", { consent: { externalAi: true } }).status).toBe(409);

    advance(2000);
    expect(routes.getJob.response.parse(call("GET", `/api/jobs/${reg.job.id}`).body).job.status).toBe("generating");
    advance(6000);
    const done = routes.getJob.response.parse(call("GET", `/api/jobs/${reg.job.id}`).body).job;
    expect(done.status).toBe("done");

    const latest = routes.listLatest.response.parse(call("GET", routes.listLatest.path).body);
    expect(latest.items).toHaveLength(9);
    expect(latest.items[0]?.uri).toBe(done.artwork?.uri);
  });

  it("Bluesky に投稿があると、次の作品ができる", () => {
    const { call, advance } = setup();
    call("GET", "/oauth/login?handle=ren.example.com");
    const res = call("POST", "/__mock/post", { handle: "ren.example.com" });
    expect(res.status).toBe(202);
    const posted = res.body as { post: { uri: string } };
    expect(routes.listJobs.response.parse(call("GET", "/api/jobs").body).jobs).toHaveLength(1);

    advance(8000);
    const list = routes.listByActor.response.parse(call("GET", `${routes.listByActor.path}?actor=ren.example.com`).body);
    expect(list.items).toHaveLength(2);
    expect(ArtworkRecord.parse(list.items[0]?.record)).toMatchObject({ kind: "evolution", trigger: { uri: posted.post.uri } });
    // 作品のレコードキーは、きっかけの投稿と同じ。
    expect(list.items[0]?.uri.split("/").at(-1)).toBe(posted.post.uri.split("/").at(-1));
  });

  it("失敗した生成は、再試行で成功する", () => {
    const { call, advance } = setup();
    call("GET", "/oauth/login?handle=ren.example.com");
    call("POST", "/__mock/post", { handle: "ren.example.com", fail: true });
    advance(8000);
    const failed = routes.listJobs.response.parse(call("GET", "/api/jobs").body).jobs[0];
    expect(failed).toMatchObject({ status: "failed", error: { retryable: true } });
    expect(call("POST", `/api/jobs/${failed?.id}/retry`).status).toBe(202);
    advance(8000);
    expect(routes.getJob.response.parse(call("GET", `/api/jobs/${failed?.id}`).body).job).toMatchObject({ status: "done", attempts: 2 });
  });

  it("掲載をやめるとギャラリーから消え、生成を止めると投稿があっても作品を作らない", () => {
    const { call } = setup();
    call("GET", "/oauth/login?handle=ren.example.com");
    routes.updateSettings.response.parse(call("PATCH", "/api/settings", { listed: false, generationEnabled: false }).body);
    expect(routes.listLatest.response.parse(call("GET", routes.listLatest.path).body).items).toHaveLength(7);
    expect((call("POST", "/__mock/post", { handle: "ren.example.com" }).body as { job: unknown }).job).toBeNull();
  });
});
