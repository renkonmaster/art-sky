import { afterAll, describe, expect, it } from "vitest";
import { createChromiumValidator } from "./chromium.ts";

/** 実際の Chromium を使う。入っていない環境では飛ばす（pnpm exec playwright install chromium）。 */
const available = await (async () => {
  try {
    const { chromium } = await import("playwright");
    const browser = await chromium.launch();
    await browser.close();
    return true;
  } catch {
    return false;
  }
})();

const artwork = (code: string, animated = false) => ({
  code,
  params: { hue: 200 },
  seed: 42,
  aspectRatio: { width: 4, height: 3 },
  renderer: { animated },
});

describe.skipIf(!available)("Chromium での検証", () => {
  const validator = createChromiumValidator();
  afterAll(() => validator.close());

  it("正しい作品は通る", async () => {
    await validator.validate(
      artwork(`export default function draw(ctx, env) {
        ctx.fillStyle = "#123"; ctx.fillRect(0, 0, env.width, env.height);
        ctx.fillStyle = "hsl(" + env.params.hue + " 80% 60%)";
        for (let i = 0; i < 20; i++) ctx.fillRect(env.random() * env.width, env.random() * env.height, 20, 20);
      }`),
    );
  }, 30_000);

  it("アニメーション作品も、決まったフレームの絵で確かめる", async () => {
    await validator.validate(
      artwork(
        `export default function draw(ctx, env) {
          ctx.fillStyle = "#000"; ctx.fillRect(0, 0, env.width, env.height);
          ctx.fillStyle = "#fff"; ctx.fillRect(env.time * 40, 10, 30, 30);
        }`,
        true,
      ),
    );
  }, 30_000);

  it.each([
    ["例外を出す", `export default function draw() { throw new Error("boom"); }`, /実行できません.*boom/],
    ["構文エラー", `export default function draw( {`, /実行できません/],
    ["何も描かない", `export default function draw() {}`, /何も描きません/],
    [
      "Math.random を使う",
      `export default function draw(ctx, env) {
        ctx.fillStyle = "#000"; ctx.fillRect(0, 0, env.width, env.height);
        ctx.fillStyle = "#fff"; ctx.fillRect(Math.random() * env.width, Math.random() * env.height, 50, 50);
      }`,
      /同じ絵になりません/,
    ],
    ["無限ループ", `export default function draw() { for (;;) {} }`, /実行できません/],
  ])("%s 作品は validation_failed", async (_, code, message) => {
    await expect(validator.validate(artwork(code))).rejects.toMatchObject({ code: "validation_failed", message });
  }, 30_000);

  it("外部と通信できない", async () => {
    // fetch は CSP で止まり、描画自体が失敗する。
    await expect(
      validator.validate(artwork(`export default async function draw(ctx) { await fetch("https://example.com/"); ctx.fillRect(0, 0, 9, 9); }`)),
    ).rejects.toMatchObject({ code: "validation_failed" });
  }, 30_000);
});
