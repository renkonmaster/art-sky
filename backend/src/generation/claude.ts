import Anthropic from "@anthropic-ai/sdk";
import { betaZodOutputFormat } from "@anthropic-ai/sdk/helpers/beta/zod";
import { z } from "zod";
import type { ClaudeConfig } from "../config.ts";
import { buildUserMessage, SYSTEM_PROMPT } from "./prompt.ts";
import {
  EMOTIONS,
  TRAITS,
  type Analysis,
  type Emotion,
  type GeneratedArtwork,
  type GenerationInput,
  type GenerationResult,
} from "./types.ts";

/**
 * 感情と個性の推定。値の範囲は構造化出力のスキーマでは縛らず、受け取ってから丸める
 * （toAnalysis）。
 */
const AnalysisOutput = z.object({
  valence: z.number().int(),
  arousal: z.number().int(),
  dominant: z.enum(EMOTIONS),
  mix: z.object({
    joy: z.number().int(),
    calm: z.number().int(),
    excitement: z.number().int(),
    nostalgia: z.number().int(),
    sadness: z.number().int(),
    anxiety: z.number().int(),
    anger: z.number().int(),
    neutral: z.number().int(),
  }),
  personality: z.object({
    openness: z.number().int(),
    conscientiousness: z.number().int(),
    extraversion: z.number().int(),
    agreeableness: z.number().int(),
    neuroticism: z.number().int(),
  }),
});

/** Claude に返させる形。params と state は中身が自由なので JSON 文字列で受け取る。 */
const ModelOutput = z.object({
  analysis: AnalysisOutput,
  title: z.string(),
  code: z.string(),
  paramsJson: z.string(),
  stateJson: z.string(),
  animated: z.boolean(),
  aspectRatio: z.object({
    width: z.number().int(),
    height: z.number().int(),
  }),
});
type ModelOutput = z.infer<typeof ModelOutput>;

/** Lexicon の code の上限（UTF-8 バイト数）。 */
const MAX_CODE_BYTES = 65536;

/** Claude が拒否した、または出力が使えなかった。同じ入力で再試行しても直らない可能性が高い。 */
export class GenerationError extends Error {
  readonly reason: "refusal" | "max_tokens" | "invalid_output";
  constructor(reason: GenerationError["reason"], message: string) {
    super(message);
    this.name = "GenerationError";
    this.reason = reason;
  }
}

function parseJsonObject(text: string, field: string): Record<string, unknown> {
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    throw new GenerationError("invalid_output", `${field} が JSON として読めません`);
  }
  if (typeof value !== "object" || value === null || Array.isArray(value)) {
    throw new GenerationError("invalid_output", `${field} が JSON オブジェクトではありません`);
  }
  return value as Record<string, unknown>;
}

/** state のうち、生成側が書き込むキー。Claude が同じキーを返しても上書きする。 */
export const RESERVED_STATE_KEYS = ["analysis", "features"] as const;

const clampInt = (v: number, min: number, max: number) => Math.round(Math.min(max, Math.max(min, v)));

/** 範囲外の値を丸め、感情の割合を合計 1000 にそろえる。 */
export function toAnalysis(raw: z.infer<typeof AnalysisOutput>): Analysis {
  const mix = Object.fromEntries(EMOTIONS.map((e) => [e, clampInt(raw.mix[e], 0, 1000)])) as Record<Emotion, number>;
  const sum = EMOTIONS.reduce((a, e) => a + mix[e], 0);
  if (sum === 0) {
    mix.neutral = 1000;
  } else {
    for (const e of EMOTIONS) mix[e] = Math.round((mix[e] * 1000) / sum);
    // 丸め誤差は最も大きい感情で吸収する
    const top = EMOTIONS.reduce((a, b) => (mix[b] > mix[a] ? b : a));
    mix[top] += 1000 - EMOTIONS.reduce((a, e) => a + mix[e], 0);
  }
  return {
    valence: clampInt(raw.valence, -1000, 1000),
    arousal: clampInt(raw.arousal, 0, 1000),
    dominant: raw.dominant,
    mix,
    personality: Object.fromEntries(TRAITS.map((t) => [t, clampInt(raw.personality[t], 0, 1000)])) as Analysis["personality"],
  };
}

/**
 * AT Protocol のデータモデルは小数を扱えず、小数を含むレコードは PDS に拒否される。
 * 保存前に見つけて、作り直しの対象にする。
 */
function assertNoFloats(value: unknown, path: string): void {
  if (typeof value === "number") {
    if (!Number.isInteger(value)) {
      throw new GenerationError("invalid_output", `${path} に小数 ${value} があります（整数だけが使えます）`);
    }
  } else if (Array.isArray(value)) {
    value.forEach((v, i) => assertNoFloats(v, `${path}[${i}]`));
  } else if (typeof value === "object" && value !== null) {
    for (const [k, v] of Object.entries(value)) assertNoFloats(v, `${path}.${k}`);
  }
}

/** モデルの出力を、レコードに入れられる形に変換して基本的な検査をする。 */
export function toGeneratedArtwork(output: ModelOutput): GeneratedArtwork {
  if (!/export\s+default\s+function/.test(output.code)) {
    throw new GenerationError("invalid_output", "code に export default function がありません");
  }
  if (new TextEncoder().encode(output.code).length > MAX_CODE_BYTES) {
    throw new GenerationError("invalid_output", `code が ${MAX_CODE_BYTES} バイトを超えています`);
  }
  const { width, height } = output.aspectRatio;
  if (width < 1 || height < 1) {
    throw new GenerationError("invalid_output", `aspectRatio が不正です: ${width}:${height}`);
  }
  const params = parseJsonObject(output.paramsJson, "paramsJson");
  const state = parseJsonObject(output.stateJson, "stateJson");
  assertNoFloats(params, "params");
  assertNoFloats(state, "state");
  for (const key of RESERVED_STATE_KEYS) delete state[key];
  return {
    title: output.title.trim(),
    analysis: toAnalysis(output.analysis),
    code: output.code,
    params,
    state,
    animated: output.animated,
    aspectRatio: { width, height },
  };
}

/**
 * 投稿と前作品から、描画関数を Claude に生成させる。
 *
 * - API エラー（429、5xx、接続エラーなど）は SDK が 2 回まで再試行したうえで、
 *   Anthropic.APIError のサブクラスとしてそのまま投げる。ジョブ側で再試行するか判断する。
 * - 拒否や使えない出力は GenerationError を投げる。
 */
export async function generateArtwork(
  input: GenerationInput,
  config: ClaudeConfig,
  client: Anthropic = new Anthropic(),
): Promise<GenerationResult> {
  const stream = client.beta.messages.stream({
    model: config.model,
    max_tokens: 64000,
    thinking: { type: "adaptive" },
    output_config: {
      effort: config.effort,
      format: betaZodOutputFormat(ModelOutput),
    },
    // 安全分類器に拒否されたとき、サーバー側で推奨モデルに切り替えて続ける。
    betas: ["server-side-fallback-2026-07-01"],
    fallbacks: "default",
    // システムプロンプトは毎回同じなのでキャッシュする。
    cache_control: { type: "ephemeral" },
    system: SYSTEM_PROMPT,
    messages: [{ role: "user", content: buildUserMessage(input) }],
  });
  const message = await stream.finalMessage();

  if (message.stop_reason === "refusal") {
    const category = message.stop_details?.category ?? "unknown";
    throw new GenerationError("refusal", `Claude が生成を拒否しました（category: ${category}）`);
  }
  if (message.stop_reason === "max_tokens") {
    throw new GenerationError("max_tokens", "出力が max_tokens に達して途中で切れました");
  }
  if (!message.parsed_output) {
    throw new GenerationError("invalid_output", "出力を指定した形式として読めませんでした");
  }

  return {
    artwork: toGeneratedArtwork(message.parsed_output),
    model: message.model,
    usage: {
      inputTokens: message.usage.input_tokens,
      outputTokens: message.usage.output_tokens,
      cacheReadInputTokens: message.usage.cache_read_input_tokens ?? 0,
    },
  };
}
