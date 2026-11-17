/**
 * AI を使わない生成。投稿から作品の状態を推定し（@art-sky/art の estimate.js）、
 * 共通の描画モジュール（@art-sky/art/draw.js）と組にして作品にする。
 *
 * レコードの形式は Claude で生成していたときと同じ。
 *   - code   ：描画モジュールのソースそのもの（全員共通）
 *   - params ：推定した状態＋seed（DID から作る）＋style（最初の作品で決めた画風）
 * 状態は前の作品の params から引き継ぐので、投稿のたびに少しずつ変化する。
 */
import { readFileSync } from "node:fs";
import { fileURLToPath } from "node:url";
import { estimateGenesis, evolveState, type ArtState } from "@art-sky/art";
import { EMOTIONS, TRAITS, type Analysis, type GenerationInput, type GenerationResult } from "./types.ts";

export const DRAW_CODE = readFileSync(fileURLToPath(import.meta.resolve("@art-sky/art/draw.js")), "utf8");
export const RULES_MODEL = "artsky-rules-1";

/** DID → 32 ビットのシード（FNV-1a）。描画モジュールの乱数はこれだけを使う。 */
export function seedFromDid(did: string): number {
  let h = 0x811c9dc5;
  for (let i = 0; i < did.length; i++) {
    h ^= did.charCodeAt(i);
    h = Math.imul(h, 0x01000193);
  }
  return h >>> 0;
}

/** 前の作品の params が、この方式で作った状態かどうか（Claude で作った古い作品は違う）。 */
function isArtState(value: unknown): value is ArtState & { seed?: number } {
  const v = value as Partial<ArtState> | null;
  return typeof v === "object" && v !== null && v.v === 1 && typeof v.mix === "object" && typeof v.style === "string" && typeof v.base === "object";
}

/** 感情 → 動きの激しさ（estimate.js・draw.js と同じ表）。 */
const ENERGY: Record<(typeof EMOTIONS)[number], number> = {
  anger: 1, excitement: 0.9, anxiety: 0.75, joy: 0.6, neutral: 0.3, nostalgia: 0.2, sadness: 0.15, calm: 0.1,
};

/**
 * state.analysis に入れる要約。感情の割合はそのまま、快・不快と興奮度は割合から計算する。
 * 個性（Big Five）は AI なしでは推定しないので、中立の 500 にする。
 */
function analysisOf(state: ArtState): Analysis {
  const m = state.mix;
  const valence = m.joy + m.calm * 0.6 + m.excitement * 0.7 + m.nostalgia * 0.1 - m.sadness - m.anxiety * 0.8 - m.anger;
  const arousal = EMOTIONS.reduce((a, e) => a + m[e] * ENERGY[e], 0);
  const dominant = EMOTIONS.reduce((a, b) => (m[b] > m[a] ? b : a));
  return {
    valence: Math.round(Math.max(-1000, Math.min(1000, valence))),
    arousal: Math.round(Math.max(0, Math.min(1000, arousal))),
    dominant,
    mix: { ...m },
    personality: Object.fromEntries(TRAITS.map((t) => [t, 500])) as Analysis["personality"],
  };
}

export function generateWithoutAi(input: GenerationInput): GenerationResult {
  const timeZone = input.timeZone ?? "Asia/Tokyo";
  let state: ArtState;
  let seed: number | undefined;

  if (input.kind === "genesis") {
    state = estimateGenesis(input.posts, { timeZone }).state;
  } else {
    const prev = input.previous.params;
    if (isArtState(prev)) {
      const { seed: prevSeed, ...prevState } = prev;
      state = evolveState(prevState, input.post, { timeZone });
      seed = typeof prevSeed === "number" ? prevSeed : undefined;
    } else {
      // Claude で作った古い作品の続き：新しい投稿だけから状態を作り直す
      state = estimateGenesis([input.post], { timeZone }).state;
    }
  }
  seed ??= input.did ? seedFromDid(input.did) : 1;

  return {
    artwork: {
      analysis: analysisOf(state),
      code: DRAW_CODE,
      params: { ...state, seed },
      state: { generator: "rules", style: state.style },
      // 線の画風は描くのに時間がかかるので静止画、多角形の画風はアニメーション
      animated: state.style !== "lines",
      aspectRatio: { width: 1, height: 1 },
    },
    model: RULES_MODEL,
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };
}
