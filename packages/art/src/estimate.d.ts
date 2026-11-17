/** estimate.js の型。 */
export type Emotion = "joy" | "calm" | "excitement" | "nostalgia" | "sadness" | "anxiety" | "anger" | "neutral";
/** 画風。poly（区画）は廃止したが、古い作品の状態には残っている。 */
export type Style = "lines" | "orbit" | "poly";
export type Mix = Record<Emotion, number>;

export interface SourcePost {
  text: string;
  createdAt: string;
  langs?: string[];
}

/** 作品の状態。すべて整数（AT Protocol のレコードに入れるため）。 */
export interface ArtState {
  v: 1;
  mix: Mix;
  activity: number;
  minute: number;
  spread: number;
  exclaim: number;
  emoji: number;
  length: number;
  lastPostAt: string | null;
  posts: number;
  /** 直近の投稿の跡（新しい順、最大 RECENT_MAX 件）。古い作品にはない。 */
  recent?: number[];
  style: Style;
  /** 画風の決め方の版（STYLE_RULE）。古い作品にはない。 */
  styleRule?: number;
  base: { mix: Mix; activity: number; minute: number; exclaim: number; emoji: number; length: number };
}

export interface PostAnalysis {
  scores: Record<Emotion, number>;
  evidence: number;
  exclaim: boolean;
  emoji: boolean;
  words: string[];
  langs: string[];
}

export declare const EMOTIONS: readonly Emotion[];
export declare const STYLE_RULE: number;
export declare const RECENT_MAX: number;
export declare function traceOf(post: SourcePost, analysis: PostAnalysis): number;
export declare function analyzePost(text: string, langs?: string[]): PostAnalysis;
export declare function estimateGenesis(posts: SourcePost[], opts?: { timeZone?: string }): { state: ArtState; topWords: [string, number][] };
export declare function evolveState(prev: ArtState, post: SourcePost, opts?: { timeZone?: string; rate?: number; anchor?: number }): ArtState;
export declare function chooseStyle(state: Pick<ArtState, "mix" | "activity" | "exclaim">): Style;
export declare function detectLangs(text: string, langs?: string[]): string[];
export declare function toMix(vec: Partial<Record<Emotion, number>>): Mix;
export declare function minuteOfDay(iso: string, timeZone: string): number;
