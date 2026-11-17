import { beforeEach, describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import type { ArtworkRecord } from "../generation/record.ts";
import type { GeneratedArtwork, GenerationInput } from "../generation/types.ts";
import { createUserRepository } from "../users.ts";
import { createJobRepository, type JobRepository } from "./repository.ts";
import { runJob, type RunnerDeps } from "./runner.ts";

const DID = "did:plc:alice";

const generated: GeneratedArtwork = {
  analysis: {
    valence: 0,
    arousal: 500,
    dominant: "neutral",
    mix: { joy: 0, calm: 0, excitement: 0, nostalgia: 0, sadness: 0, anxiety: 0, anger: 0, neutral: 1000 },
    personality: { openness: 500, conscientiousness: 500, extraversion: 500, agreeableness: 500, neuroticism: 500 },
  },
  code: "export default function draw(ctx, env) {}",
  params: {},
  state: { pieces: 1 },
  animated: false,
  aspectRatio: { width: 1, height: 1 },
};

/** PDS と公開 AppView の代わり */
function fakes() {
  const repo = new Map<string, { uri: string; cid: string; value: unknown }>();
  const puts: { collection: string; rkey: string; record: unknown }[] = [];
  const deletes: string[] = [];
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
          async listRecords({ collection, cursor, limit = 50 }: { collection: string; cursor?: string; limit?: number }) {
            const records = [...repo.entries()]
              .filter(([k]) => k.startsWith(`${collection}/`))
              .map(([k, v]) => ({ rkey: k.slice(collection.length + 1), ...v }))
              .filter((r) => cursor === undefined || r.rkey < cursor)
              .sort((a, b) => (a.rkey < b.rkey ? 1 : -1));
            return { data: { records: records.slice(0, limit) } };
          },
          async putRecord({ collection, rkey, record }: { collection: string; rkey: string; record: unknown }) {
            puts.push({ collection, rkey, record });
            const uri = `at://${DID}/${collection}/${rkey}`;
            const cid = `cid-${rkey}-${puts.length}`;
            repo.set(key(collection, rkey), { uri, cid, value: record });
            return { data: { uri, cid } };
          },
          async deleteRecord({ collection, rkey }: { collection: string; rkey: string }) {
            deletes.push(rkey);
            repo.delete(key(collection, rkey));
            return { data: {} };
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

  return { repo, puts, deletes, inputs, userAgent, publicAgent };
}

let jobs: JobRepository;
let f: ReturnType<typeof fakes>;
let deps: RunnerDeps;

beforeEach(async () => {
  const db = openDatabase(":memory:");
  await createUserRepository(db).touch(DID, { handle: "alice.test" });
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
  const SELF = `at://${DID}/com.example.artsky.artwork/self`;
  const artworkKeys = () => [...f.repo.keys()].filter((k) => k.startsWith("com.example.artsky.artwork/"));
  const addPost = (rkey: string, text: string) =>
    f.repo.set(`app.bsky.feed.post/${rkey}`, { uri: `at://${DID}/app.bsky.feed.post/${rkey}`, cid: `post-${rkey}`, value: { text, createdAt: "2026-11-14T00:00:00Z" } });

  it("genesis：返信を除いた投稿から作り、レコードキー self で保存する", async () => {
    const job = await jobs.enqueueGenesis(DID, "3genesis");
    await runJob(deps, (await jobs.claimNext())!);

    const input = f.inputs[0]!;
    expect(input.kind).toBe("genesis");
    expect(input.kind === "genesis" && input.posts.map((p) => p.text)).toEqual(["朝の空"]);
    expect(f.puts[0]).toMatchObject({ collection: "com.example.artsky.artwork", rkey: "self" });
    expect(await jobs.get(job.id)).toMatchObject({ status: "done", artworkUri: SELF });
  });

  it("evolution：元投稿と直前の作品を参照し、同じ self を上書きする（PDS に作品は 1 件だけ）", async () => {
    await jobs.enqueueGenesis(DID, "3a");
    await runJob(deps, (await jobs.claimNext())!);
    addPost("3b", "初雪");

    await jobs.enqueueEvolution(DID, `at://${DID}/app.bsky.feed.post/3b`, "3b");
    await runJob(deps, (await jobs.claimNext())!);

    const record = f.puts[1]!.record as ArtworkRecord;
    expect(f.puts[1]!.rkey).toBe("self");
    expect(record.kind).toBe("evolution");
    expect(record.trigger).toEqual({ uri: `at://${DID}/app.bsky.feed.post/3b`, cid: "post-3b" });
    expect(record.previous).toEqual({ uri: SELF, cid: "cid-self-1" });
    // genesis の features を引き継ぐ
    expect(record.state.features).toEqual((f.puts[0]!.record as ArtworkRecord).state.features);
    expect(artworkKeys()).toEqual(["com.example.artsky.artwork/self"]);
  });

  it("同じ投稿のジョブを 2 回実行しても、2 回目は作り直さない", async () => {
    await jobs.enqueueGenesis(DID, "3a");
    await runJob(deps, (await jobs.claimNext())!);
    addPost("3b", "初雪");
    const job = await jobs.enqueueEvolution(DID, `at://${DID}/app.bsky.feed.post/3b`, "3b");
    const claimed = (await jobs.claimNext())!;
    await runJob(deps, claimed);
    await runJob(deps, claimed);
    expect(f.puts).toHaveLength(2);
    expect(await jobs.get(job.id)).toMatchObject({ status: "done", artworkUri: SELF });
  });

  it("以前の方式で投稿ごとに作った作品を引き継いで、保存後に PDS から消す", async () => {
    const legacy = (rkey: string) =>
      f.repo.set(`com.example.artsky.artwork/${rkey}`, { uri: `at://${DID}/com.example.artsky.artwork/${rkey}`, cid: `old-${rkey}`, value: f.puts[0]!.record });
    await jobs.enqueueGenesis(DID, "3a");
    await runJob(deps, (await jobs.claimNext())!);
    f.repo.delete("com.example.artsky.artwork/self");
    legacy("3old1");
    legacy("3old2");
    addPost("3b", "初雪");

    await jobs.enqueueEvolution(DID, `at://${DID}/app.bsky.feed.post/3b`, "3b");
    await runJob(deps, (await jobs.claimNext())!);

    // 前作品は以前の方式の最新のもの
    expect((f.puts[1]!.record as ArtworkRecord).previous).toEqual({ uri: `at://${DID}/com.example.artsky.artwork/3old2`, cid: "old-3old2" });
    expect(new Set(f.deletes)).toEqual(new Set(["3old1", "3old2"]));
    expect(artworkKeys()).toEqual(["com.example.artsky.artwork/self"]);
  });
});
