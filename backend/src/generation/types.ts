import type { PostingFeatures } from "../features/stats.ts";

/** 感情の種類（skymood の analyze.js と同じ）。 */
export const EMOTIONS = ["joy", "calm", "excitement", "nostalgia", "sadness", "anxiety", "anger", "neutral"] as const;
export type Emotion = (typeof EMOTIONS)[number];

/** Big Five の 5 因子。 */
export const TRAITS = ["openness", "conscientiousness", "extraversion", "agreeableness", "neuroticism"] as const;
export type Trait = (typeof TRAITS)[number];

/**
 * 投稿から推定した感情と個性の傾向。作品レコードの state.analysis に保存する（公開される）。
 * AT Protocol は小数を扱えないので、すべて 1000 倍した整数にする。
 */
export interface Analysis {
  /** 快（+1000）〜不快（-1000） */
  valence: number;
  /** 落ち着き（0）〜興奮（1000） */
  arousal: number;
  dominant: Emotion;
  /** 各感情の割合（‰、合計 1000） */
  mix: Record<Emotion, number>;
  /** Big Five の傾向（‰、500 が平均的） */
  personality: Record<Trait, number>;
}

/** 生成に使う投稿。本文と投稿日時だけを持ち、レコードには保存しない。 */
export interface SourcePost {
  text: string;
  createdAt: string;
}

/** app.bsky.actor.getProfile から取る、生成時点のアカウント統計。 */
export interface ProfileStats {
  postsCount?: number;
  followersCount?: number;
  followsCount?: number;
  accountCreatedAt?: string;
}

/** 前作品のうち、次の生成に渡す部分。 */
export interface PreviousArtwork {
  title?: string;
  code: string;
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  animated: boolean;
  aspectRatio: AspectRatio;
}

export interface AspectRatio {
  width: number;
  height: number;
}

/** 初回登録時：直近の投稿（最大 100 件）と統計から最初の作品を作る。 */
export interface GenesisInput {
  kind: "genesis";
  posts: SourcePost[];
  profile: ProfileStats;
  /** posts から computeFeatures() で計算した特徴。state.features として以後の作品に引き継ぐ。 */
  features: PostingFeatures;
}

/** 投稿時：今回の投稿と前作品から次の作品を作る。 */
export interface EvolutionInput {
  kind: "evolution";
  post: SourcePost;
  previous: PreviousArtwork;
  profile: ProfileStats;
}

export type GenerationInput = GenesisInput | EvolutionInput;

/** Claude が生成した作品。レコードにするにはシードや参照を足す（record.ts）。 */
export interface GeneratedArtwork {
  title: string;
  /** 今回の時点での感情と個性の推定。evolution では前作品の state.analysis を更新したもの。 */
  analysis: Analysis;
  code: string;
  params: Record<string, unknown>;
  state: Record<string, unknown>;
  animated: boolean;
  aspectRatio: AspectRatio;
}

export interface GenerationResult {
  artwork: GeneratedArtwork;
  /** 実際に応答したモデル。フォールバックした場合は元のモデルと異なる。 */
  model: string;
  usage: {
    inputTokens: number;
    outputTokens: number;
    cacheReadInputTokens: number;
  };
}
