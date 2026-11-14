import type { ArtworkRecord } from "../src/generation/record.ts";

/**
 * 作品レコードを確認するための単体 HTML。packages/renderer ができるまでの仮のもの。
 * 作品のコードは sandbox 付きの iframe（別オリジン扱い）で動かす。
 */
export function renderPreviewHtml(record: ArtworkRecord): string {
  const runner = `<!doctype html><meta charset="utf-8">
<style>html,body{margin:0;height:100%;display:grid;place-items:center;background:#111}canvas{max-width:100%;max-height:100%}</style>
<canvas id="c"></canvas>
<script>
const record = ${JSON.stringify(record).replace(/</g, "\\u003c")};
function mulberry32(a){return function(){a|=0;a=a+0x6D2B79F5|0;let t=Math.imul(a^a>>>15,1|a);t=t+Math.imul(t^t>>>7,61|t)^t;return((t^t>>>14)>>>0)/4294967296}}
const source = record.code.replace(/export\\s+default\\s+function/, "return function");
const draw = new Function(source)();
const base = 800;
const r = record.aspectRatio;
const canvas = document.getElementById("c");
canvas.width = r.width >= r.height ? base : Math.round(base * r.width / r.height);
canvas.height = r.height > r.width ? base : Math.round(base * r.height / r.width);
const ctx = canvas.getContext("2d");
const env = { width: canvas.width, height: canvas.height, params: record.params ?? {}, random: mulberry32(record.seed), frame: 0, time: 0 };
if (record.renderer.animated) {
  const start = performance.now();
  const tick = () => { env.time = (performance.now() - start) / 1000; draw(ctx, env); env.frame++; requestAnimationFrame(tick); };
  tick();
} else {
  draw(ctx, env);
}
</script>`;
  const escaped = runner.replace(/&/g, "&amp;").replace(/"/g, "&quot;");
  const title = (record.title ?? "untitled").replace(/</g, "&lt;");
  return `<!doctype html>
<html lang="ja">
<meta charset="utf-8">
<title>${title}</title>
<style>body{margin:0;background:#111;color:#ddd;font-family:sans-serif}h1{font-size:16px;font-weight:normal;margin:12px 16px}iframe{border:0;width:100vw;height:calc(100vh - 48px)}</style>
<h1>${title}（${record.kind} / seed ${record.seed}）</h1>
<iframe sandbox="allow-scripts" srcdoc="${escaped}"></iframe>
</html>
`;
}
