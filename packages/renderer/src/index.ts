/**
 * 描画環境 canvas2d バージョン 1（docs/lexicon.md）。
 *
 * 作品のコードは信頼できない入力なので、次の 3 重の囲いの中で動かす。
 *   1. sandbox="allow-scripts" の iframe … ページ本体とは別オリジンになり、Cookie や DOM に触れない
 *   2. CSP（default-src 'none'）… 外部と通信できない
 *   3. Web Worker … 無限ループしても画面が固まらず、外から止められる
 *
 * このパッケージは iframe に入れる HTML（srcdoc）を組み立てるだけで、DOM には触れない。
 * ブラウザでもサーバー（生成時の検証）でも同じ HTML を使う。
 */

/** 描画に必要な、作品レコードの一部。 */
export interface RenderableArtwork {
  code: string;
  params?: Record<string, unknown> | undefined;
  seed: number;
  aspectRatio: { width: number; height: number };
  renderer: { animated?: boolean | undefined };
}

export interface RenderOptions {
  /** 親ページがメッセージを見分けるための ID。 */
  id: string;
  /** キャンバスの長辺の画素数。既定 720。 */
  renderSize?: number;
  /** 静止画を描き終えたら PNG を親ページに渡す。既定 false。 */
  snapshot?: boolean;
  /** コードの読み込みと 1 回の描画に許す時間（ミリ秒）。超えたら止める。既定 5000。 */
  drawTimeoutMs?: number;
}

/** iframe から親ページへ postMessage で送るメッセージ。 */
export type RendererMessage =
  | { source: "artsky-renderer"; id: string; type: "rendered"; blob: Blob | null }
  | { source: "artsky-renderer"; id: string; type: "error"; message: string };

export const RENDERER_MESSAGE_SOURCE = "artsky-renderer";

export function isRendererMessage(data: unknown): data is RendererMessage {
  return (
    typeof data === "object" &&
    data !== null &&
    (data as { source?: unknown }).source === RENDERER_MESSAGE_SOURCE &&
    typeof (data as { id?: unknown }).id === "string"
  );
}

/** seed から決まる [0, 1) の疑似乱数。env.random() の実体。 */
export function mulberry32(seed: number): () => number {
  let a = seed;
  return () => {
    a |= 0;
    a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}

/** 縦横比と長辺の画素数から、キャンバスの大きさを決める。 */
export function canvasSize(
  aspectRatio: { width: number; height: number },
  renderSize: number,
): { width: number; height: number } {
  const { width, height } = aspectRatio;
  if (!(width > 0) || !(height > 0)) return { width: renderSize, height: renderSize };
  return width >= height
    ? { width: renderSize, height: Math.max(1, Math.round((renderSize * height) / width)) }
    : { width: Math.max(1, Math.round((renderSize * width) / height)), height: renderSize };
}

/** Worker の中で動くスクリプト。作品のコードを読み込んで描画する。 */
const WORKER_SOURCE = `
const mulberry32 = ${mulberry32.toString()};
const post = (m) => self.postMessage(m);
self.onmessage = async (e) => {
  const { canvas, codeUrl, seed, params, animated, snapshot } = e.data;
  try {
    post({ type: "begin" });
    const mod = await import(codeUrl);
    const draw = mod.default;
    if (typeof draw !== "function") throw new Error("default export is not a function");
    const ctx = canvas.getContext("2d");
    const env = { width: canvas.width, height: canvas.height, params, random: mulberry32(seed), frame: 0, time: 0 };
    if (!animated) {
      draw(ctx, env);
      const blob = snapshot ? await canvas.convertToBlob({ type: "image/png" }) : null;
      post({ type: "frame", frame: 0, blob });
      return;
    }
    const raf = self.requestAnimationFrame
      ? (f) => self.requestAnimationFrame(f)
      : (f) => setTimeout(() => f(performance.now()), 16);
    let start = null;
    const tick = (now) => {
      if (start === null) start = now;
      env.time = (now - start) / 1000;
      post({ type: "begin" });
      try {
        draw(ctx, env);
      } catch (err) {
        post({ type: "error", message: String((err && err.message) || err) });
        return;
      }
      post({ type: "frame", frame: env.frame, blob: null });
      env.frame++;
      raf(tick);
    };
    draw(ctx, env);
    post({ type: "frame", frame: env.frame, blob: null });
    env.frame++;
    raf(tick);
  } catch (err) {
    post({ type: "error", message: String((err && err.message) || err) });
  }
};
`;

/** iframe の中（Worker の外）で動くスクリプト。Worker を起動して見張る。 */
const HOST_SOURCE = `
const canvas = document.getElementById("c");
canvas.width = cfg.width;
canvas.height = cfg.height;
const report = (m) => parent.postMessage({ source: "${RENDERER_MESSAGE_SOURCE}", id: cfg.id, ...m }, "*");
let worker = null;
let timer = 0;
let failed = false;
const fail = (message) => {
  if (failed) return;
  failed = true;
  clearTimeout(timer);
  if (worker) worker.terminate();
  report({ type: "error", message });
};
try {
  const blobUrl = (text) => URL.createObjectURL(new Blob([text], { type: "text/javascript" }));
  // sandbox の中（オリジンなし）では module 型の Worker を blob から起動できないので、通常の Worker を使う。
  // 作品のコード（ES モジュール）は Worker の中で import() して読み込む。
  worker = new Worker(blobUrl(cfg.workerSource));
  worker.onerror = (e) => fail(e.message || "worker error");
  worker.onmessage = (e) => {
    const m = e.data;
    if (m.type === "begin") {
      // 描画が始まったら時間を計る。終わらなければ無限ループとみなして止める。
      clearTimeout(timer);
      timer = setTimeout(() => fail("timeout"), cfg.drawTimeoutMs);
    } else if (m.type === "frame") {
      clearTimeout(timer);
      if (m.frame === 0) report({ type: "rendered", blob: m.blob });
    } else if (m.type === "error") {
      fail(m.message);
    }
  };
  const offscreen = canvas.transferControlToOffscreen();
  worker.postMessage(
    { canvas: offscreen, codeUrl: blobUrl(cfg.code), seed: cfg.seed, params: cfg.params, animated: cfg.animated, snapshot: cfg.snapshot },
    [offscreen],
  );
} catch (err) {
  fail(String((err && err.message) || err));
}
`;

/** 外部通信をすべて禁じ、インラインのスクリプトと blob: の Worker だけを許す。 */
const CSP = "default-src 'none'; script-src 'unsafe-inline' blob:; worker-src blob:; style-src 'unsafe-inline'";

/** <script> の中に安全に埋め込める JSON にする（"</script>" で途切れないようにする）。 */
function scriptJson(value: unknown): string {
  return JSON.stringify(value)
    .replace(/</g, "\\u003c")
    .replace(/\u2028/g, "\\u2028")
    .replace(/\u2029/g, "\\u2029");
}

/**
 * 作品を描画する iframe 用の HTML を組み立てる。
 * 使う側は <iframe sandbox="allow-scripts" srcdoc={...}> に入れる。
 * allow-same-origin は付けないこと（付けると囲いが外れる）。
 */
export function buildSrcdoc(artwork: RenderableArtwork, options: RenderOptions): string {
  const size = canvasSize(artwork.aspectRatio, options.renderSize ?? 720);
  const cfg = {
    id: options.id,
    code: artwork.code,
    params: artwork.params ?? {},
    seed: artwork.seed,
    animated: artwork.renderer.animated === true,
    snapshot: options.snapshot === true,
    drawTimeoutMs: options.drawTimeoutMs ?? 5000,
    width: size.width,
    height: size.height,
    workerSource: WORKER_SOURCE,
  };
  return `<!doctype html>
<meta charset="utf-8">
<meta http-equiv="Content-Security-Policy" content="${CSP}">
<style>html,body{margin:0;height:100%;overflow:hidden;background:transparent}canvas{display:block;width:100%;height:100%}</style>
<canvas id="c"></canvas>
<script>
const cfg = ${scriptJson(cfg)};
${HOST_SOURCE}
</script>`;
}
