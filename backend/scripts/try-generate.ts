/**
 * Claude API で作品を 1 つ生成し、レコードとプレビュー HTML を out/ に書き出す（PDS には保存しない）。
 *
 *   pnpm try:generate                       初回（genesis）の作品を作る
 *   pnpm try:generate out/<dir>/record.json その作品の次（evolution）を作る
 *
 * 実際に Claude API を呼ぶので料金がかかる。
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import path from "node:path";
import { loadClaudeConfig } from "../src/config.ts";
import { computeFeatures } from "../src/features/stats.ts";
import { generateArtwork } from "../src/generation/claude.ts";
import { buildArtworkRecord, type ArtworkRecord, type RecordRefs } from "../src/generation/record.ts";
import type { GenerationInput, ProfileStats, SourcePost } from "../src/generation/types.ts";
import { renderPreviewHtml } from "./preview-html.ts";

interface Fixture {
  profile: ProfileStats;
  posts: SourcePost[];
  newPost: SourcePost;
}

const fixture: Fixture = JSON.parse(readFileSync("fixtures/sample-input.json", "utf8"));
const previousPath = process.argv[2];

let input: GenerationInput;
let refs: RecordRefs;
if (previousPath) {
  const prev: ArtworkRecord = JSON.parse(readFileSync(previousPath, "utf8"));
  input = {
    kind: "evolution",
    post: fixture.newPost,
    profile: { ...fixture.profile, postsCount: (fixture.profile.postsCount ?? 0) + 1 },
    previous: {
      title: prev.title,
      code: prev.code,
      params: prev.params,
      state: prev.state,
      animated: prev.renderer.animated,
      aspectRatio: prev.aspectRatio,
    },
  };
  // ローカル試行用のダミー参照。本番では投稿と前作品の実際の URI と CID を入れる。
  const dummyCid = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
  refs = {
    kind: "evolution",
    trigger: { uri: "at://did:plc:example/app.bsky.feed.post/3m5example2a", cid: dummyCid },
    previous: { uri: "at://did:plc:example/com.example.artsky.artwork/3m4example2a", cid: dummyCid },
  };
} else {
  input = { kind: "genesis", posts: fixture.posts, profile: fixture.profile, features: computeFeatures(fixture.posts) };
  refs = { kind: "genesis" };
}

const config = loadClaudeConfig();
console.log(`${input.kind} を生成中（${config.model}, effort: ${config.effort}）...`);
const started = Date.now();
const result = await generateArtwork(input, config);
const record = buildArtworkRecord(input, result, refs);

const outDir = path.join("out", `${new Date().toISOString().replace(/[:.]/g, "-")}-${input.kind}`);
mkdirSync(outDir, { recursive: true });
writeFileSync(path.join(outDir, "record.json"), `${JSON.stringify(record, null, 2)}\n`);
writeFileSync(path.join(outDir, "preview.html"), renderPreviewHtml(record));

console.log(`タイトル: ${record.title ?? "(なし)"}`);
console.log(`モデル: ${result.model} / ${((Date.now() - started) / 1000).toFixed(1)} 秒`);
console.log(
  `トークン: 入力 ${result.usage.inputTokens}（キャッシュ ${result.usage.cacheReadInputTokens}）, 出力 ${result.usage.outputTokens}`,
);
console.log(`書き出し先: ${path.resolve(outDir)}`);
