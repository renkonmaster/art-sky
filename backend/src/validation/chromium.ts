/**
 * 生成した描画関数を、PDS に保存する前に実際のブラウザで動かして確かめる
 * （docs/tech-stack.md「検証の内容」）。
 *
 * ギャラリーと同じ描画環境（@art-sky/renderer）を、ヘッドレスの Chromium で使う。確かめること：
 *   1. 例外を出さずに、制限時間内に描き終わる
 *   2. 何かが描かれている（1 色だけではない）
 *   3. 同じ seed で 2 回描くと、同じ絵になる（Math.random などを使っていない）
 *
 * アニメーション作品は、決まったフレームまで進めた絵で確かめる（renderer の snapshot 機能）。
 */
import { buildSrcdoc, type RenderableArtwork } from "@art-sky/renderer";
import type { Browser } from "playwright";
import { JobError } from "../jobs/runner.ts";

/** 1 回の描画を待つ時間。renderer 自身の打ち切り（5 秒）より少し長くする。 */
const RENDER_TIMEOUT_MS = 12_000;
const RENDER_SIZE = 480;

interface RenderResult {
  ok: boolean;
  message?: string;
  /** 絵の内容から計算した値。2 回の描画が同じ絵かどうかを比べる。 */
  hash?: string;
  /** 使われている色の数（多すぎるときは打ち切る）。 */
  colors?: number;
}

/** ページの中で動く：iframe で作品を描き、返ってきた PNG を調べる。 */
async function renderInPage(srcdoc: string, id: string, timeoutMs: number): Promise<RenderResult> {
  const blob = await new Promise<Blob | string>((resolve) => {
    const iframe = document.createElement("iframe");
    iframe.setAttribute("sandbox", "allow-scripts");
    iframe.style.cssText = "width:320px;height:320px;border:0";
    const timer = setTimeout(() => resolve("制限時間内に描き終わりませんでした"), timeoutMs);
    window.addEventListener("message", (event) => {
      if (event.source !== iframe.contentWindow) return;
      const data = event.data as { source?: string; id?: string; type?: string; message?: string; blob?: Blob | null };
      if (data?.source !== "artsky-renderer" || data.id !== id) return;
      clearTimeout(timer);
      if (data.type === "rendered" && data.blob) resolve(data.blob);
      else resolve(data.message ?? "描画できませんでした");
    });
    iframe.srcdoc = srcdoc;
    document.body.append(iframe);
  });
  if (typeof blob === "string") return { ok: false, message: blob };

  const bitmap = await createImageBitmap(blob);
  const canvas = new OffscreenCanvas(bitmap.width, bitmap.height);
  const ctx = canvas.getContext("2d");
  if (!ctx) return { ok: false, message: "検証用のキャンバスを作れませんでした" };
  ctx.drawImage(bitmap, 0, 0);
  const pixels = ctx.getImageData(0, 0, bitmap.width, bitmap.height).data;
  const colors = new Set<number>();
  let hash = 2166136261;
  for (let i = 0; i < pixels.length; i += 4) {
    const value = ((pixels[i] ?? 0) << 16) | ((pixels[i + 1] ?? 0) << 8) | (pixels[i + 2] ?? 0);
    hash = Math.imul(hash ^ value, 16777619);
    if (colors.size < 64) colors.add(value);
  }
  return { ok: true, hash: `${bitmap.width}x${bitmap.height}:${hash >>> 0}`, colors: colors.size };
}

export interface Validator {
  validate(artwork: RenderableArtwork): Promise<void>;
  close(): Promise<void>;
}

/**
 * Chromium を使う検証器。ブラウザは最初の検証で起動し、以後は使い回す。
 * Chromium が入っていないときは、起動に失敗した理由を添えて JobError を投げる
 * （`pnpm exec playwright install chromium` で入れる）。
 */
export function createChromiumValidator(): Validator {
  let browser: Promise<Browser> | null = null;

  async function launch(): Promise<Browser> {
    const { chromium } = await import("playwright");
    return chromium.launch();
  }

  async function render(b: Browser, artwork: RenderableArtwork, id: string): Promise<RenderResult> {
    // 検証ごとに新しいコンテキストを使い、前の作品の影響を受けないようにする。外部通信は止める。
    const context = await b.newContext({ offline: true });
    try {
      const page = await context.newPage();
      await page.setContent("<!doctype html><title>validate</title><body></body>");
      const srcdoc = buildSrcdoc(artwork, { id, renderSize: RENDER_SIZE, snapshot: true });
      return await page.evaluate(
        ([fn, doc, frameId, timeout]) => (new Function(`return (${fn})`)() as typeof renderInPage)(doc, frameId, timeout),
        [renderInPage.toString(), srcdoc, id, RENDER_TIMEOUT_MS] as const,
      );
    } finally {
      await context.close();
    }
  }

  return {
    async validate(artwork) {
      let b: Browser;
      try {
        browser ??= launch();
        b = await browser;
      } catch (err) {
        browser = null;
        throw new JobError(
          `検証用のブラウザを起動できませんでした（pnpm exec playwright install chromium を実行してください）: ${(err as Error).message}`,
          "internal",
        );
      }
      const first = await render(b, artwork, "v1");
      if (!first.ok) throw new JobError(`生成したコードを実行できませんでした: ${first.message}`, "validation_failed");
      if ((first.colors ?? 0) < 2) throw new JobError("生成したコードが何も描きませんでした", "validation_failed");
      const second = await render(b, artwork, "v2");
      if (!second.ok) throw new JobError(`生成したコードを実行できませんでした: ${second.message}`, "validation_failed");
      if (second.hash !== first.hash) {
        throw new JobError("同じ seed で描いても同じ絵になりません（乱数や時刻を直接使っています）", "validation_failed");
      }
    },
    async close() {
      const b = await browser?.catch(() => null);
      browser = null;
      await b?.close();
    },
  };
}
