import { readdirSync, readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
import { Lexicons } from "@atproto/lexicon";
import { describe, expect, it } from "vitest";
import {
  ArtworkRecord,
  GetArtworkOutput,
  ListByActorOutput,
  ListLatestOutput,
  LoginQuery,
  UpdateSettingsRequest,
} from "./index.ts";

const lexDir = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../../../lexicons");

function loadLexicons(): Lexicons {
  const lex = new Lexicons();
  lex.add({
    lexicon: 1,
    id: "com.atproto.repo.strongRef",
    defs: {
      main: {
        type: "object",
        required: ["uri", "cid"],
        properties: { uri: { type: "string", format: "at-uri" }, cid: { type: "string", format: "cid" } },
      },
    },
  });
  const walk = (dir: string): string[] =>
    readdirSync(dir, { withFileTypes: true }).flatMap((e) =>
      e.isDirectory() ? walk(path.join(dir, e.name)) : e.name.endsWith(".json") ? [path.join(dir, e.name)] : [],
    );
  for (const file of walk(lexDir)) lex.add(JSON.parse(readFileSync(file, "utf8")));
  return lex;
}

const lex = loadLexicons();
const CID = "bafyreidfayvfuwqa7qlnopdjiqrxzs6blmoeu4rujcjtnci5beludirz2a";
const DID = "did:plc:abcdefghijklmnopqrstuvwx";

const record = {
  $type: "com.example.artsky.artwork",
  kind: "evolution",
  trigger: { uri: `at://${DID}/app.bsky.feed.post/3m5abcdefgh2a`, cid: CID },
  previous: { uri: `at://${DID}/com.example.artsky.artwork/3m4zzzzzzzz2a`, cid: CID },
  renderer: { runtime: "canvas2d", version: "1", animated: false },
  code: "export default function draw(ctx, env) {}",
  params: { hue: 200 },
  seed: 12345,
  aspectRatio: { width: 4, height: 5 },
  title: "初雪",
  generator: { id: "artsky-rules", version: "0.2.0", model: "artsky-rules-1" },
  inputs: { postsSampled: 1, profile: { postsCount: 2842 } },
  state: { pieces: 2 },
  createdAt: "2026-11-14T07:31:00.000Z",
};

const view = {
  uri: `at://${DID}/com.example.artsky.artwork/3m5abcdefgh2a`,
  cid: CID,
  author: { did: DID, handle: "alice.bsky.social", displayName: "Alice" },
  record,
  indexedAt: "2026-11-14T07:31:05.000Z",
};

describe("Lexicon と Zod スキーマが一致する", () => {
  it("作品レコード", () => {
    lex.assertValidRecord("com.example.artsky.artwork", record);
    expect(ArtworkRecord.parse(record)).toMatchObject({ seed: 12345 });
  });

  it("不正な作品レコードはどちらでも弾かれる", () => {
    const bad = { ...record, seed: -1 };
    expect(() => lex.assertValidRecord("com.example.artsky.artwork", bad)).toThrow();
    expect(ArtworkRecord.safeParse(bad).success).toBe(false);
  });

  it.each([
    ["com.example.artsky.gallery.listLatest", ListLatestOutput, { cursor: "c1", items: [view] }],
    ["com.example.artsky.gallery.listByActor", ListByActorOutput, { author: view.author, items: [view] }],
    [
      "com.example.artsky.gallery.getArtwork",
      GetArtworkOutput,
      { artwork: view, previous: record.previous.uri },
    ],
  ] as const)("%s の出力", (nsid, schema, output) => {
    lex.assertValidXrpcOutput(nsid, output);
    expect(schema.safeParse(output).success).toBe(true);
  });

  it("必須項目が欠けた出力はどちらでも弾かれる", () => {
    const bad = { items: [{ ...view, author: undefined }] };
    expect(() => lex.assertValidXrpcOutput("com.example.artsky.gallery.listLatest", bad)).toThrow();
    expect(ListLatestOutput.safeParse(bad).success).toBe(false);
  });
});

describe("内部 API のスキーマ", () => {
  it("returnTo はサイト内のパスだけ", () => {
    expect(LoginQuery.parse({ handle: "alice.bsky.social" }).returnTo).toBe("/");
    expect(LoginQuery.safeParse({ handle: "a", returnTo: "/me/jobs" }).success).toBe(true);
    expect(LoginQuery.safeParse({ handle: "a", returnTo: "//evil.example" }).success).toBe(false);
    expect(LoginQuery.safeParse({ handle: "a", returnTo: "https://evil.example" }).success).toBe(false);
  });

  it("設定の変更は 1 項目以上", () => {
    expect(UpdateSettingsRequest.safeParse({ listed: false }).success).toBe(true);
    expect(UpdateSettingsRequest.safeParse({}).success).toBe(false);
  });
});
