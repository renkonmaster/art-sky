import { randomInt } from "node:crypto";
import type { GenerationInput, GenerationResult, SourcePost } from "./types.ts";

export const ARTWORK_COLLECTION = "com.example.artsky.artwork";
export const GENERATOR_ID = "artsky-claude";
export const GENERATOR_VERSION = "0.1.0";
export const RENDERER = { runtime: "canvas2d", version: "1" } as const;

/** com.atproto.repo.strongRef */
export interface StrongRef {
  uri: string;
  cid: string;
}

/** lexicons/com/example/artsky/artwork.json の main レコード。 */
export interface ArtworkRecord {
  $type: typeof ARTWORK_COLLECTION;
  kind: "genesis" | "evolution";
  trigger?: StrongRef;
  previous?: StrongRef;
  renderer: { runtime: string; version: string; animated: boolean };
  code: string;
  params: Record<string, unknown>;
  seed: number;
  aspectRatio: { width: number; height: number };
  title?: string;
  generator: { id: string; version: string; model?: string };
  inputs: {
    postsSampled: number;
    oldestPostAt?: string;
    newestPostAt?: string;
    profile?: {
      postsCount?: number;
      followersCount?: number;
      followsCount?: number;
      accountCreatedAt?: string;
    };
  };
  state: Record<string, unknown>;
  createdAt: string;
}

/** evolution では trigger と previous が必須。 */
export type RecordRefs = { kind: "genesis" } | { kind: "evolution"; trigger: StrongRef; previous: StrongRef };

/** 0 から 2^32-1 までの乱数シード。 */
export function randomSeed(): number {
  return randomInt(0, 2 ** 32);
}

function postRange(posts: SourcePost[]): { oldestPostAt?: string; newestPostAt?: string } {
  if (posts.length === 0) return {};
  const sorted = posts.map((p) => p.createdAt).sort();
  return { oldestPostAt: sorted[0], newestPostAt: sorted[sorted.length - 1] };
}

/** 生成結果に、シード・参照・入力の要約を足して作品レコードにする。 */
export function buildArtworkRecord(
  input: GenerationInput,
  result: GenerationResult,
  refs: RecordRefs,
  options: { seed?: number; now?: Date } = {},
): ArtworkRecord {
  if (input.kind !== refs.kind) {
    throw new Error(`入力 (${input.kind}) と参照 (${refs.kind}) の種類が一致しません`);
  }
  const posts = input.kind === "genesis" ? input.posts : [input.post];
  const { artwork } = result;
  return {
    $type: ARTWORK_COLLECTION,
    kind: input.kind,
    ...(refs.kind === "evolution" ? { trigger: refs.trigger, previous: refs.previous } : {}),
    renderer: { ...RENDERER, animated: artwork.animated },
    code: artwork.code,
    params: artwork.params,
    seed: options.seed ?? randomSeed(),
    aspectRatio: artwork.aspectRatio,
    ...(artwork.title ? { title: artwork.title } : {}),
    generator: { id: GENERATOR_ID, version: GENERATOR_VERSION, model: result.model },
    inputs: {
      postsSampled: posts.length,
      ...postRange(posts),
      profile: input.profile,
    },
    state: artwork.state,
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}
