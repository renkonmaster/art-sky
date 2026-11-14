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
