import { beforeEach, describe, expect, it } from "vitest";
import { runCron } from "./cron.ts";
import { openDatabase } from "./db/database.ts";
import { createGalleryIndex } from "./gallery/index.ts";
import { createJobRepository, type JobRepository } from "./jobs/repository.ts";
import type { RunnerDeps } from "./jobs/runner.ts";
import { runQueuedJobs, SessionExpiredError } from "./jobs/worker.ts";
import { createUserRepository, type UserRepository } from "./users.ts";

let db: ReturnType<typeof openDatabase>;
let users: UserRepository;
let jobs: JobRepository;
let runner: RunnerDeps;

beforeEach(async () => {
  db = openDatabase(":memory:");
  users = createUserRepository(db);
  jobs = createJobRepository(db);
  // ログイン情報がない状態：どのジョブも「期限切れ」で失敗する
  runner = {
    jobs,
    publicAgent: {} as RunnerDeps["publicAgent"],
    getUserAgent: async () => {
      throw new SessionExpiredError("no session");
    },
    generate: async () => {
      throw new Error("呼ばれない");
    },
    validate: async () => {},
    timeZone: "UTC",
  };
  for (const did of ["did:plc:a", "did:plc:b", "did:plc:c"]) {
    await users.touch(did, { handle: `${did.slice(-1)}.test` });
    await users.consent(did);
    await jobs.enqueueGenesis(did, `3${did.slice(-1)}`);
  }
});

describe("runQueuedJobs", () => {
  it("1 回に処理する件数に上限があり、失敗は理由つきで記録する", async () => {
    expect(await runQueuedJobs(runner, { maxJobs: 2, log: () => {} })).toEqual({ done: 0, failed: 2 });
    const statuses = await Promise.all(["did:plc:a", "did:plc:b", "did:plc:c"].map(async (d) => (await jobs.listByDid(d))[0]!));
    expect(statuses.map((j) => j.status)).toEqual(["failed", "failed", "queued"]);
    expect(statuses[0]).toMatchObject({ errorCode: "auth_expired" });
  });

  it("時間の上限を過ぎたら、新しいジョブを始めない", async () => {
    let t = 0;
    const now = () => (t += 1000);
    expect(await runQueuedJobs(runner, { budgetMs: 1500, now, log: () => {} })).toEqual({ done: 0, failed: 1 });
  });
});

describe("runCron", () => {
  it("処理中のまま止まったジョブをやり直し、たまったジョブを処理する", async () => {
    const stuck = (await jobs.claimNext())!;
    db.raw.prepare("UPDATE jobs SET updated_at = ? WHERE id = ?").run("2026-01-01T00:00:00.000Z", stuck.id);
    const result = await runCron({
      consumer: { users, jobs, gallery: createGalleryIndex(db) },
      pull: { loadCursor: () => undefined, saveCursor: () => {}, createSocket: () => { throw new Error("offline"); }, log: () => {} },
      runner,
      jobs: { log: () => {} },
      log: () => {},
    });
    expect(result.pull.outcome).toBe("failed");
    expect(result.jobs).toEqual({ done: 0, failed: 3 });
    expect(await jobs.get(stuck.id)).toMatchObject({ status: "failed", attempts: 2 });
  });
});
