/**
 * AI なしの生成を、本番と同じ Chromium の検証に通して確かめる。
 * 3 つの画風（線・区画・軌道）になる投稿をそれぞれ作り、genesis → evolution の順に検証する。
 *   node scripts/try-rules.ts [出力先ディレクトリ]
 */
import { mkdirSync, writeFileSync } from "node:fs";
import { buildArtworkRecord } from "../src/generation/record.ts";
import { generateWithoutAi } from "../src/generation/rules.ts";
import type { GenesisInput } from "../src/generation/types.ts";
import { createChromiumValidator } from "../src/validation/chromium.ts";

const out = process.argv[2];
if (out) mkdirSync(out, { recursive: true });
const now = Date.parse("2026-11-17T12:00:00Z");
const posts = (texts: string[], hours: number) =>
  Array.from({ length: 60 }, (_, i) => ({ text: texts[i % texts.length]!, createdAt: new Date(now - i * hours * 3600e3).toISOString() }));
const people: Record<string, GenesisInput["posts"]> = {
  calm: posts(["コーヒー飲んでのんびり☕", "懐かしい曲を聴いてる", "散歩してきた"], 10),
  lively: posts(["最高！！楽しい🎉", "ワクワクする！！", "すごい！！🔥"], 0.5),
  mixed: posts(["ラーメン食べた", "今日は雨", "嬉しい！", "ちょっと不安"], 8),
};
const profile = {};
const features = { postsAnalyzed: 0 } as GenesisInput["features"];

const validator = createChromiumValidator();
try {
  for (const [name, list] of Object.entries(people)) {
    const did = `did:plc:${name}`;
    const g = generateWithoutAi({ kind: "genesis", did, posts: list, profile, features });
    const genesis = buildArtworkRecord({ kind: "genesis", did, posts: list, profile, features }, g, { kind: "genesis" }, { seed: g.artwork.params.seed as number });
    let t = Date.now();
    await validator.validate(genesis);
    console.log(`${name.padEnd(7)} 画風=${String(g.artwork.params.style).padEnd(5)} animated=${genesis.renderer.animated} genesis の検証 OK (${Date.now() - t}ms)`);

    const post = { text: "今日のライブ最高だった！！ありがとう🎉", createdAt: new Date(now + 3600e3).toISOString() };
    const previous = { code: genesis.code, params: genesis.params, state: genesis.state, animated: genesis.renderer.animated, aspectRatio: genesis.aspectRatio };
    const e = generateWithoutAi({ kind: "evolution", did, post, previous, profile });
    const ref = { uri: "at://x/y/z", cid: "bafy" };
    const evolution = buildArtworkRecord({ kind: "evolution", did, post, previous, profile }, e, { kind: "evolution", trigger: ref, previous: ref }, { seed: e.artwork.params.seed as number });
    t = Date.now();
    await validator.validate(evolution);
    const joy = (r: typeof genesis) => (r.params as { mix: { joy: number } }).mix.joy;
    console.log(`${"".padEnd(7)} evolution の検証 OK (${Date.now() - t}ms)  喜び ${joy(genesis)}‰ → ${joy(evolution)}‰、画風=${String(e.artwork.params.style)}`);
    if (out) writeFileSync(`${out}/${name}.json`, JSON.stringify(evolution, null, 1));
  }
} finally {
  await validator.close();
}
