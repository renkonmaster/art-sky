import type { GenerationInput, GenerationResult, SourcePost } from "./types.ts";

export const ARTWORK_COLLECTION = "com.example.artsky.artwork";
/**
 * 作品レコードのキー。1 人につき作品は 1 件だけで、生成のたびに同じキーへ上書きする。
 * 過去の作品は PDS にも残さない。
 */
export const ARTWORK_RKEY = "self";
export const GENERATOR_ID = "artsky-rules";
export const GENERATOR_VERSION = "0.2.0";
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
  return crypto.getRandomValues(new Uint32Array(1))[0]!;
}

function postRange(posts: SourcePost[]): { oldestPostAt?: string; newestPostAt?: string } {
  if (posts.length === 0) return {};
  const sorted = posts.map((p) => p.createdAt).sort();
  return { oldestPostAt: sorted[0], newestPostAt: sorted[sorted.length - 1] };
}

/**
 * 次の作品に引き継ぐ state。生成方式ごとの自由な部分に、生成側が管理する 2 つを足す。
 * - analysis：今回の感情と個性の推定
 * - features：genesis で計算した投稿の特徴。evolution では前作品のものをそのまま引き継ぐ
 */
function buildState(input: GenerationInput, result: GenerationResult): Record<string, unknown> {
  const features = input.kind === "genesis" ? input.features : input.previous.state.features;
  return {
    ...result.artwork.state,
    analysis: result.artwork.analysis,
    ...(features !== undefined ? { features } : {}),
  };
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
    generator: { id: GENERATOR_ID, version: GENERATOR_VERSION, model: result.model },
    inputs: {
      postsSampled: posts.length,
      ...postRange(posts),
      profile: input.profile,
    },
    state: buildState(input, result),
    createdAt: (options.now ?? new Date()).toISOString(),
  };
}
