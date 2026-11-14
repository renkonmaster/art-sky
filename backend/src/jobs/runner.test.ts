import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { toGeneratedArtwork } from "../generation/claude.ts";
import type { ArtworkRecord } from "../generation/record.ts";
import type { GenerationInput } from "../generation/types.ts";
import { createUserRepository } from "../users.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";
import { runJob, type RunnerDeps } from "./runner.ts";

const DID = "did:plc:alice";

const generated = toGeneratedArtwork({
  analysis: {
    valence: 0,
    arousal: 500,
    dominant: "neutral",
    mix: { joy: 0, calm: 0, excitement: 0, nostalgia: 0, sadness: 0, anxiety: 0, anger: 0, neutral: 1000 },
    personality: { openness: 500, conscientiousness: 500, extraversion: 500, agreeableness: 500, neuroticism: 500 },
  },
  title: "t",
  code: "export default function draw(ctx, env) {}",
  paramsJson: "{}",
  stateJson: '{"pieces":1}',
  animated: false,
  aspectRatio: { width: 1, height: 1 },
});

/** PDS と公開 AppView の代わり */
function fakes() {
  const repo = new Map<string, { uri: string; cid: string; value: unknown }>();
  const puts: { collection: string; rkey: string; record: unknown }[] = [];
  const inputs: GenerationInput[] = [];
  const key = (collection: string, rkey: string) => `${collection}/${rkey}`;

  const userAgent = {
    com: {
      atproto: {
        repo: {
          async getRecord({ collection, rkey }: { collection: string; rkey: string }) {
            const r = repo.get(key(collection, rkey));
            if (!r) throw new Error("not found");
            return { data: r };
          },
          async listRecords({ collection, cursor }: { collection: string; cursor?: string }) {
            const records = [...repo.entries()]
              .filter(([k]) => k.startsWith(`${collection}/`))
              .map(([k, v]) => ({ rkey: k.slice(collection.length + 1), ...v }))
              .filter((r) => cursor === undefined || r.rkey < cursor)
              .sort((a, b) => (a.rkey < b.rkey ? 1 : -1));
            return { data: { records: records.slice(0, 1) } };
          },
          async putRecord({ collection, rkey, record }: { collection: string; rkey: string; record: unknown }) {
            puts.push({ collection, rkey, record });
            const uri = `at://${DID}/${collection}/${rkey}`;
            repo.set(key(collection, rkey), { uri, cid: `cid-${rkey}`, value: record });
            return { data: { uri, cid: `cid-${rkey}` } };
          },
        },
      },
    },
  };

  const publicAgent = {
    async getProfile() {
      return { data: { did: DID, handle: "alice.test", postsCount: 3 } };
    },
    async getAuthorFeed() {
      return {
        data: {
          feed: [
            { post: { uri: "at://p/1", author: { did: DID }, record: { text: "朝の空", createdAt: "2026-11-13T00:00:00Z" }, indexedAt: "" } },
            { post: { uri: "at://p/2", author: { did: DID }, record: { text: "返信", createdAt: "2026-11-12T00:00:00Z", reply: {} }, indexedAt: "" } },
            { post: { uri: "at://p/3", author: { did: "did:other" }, record: { text: "x" }, indexedAt: "" }, reason: {} },
          ],
        },
      };
    },
  };

  return { repo, puts, inputs, userAgent, publicAgent };
}

let jobs: JobRepository;
let f: ReturnType<typeof fakes>;
let deps: RunnerDeps;

beforeEach(() => {
  const db = openDatabase(":memory:");
  createUserRepository(db).touch(DID, { handle: "alice.test" });
  jobs = createJobRepository(db);
  f = fakes();
  deps = {
    jobs,
    publicAgent: f.publicAgent as unknown as RunnerDeps["publicAgent"],
    getUserAgent: async () => f.userAgent as unknown as Awaited<ReturnType<RunnerDeps["getUserAgent"]>>,
    generate: async (input) => {
      f.inputs.push(input);
      return { artwork: generated, model: "test", usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 } };
    },
    validate: async () => {},
    timeZone: "UTC",
  };
});

describe("runJob", () => {
  it("genesis：返信を除いた投稿から作り、決めたレコードキーで保存する", async () => {
    const job = jobs.enqueueGenesis(DID, "3genesis");
    await runJob(deps, jobs.claimNext()!);

    const input = f.inputs[0]!;
    expect(input.kind).toBe("genesis");
    expect(input.kind === "genesis" && input.posts.map((p) => p.text)).toEqual(["朝の空"]);
    expect(f.puts[0]).toMatchObject({ collection: "com.example.artsky.artwork", rkey: "3genesis" });
    expect(jobs.get(job.id)).toMatchObject({ status: "done", artworkUri: `at://${DID}/com.example.artsky.artwork/3genesis` });
  });

  it("evolution：元投稿と直前の作品を参照し、元投稿と同じキーで保存する", async () => {
    const g = jobs.enqueueGenesis(DID, "3a");
    await runJob(deps, jobs.claimNext()!);
    f.repo.set("app.bsky.feed.post/3b", { uri: `at://${DID}/app.bsky.feed.post/3b`, cid: "post-cid", value: { text: "初雪", createdAt: "2026-11-14T00:00:00Z" } });

    jobs.enqueueEvolution(DID, `at://${DID}/app.bsky.feed.post/3b`, "3b");
    await runJob(deps, jobs.claimNext()!);

    const record = f.puts[1]!.record as ArtworkRecord;
    expect(f.puts[1]!.rkey).toBe("3b");
    expect(record.kind).toBe("evolution");
    expect(record.trigger).toEqual({ uri: `at://${DID}/app.bsky.feed.post/3b`, cid: "post-cid" });
    expect(record.previous).toEqual({ uri: jobs.get(g.id)!.artworkUri, cid: "cid-3a" });
    // genesis の features を引き継ぐ
    expect(record.state.features).toEqual((f.puts[0]!.record as ArtworkRecord).state.features);
  });

  it("同じジョブを 2 回保存しても同じレコードを上書きするだけ", async () => {
    jobs.enqueueGenesis(DID, "3a");
    const job = jobs.claimNext()!;
    await runJob(deps, job);
    await runJob(deps, job);
    expect(new Set(f.puts.map((p) => p.rkey))).toEqual(new Set(["3a"]));
    expect([...f.repo.keys()].filter((k) => k.startsWith("com.example.artsky.artwork/"))).toHaveLength(1);
  });
});
