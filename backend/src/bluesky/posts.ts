/**
 * 初回登録時に使う、プロフィールの統計と直近の投稿を取得する。
 * skymood の fetchPosts.js を移植したもの。
 *
 * どちらも公開情報なので、ログインせずに公開 AppView から取れる（docs/tech-stack.md）。
 *   new AtpAgent({ service: "https://public.api.bsky.app" })
 */
import type { Agent } from "@atproto/api";
import type { FeaturePost } from "../features/stats.ts";
import type { ProfileStats } from "../generation/types.ts";

type ReadAgent = Pick<Agent, "getProfile" | "getAuthorFeed">;

/** Plan.md 5.1：初回は直近 100 件 */
export const GENESIS_POST_LIMIT = 100;

export async function fetchProfileStats(agent: ReadAgent, actor: string): Promise<ProfileStats & { did: string; handle: string }> {
  const { data } = await agent.getProfile({ actor });
  return {
    did: data.did,
    handle: data.handle,
    postsCount: data.postsCount,
    followersCount: data.followersCount,
    followsCount: data.followsCount,
    accountCreatedAt: data.createdAt,
  };
}

/** 引用（app.bsky.embed.record / recordWithMedia）かどうか */
function isQuote(embed: unknown): boolean {
  const type = (embed as { $type?: unknown } | undefined)?.$type;
  return type === "app.bsky.embed.record" || type === "app.bsky.embed.recordWithMedia";
}

/**
 * 本人の通常の投稿を新しい順に最大 max 件取得する。
 * Plan.md 10 節に従い、返信・引用・リポストは除く。
 */
export async function fetchRecentPosts(agent: ReadAgent, did: string, { max = GENESIS_POST_LIMIT } = {}): Promise<FeaturePost[]> {
  const posts: FeaturePost[] = [];
  let cursor: string | undefined;

  while (posts.length < max) {
    const { data } = await agent.getAuthorFeed({ actor: did, limit: 100, cursor, filter: "posts_no_replies" });

    for (const item of data.feed) {
      if (item.reason) continue; // リポスト
      if (item.post.author.did !== did) continue;
      const rec = item.post.record as {
        text?: unknown;
        createdAt?: unknown;
        reply?: unknown;
        embed?: { $type?: string; external?: unknown };
        langs?: unknown;
      };
      if (rec.reply) continue; // スレッドの続きなど、filter をすり抜けた返信
      if (isQuote(rec.embed)) continue;
      const text = typeof rec.text === "string" ? rec.text : "";
      posts.push({
        text,
        createdAt: typeof rec.createdAt === "string" ? rec.createdAt : item.post.indexedAt,
        likeCount: item.post.likeCount ?? 0,
        hasMedia: rec.embed !== undefined && rec.embed.$type !== "app.bsky.embed.external",
        hasLink: /https?:\/\//.test(text) || rec.embed?.$type === "app.bsky.embed.external",
        langs: Array.isArray(rec.langs) ? rec.langs.filter((l): l is string => typeof l === "string") : [],
      });
      if (posts.length >= max) break;
    }

    cursor = data.cursor;
    if (!cursor || data.feed.length === 0) break;
  }

  return posts;
}
