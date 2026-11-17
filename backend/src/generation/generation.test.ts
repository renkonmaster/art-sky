import { describe, expect, it } from "vitest";
import { computeFeatures } from "../features/stats.ts";
import { buildArtworkRecord } from "./record.ts";
import { DRAW_CODE, generateWithoutAi, seedFromDid } from "./rules.ts";
import type { GeneratedArtwork, GenerationResult } from "./types.ts";

const analysis = {
  valence: 400,
  arousal: 300,
  dominant: "calm" as const,
  mix: { joy: 200, calm: 500, excitement: 0, nostalgia: 300, sadness: 0, anxiety: 0, anger: 0, neutral: 0 },
  personality: { openness: 500, conscientiousness: 500, extraversion: 500, agreeableness: 500, neuroticism: 500 },
};

const artwork: GeneratedArtwork = {
  analysis,
  code: "export default function draw(ctx, env) { ctx.fillRect(0, 0, env.width, env.height); }",
  params: { hue: 200 },
  state: { pieces: 1 },
  animated: false,
  aspectRatio: { width: 1, height: 1 },
};

const features = computeFeatures([]);

/** 値に小数が含まれていないか（AT Protocol は小数を扱えない） */
function hasFloat(v: unknown): boolean {
  if (typeof v === "number") return !Number.isInteger(v);
  if (Array.isArray(v)) return v.some(hasFloat);
  if (v && typeof v === "object") return Object.values(v).some(hasFloat);
  return false;
}

describe("generateWithoutAi", () => {
  const posts = [
    { text: "今日はめっちゃ楽しかった！！", createdAt: "2026-11-14T12:00:00.000Z" },
    { text: "静かな朝。コーヒーがおいしい", createdAt: "2026-11-13T23:00:00.000Z" },
    { text: "I'm so tired and sad today", createdAt: "2026-11-13T15:00:00.000Z", langs: ["en"] },
  ];

  it("genesis：共通の描画モジュールと、DID から作ったシードを使う", () => {
    const { artwork: art } = generateWithoutAi({ kind: "genesis", did: "did:plc:alice", posts, profile: {}, features: computeFeatures(posts) });
    expect(art.code).toBe(DRAW_CODE);
    expect(art.params.seed).toBe(seedFromDid("did:plc:alice"));
    expect(["lines", "poly", "orbit"]).toContain(art.params.style);
    expect(art.animated).toBe(art.params.style !== "lines");
    expect(Object.values(art.analysis.mix).reduce((a, b) => a + b, 0)).toBeGreaterThan(990);
    expect(hasFloat(art)).toBe(false);
  });

  it("evolution：前の状態から少しだけ動かし、シードと画風を引き継ぐ", () => {
    const first = generateWithoutAi({ kind: "genesis", did: "did:plc:alice", posts, profile: {}, features: computeFeatures(posts) }).artwork;
    const next = generateWithoutAi({
      kind: "evolution",
      did: "did:plc:bob",
      post: { text: "最悪、腹が立つ!!", createdAt: "2026-11-15T12:00:00.000Z" },
      profile: {},
      previous: first,
    }).artwork;
    expect(next.params.seed).toBe(first.params.seed);
    expect(next.params.style).toBe(first.params.style);
    expect(next.params.mix).not.toEqual(first.params.mix);
    expect(hasFloat(next)).toBe(false);
  });

  it("形式の違う前作品からでも作り直せる", () => {
    const { artwork: art } = generateWithoutAi({
      kind: "evolution",
      did: "did:plc:alice",
      post: { text: "hello", createdAt: "2026-11-15T12:00:00.000Z" },
      profile: {},
      previous: artwork,
    });
    expect(art.params.seed).toBe(seedFromDid("did:plc:alice"));
    expect(hasFloat(art)).toBe(false);
  });
});

describe("buildArtworkRecord", () => {
  const result: GenerationResult = {
    artwork,
    model: "artsky-rules-1",
    usage: { inputTokens: 0, outputTokens: 0, cacheReadInputTokens: 0 },
  };

  it("genesis レコードを作る", () => {
    const record = buildArtworkRecord(
      {
        kind: "genesis",
        posts: [
          { text: "a", createdAt: "2026-11-02T00:00:00.000Z" },
          { text: "b", createdAt: "2026-11-01T00:00:00.000Z" },
        ],
        profile: {},
        features,
      },
      result,
      { kind: "genesis" },
      { seed: 42, now: new Date("2026-11-14T00:00:00.000Z") },
    );
    expect(record).toMatchObject({
      kind: "genesis",
      seed: 42,
      renderer: { runtime: "canvas2d", version: "1", animated: false },
      inputs: { postsSampled: 2, oldestPostAt: "2026-11-01T00:00:00.000Z", newestPostAt: "2026-11-02T00:00:00.000Z" },
      state: { pieces: 1, analysis, features },
    });
    expect(record.trigger).toBeUndefined();
    expect(record).not.toHaveProperty("title");
  });

  it("evolution では前作品の features を引き継ぐ", () => {
    const ref = { uri: "at://x", cid: "y" };
    const record = buildArtworkRecord(
      {
        kind: "evolution",
        post: { text: "a", createdAt: "2026-11-14T00:00:00.000Z" },
        profile: {},
        previous: {
          code: artwork.code,
          params: {},
          state: { features, analysis },
          animated: false,
          aspectRatio: { width: 1, height: 1 },
        },
      },
      result,
      { kind: "evolution", trigger: ref, previous: ref },
    );
    expect(record.state).toMatchObject({ features, analysis });
  });

  it("入力と参照の種類が違えばエラー", () => {
    expect(() =>
      buildArtworkRecord({ kind: "genesis", posts: [], profile: {}, features }, result, {
        kind: "evolution",
        trigger: { uri: "at://x", cid: "y" },
        previous: { uri: "at://x", cid: "y" },
      }),
    ).toThrow();
  });
});
