import { describe, expect, it } from "vitest";
import { buildSrcdoc, canvasSize, mulberry32 } from "./index.ts";

describe("mulberry32", () => {
  it("同じ seed なら同じ列になる", () => {
    const a = mulberry32(42);
    const b = mulberry32(42);
    const xs = Array.from({ length: 5 }, () => a());
    expect(Array.from({ length: 5 }, () => b())).toEqual(xs);
    expect(xs.every((x) => x >= 0 && x < 1)).toBe(true);
  });

  it("値が変わらない（描画環境 v1 の仕様として固定）", () => {
    const r = mulberry32(1);
    expect([r(), r()]).toEqual([0.6270739405881613, 0.002735721180215478]);
  });
});

describe("canvasSize", () => {
  it("長辺を renderSize に合わせる", () => {
    expect(canvasSize({ width: 16, height: 9 }, 720)).toEqual({ width: 720, height: 405 });
    expect(canvasSize({ width: 4, height: 5 }, 720)).toEqual({ width: 576, height: 720 });
    expect(canvasSize({ width: 0, height: 5 }, 720)).toEqual({ width: 720, height: 720 });
  });
});

describe("buildSrcdoc", () => {
  it("コード中の </script> で HTML が壊れない", () => {
    const html = buildSrcdoc(
      {
        code: 'export default function draw() { const s = "</script><script>alert(1)</script>"; }',
        seed: 1,
        aspectRatio: { width: 1, height: 1 },
        renderer: {},
      },
      { id: "x" },
    );
    expect(html.match(/<script>/g)).toHaveLength(1);
    expect(html.match(/<\/script>/g)).toHaveLength(1);
    expect(html).toContain("default-src 'none'");
  });
});
