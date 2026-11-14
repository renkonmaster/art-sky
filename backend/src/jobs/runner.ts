/**
 * 1 つのジョブを実行する：入力を集める → Claude で生成 → 検証 → 本人の PDS に保存。
 * 外部とのやりとりは deps で受け取り、テストで差し替えられるようにする。
 */
import type { Agent } from "@atproto/api";
import { fetchProfileStats, fetchRecentPosts } from "../bluesky/posts.ts";
import { computeFeatures } from "../features/stats.ts";
import { ARTWORK_COLLECTION, buildArtworkRecord, type ArtworkRecord, type RecordRefs, type StrongRef } from "../generation/record.ts";
import type { GenerationInput, GenerationResult, ProfileStats } from "../generation/types.ts";
import type { Job, JobRepository } from "./repository.ts";

/** 公開 AppView から読むための Agent（ログイン不要）。 */
type PublicAgent = Pick<Agent, "getProfile" | "getAuthorFeed">;
/** 本人の PDS を読み書きするための Agent（OAuth セッション）。 */
type UserAgent = { com: { atproto: { repo: Pick<Agent["com"]["atproto"]["repo"], "getRecord" | "listRecords" | "putRecord"> } } };

export interface RunnerDeps {
  jobs: JobRepository;
  publicAgent: PublicAgent;
  getUserAgent(did: string): Promise<UserAgent>;
  generate(input: GenerationInput): Promise<GenerationResult>;
  /**
   * 保存前の検証。TODO: Chromium 上の renderer で code を実行して確かめる（docs/tech-stack.md「検証の内容」）。
   * 今は claude.ts の toGeneratedArtwork が行う形式の検査だけ。
   */
  validate(record: ArtworkRecord): Promise<void>;
  timeZone: string;
}

/** 失敗の理由が利用者に見せてよい内容であることを示す。 */
export class JobError extends Error {
  override name = "JobError";
}

async function profileOf(deps: RunnerDeps, did: string): Promise<ProfileStats> {
  const { did: _did, handle: _handle, ...stats } = await fetchProfileStats(deps.publicAgent, did);
  return stats;
}

function isArtworkRecord(value: unknown): value is ArtworkRecord {
  const v = value as Partial<ArtworkRecord> | null;
  return (
    typeof v === "object" &&
    v !== null &&
    typeof v.code === "string" &&
    typeof v.renderer?.runtime === "string" &&
    typeof v.aspectRatio?.width === "number" &&
    typeof v.aspectRatio?.height === "number"
  );
}

/** このジョブの作品より前にある、最も新しい作品。 */
async function findPrevious(agent: UserAgent, did: string, rkey: string): Promise<{ ref: StrongRef; record: ArtworkRecord }> {
  // listRecords はレコードキーの新しい順に返し、cursor より前のキーだけを返す。
  // 再試行で古い投稿のジョブを後から処理しても、その投稿の直前の作品を前作品にできる。
  const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: ARTWORK_COLLECTION, limit: 1, cursor: rkey });
  const prev = data.records[0];
  if (!prev) throw new JobError("前の作品が PDS に見つかりません");
  if (!isArtworkRecord(prev.value)) throw new JobError(`前の作品の形式が正しくありません: ${prev.uri}`);
  return { ref: { uri: prev.uri, cid: prev.cid }, record: prev.value };
}

async function buildInput(deps: RunnerDeps, job: Job, agent: UserAgent): Promise<{ input: GenerationInput; refs: RecordRefs }> {
  const profile = await profileOf(deps, job.did);

  if (job.kind === "genesis") {
    const posts = await fetchRecentPosts(deps.publicAgent, job.did);
    return {
      input: {
        kind: "genesis",
        posts: posts.map((p) => ({ text: p.text, createdAt: p.createdAt })),
        profile,
        features: computeFeatures(posts, { timeZone: deps.timeZone }),
      },
      refs: { kind: "genesis" },
    };
  }

  const { data: post } = await agent.com.atproto.repo.getRecord({ repo: job.did, collection: "app.bsky.feed.post", rkey: job.rkey });
  const value = post.value as { text?: unknown; createdAt?: unknown };
  if (!post.cid || typeof value.text !== "string") throw new JobError("元の投稿を読めません（削除された可能性があります）");
  const previous = await findPrevious(agent, job.did, job.rkey);
  return {
    input: {
      kind: "evolution",
      post: { text: value.text, createdAt: typeof value.createdAt === "string" ? value.createdAt : new Date().toISOString() },
      profile,
      previous: {
        title: previous.record.title,
        code: previous.record.code,
        params: previous.record.params ?? {},
        state: previous.record.state ?? {},
        animated: previous.record.renderer.animated ?? false,
        aspectRatio: previous.record.aspectRatio,
      },
    },
    refs: { kind: "evolution", trigger: { uri: post.uri, cid: post.cid }, previous: previous.ref },
  };
}

export async function runJob(deps: RunnerDeps, job: Job): Promise<StrongRef> {
  const agent = await deps.getUserAgent(job.did);
  const { input, refs } = await buildInput(deps, job, agent);
  const result = await deps.generate(input);
  const record = buildArtworkRecord(input, result, refs);

  deps.jobs.setStatus(job.id, "validating");
  await deps.validate(record);

  deps.jobs.setStatus(job.id, "saving");
  const { data } = await agent.com.atproto.repo.putRecord({
    repo: job.did,
    collection: ARTWORK_COLLECTION,
    rkey: job.rkey,
    record: record as unknown as Record<string, unknown>,
  });
  const artwork = { uri: data.uri, cid: data.cid };
  deps.jobs.complete(job.id, artwork);
  return artwork;
}
