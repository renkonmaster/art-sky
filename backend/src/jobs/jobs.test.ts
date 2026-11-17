import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createUserRepository } from "../users.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";

let jobs: JobRepository;
let users: ReturnType<typeof createUserRepository>;

beforeEach(async () => {
  const db = openDatabase(":memory:");
  jobs = createJobRepository(db);
  users = createUserRepository(db);
  await users.touch("did:a", { handle: "a.test" });
  await users.touch("did:b", { handle: "b.test" });
});

describe("ジョブ", () => {
  it("同じ投稿のジョブは 1 つだけ作られる", async () => {
    const first = await jobs.enqueueEvolution("did:a", "at://did:a/app.bsky.feed.post/3k1", "3k1");
    const second = await jobs.enqueueEvolution("did:a", "at://did:a/app.bsky.feed.post/3k1", "3k1");
    expect(second.id).toBe(first.id);
    expect(await jobs.listByDid("did:a")).toHaveLength(1);
  });

  it("genesis も 1 人 1 つだけ", async () => {
    const first = await jobs.enqueueGenesis("did:a", "tid1");
    expect(await jobs.enqueueGenesis("did:a", "tid2")).toMatchObject({ id: first.id, rkey: "tid1" });
  });

  it("evolution は genesis が終わるまで処理しない", async () => {
    await jobs.enqueueEvolution("did:a", "at://p1", "p1");
    expect(await jobs.claimNext()).toBeUndefined();

    const genesis = await jobs.enqueueGenesis("did:a", "g");
    expect((await jobs.claimNext())?.id).toBe(genesis.id);
    await jobs.complete(genesis.id, { uri: "at://art/g", cid: "c" });
    expect((await jobs.claimNext())?.kind).toBe("evolution");
  });

  it("1 人のジョブは 1 つずつ。別の人のジョブは並べて取れる", async () => {
    const g = await jobs.enqueueGenesis("did:a", "g");
    await jobs.complete(g.id, { uri: "at://art/g", cid: "c" });
    await jobs.enqueueEvolution("did:a", "at://p1", "p1");
    await jobs.enqueueEvolution("did:a", "at://p2", "p2");
    await jobs.enqueueGenesis("did:b", "gb");

    expect((await jobs.claimNext())?.triggerUri).toBe("at://p1");
    expect((await jobs.claimNext())?.did).toBe("did:b");
    expect(await jobs.claimNext()).toBeUndefined(); // did:a の p1 が処理中
  });

  it("生成を止めた人のジョブは取らない", async () => {
    await jobs.enqueueGenesis("did:a", "g");
    await users.updateSettings("did:a", { generationEnabled: false, listed: true });
    expect(await jobs.claimNext()).toBeUndefined();
  });

  it("再試行できるのは failed だけで、レコードキーは変わらない", async () => {
    const g = await jobs.enqueueGenesis("did:a", "g");
    expect(await jobs.retry(g.id)).toBe(false);
    await jobs.claimNext();
    await jobs.fail(g.id, "boom");
    expect(await jobs.retry(g.id)).toBe(true);
    const again = (await jobs.claimNext())!;
    expect(again).toMatchObject({ id: g.id, rkey: "g", attempts: 2, error: null });
  });

  it("起動時に処理中のジョブを queued に戻す", async () => {
    await jobs.enqueueGenesis("did:a", "g");
    const job = (await jobs.claimNext())!;
    await jobs.setStatus(job.id, "saving");
    expect(await jobs.resetInterrupted()).toBe(1);
    expect((await jobs.get(job.id))?.status).toBe("queued");
  });
});
