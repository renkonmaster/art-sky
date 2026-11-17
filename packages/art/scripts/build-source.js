// draw.js のソースを文字列として書き出す（src/draw-source.js）。
// 作品レコードの code に入れるため。ファイルを読まずに import できるので、Cloudflare Workers でも使える。
//   node scripts/build-source.js         書き出す
//   node scripts/build-source.js --check ずれていたら失敗する（テスト用）
import { readFileSync, writeFileSync } from "node:fs";

const src = readFileSync(new URL("../src/draw.js", import.meta.url), "utf8");
const out = `// 自動生成（scripts/build-source.js）。draw.js を変えたら pnpm --filter @art-sky/art build:source を実行する。\nexport default ${JSON.stringify(src)};\n`;
const target = new URL("../src/draw-source.js", import.meta.url);
if (process.argv.includes("--check")) {
  let current = "";
  try {
    current = readFileSync(target, "utf8");
  } catch {}
  if (current !== out) {
    console.error("src/draw-source.js が draw.js と合っていません。pnpm --filter @art-sky/art build:source を実行してください");
    process.exit(1);
  }
} else {
  writeFileSync(target, out);
}
