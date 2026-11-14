import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createUserRepository } from "../users.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";

let jobs: JobRepository;
let users: ReturnType<typeof createUserRepository>;

beforeEach(() => {
  const db = openDatabase(":memory:");
  jobs = createJobRepository(db);
  users = createUserRepository(db);
  users.touch("did:a", { handle: "a.test" });
  users.touch("did:b", { handle: "b.test" });
});

describe("ジョブ", () => {
  it("同じ投稿のジョブは 1 つだけ作られる", () => {
    const first = jobs.enqueueEvolution("did:a", "at://did:a/app.bsky.feed.post/3k1", "3k1");
    const second = jobs.enqueueEvolution("did:a", "at://did:a/app.bsky.feed.post/3k1", "3k1");
    expect(second.id).toBe(first.id);
    expect(jobs.listByDid("did:a")).toHaveLength(1);
  });

  it("genesis も 1 人 1 つだけ", () => {
    const first = jobs.enqueueGenesis("did:a", "tid1");
    expect(jobs.enqueueGenesis("did:a", "tid2")).toMatchObject({ id: first.id, rkey: "tid1" });
  });

  it("evolution は genesis が終わるまで処理しない", () => {
    jobs.enqueueEvolution("did:a", "at://p1", "p1");
    expect(jobs.claimNext()).toBeUndefined();

    const genesis = jobs.enqueueGenesis("did:a", "g");
    expect(jobs.claimNext()?.id).toBe(genesis.id);
    jobs.complete(genesis.id, { uri: "at://art/g", cid: "c" });
    expect(jobs.claimNext()?.kind).toBe("evolution");
  });

  it("1 人のジョブは 1 つずつ。別の人のジョブは並べて取れる", () => {
    const g = jobs.enqueueGenesis("did:a", "g");
    jobs.complete(g.id, { uri: "at://art/g", cid: "c" });
    jobs.enqueueEvolution("did:a", "at://p1", "p1");
    jobs.enqueueEvolution("did:a", "at://p2", "p2");
    jobs.enqueueGenesis("did:b", "gb");

    expect(jobs.claimNext()?.triggerUri).toBe("at://p1");
    expect(jobs.claimNext()?.did).toBe("did:b");
    expect(jobs.claimNext()).toBeUndefined(); // did:a の p1 が処理中
  });

  it("生成を止めた人のジョブは取らない", () => {
    jobs.enqueueGenesis("did:a", "g");
    users.updateSettings("did:a", { generationEnabled: false, listed: true });
    expect(jobs.claimNext()).toBeUndefined();
  });

  it("再試行できるのは failed だけで、レコードキーは変わらない", () => {
    const g = jobs.enqueueGenesis("did:a", "g");
    expect(jobs.retry(g.id)).toBe(false);
    jobs.claimNext();
    jobs.fail(g.id, "boom");
    expect(jobs.retry(g.id)).toBe(true);
    const again = jobs.claimNext()!;
    expect(again).toMatchObject({ id: g.id, rkey: "g", attempts: 2, error: null });
  });

  it("起動時に処理中のジョブを queued に戻す", () => {
    jobs.enqueueGenesis("did:a", "g");
    const job = jobs.claimNext()!;
    jobs.setStatus(job.id, "saving");
    expect(jobs.resetInterrupted()).toBe(1);
    expect(jobs.get(job.id)?.status).toBe("queued");
  });
});
