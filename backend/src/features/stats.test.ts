import { describe, expect, it } from "vitest";
import { computeFeatures } from "./stats.ts";

describe("computeFeatures", () => {
  it("投稿がなくても値を返す", () => {
    const f = computeFeatures([]);
    expect(f.postsAnalyzed).toBe(0);
    expect(f.hourHistogram).toHaveLength(24);
  });

  it("23 時と 1 時の投稿のピークは 0 時になる（円周平均）", () => {
    const f = computeFeatures(
      [
        { text: "a", createdAt: "2026-11-13T23:00:00Z" },
        { text: "b", createdAt: "2026-11-14T01:00:00Z" },
      ],
      { timeZone: "UTC" },
    );
    expect(f.peakMinute).toBe(0);
  });

  it("すべての値が整数（PDS に保存できる）", () => {
    const f = computeFeatures(
      [
        { text: "今日はいい天気！😀 https://example.com", createdAt: "2026-11-13T08:10:00Z", likeCount: 3, langs: ["ja"] },
        { text: "眠れない？", createdAt: "2026-11-12T15:20:00Z", likeCount: 0, hasMedia: true },
        { text: "雨", createdAt: "2026-11-10T03:00:00Z" },
      ],
      { timeZone: "Asia/Tokyo" },
    );
    for (const v of Object.values(f).flat()) expect(Number.isInteger(v)).toBe(true);
    expect(f.exclaim).toBe(333);
    expect(f.link).toBe(333);
    expect(f.langCount).toBe(1);
  });
});
