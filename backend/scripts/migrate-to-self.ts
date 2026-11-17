/**
 * 以前の方式（投稿ごとに TID のキーで作った作品）を、1 人 1 件の self に移す。
 *   1. 作品レコードの一覧を読む
 *   2. self がなければ、最新の作品を self にコピーする
 *   3. self 以外の作品レコードを PDS から削除する（元に戻せない）
 *
 * サーバーと同じデータベースに保存されたログイン情報（OAuth セッション）を使う。
 *   node --env-file-if-exists=.env scripts/migrate-to-self.ts --db data/local/art-sky.sqlite --port 3001 [--did did:plc:...] [--apply]
 * --apply をつけないと、消す予定の作品を表示するだけで何も変えない。
 */
import { Agent } from "@atproto/api";
import { parseArgs } from "node:util";
import { ArtworkRecord } from "@art-sky/api";
import { createOAuthClient } from "../src/auth/oauth.ts";
import { openDatabase } from "../src/db/database.ts";
import { ARTWORK_COLLECTION, ARTWORK_RKEY } from "../src/generation/record.ts";
import { createUserRepository } from "../src/users.ts";

const { values } = parseArgs({
  options: {
    db: { type: "string", default: "data/art-sky.sqlite" },
    port: { type: "string", default: "3000" },
    did: { type: "string" },
    apply: { type: "boolean", default: false },
  },
});

const db = openDatabase(values.db!);
const oauth = createOAuthClient({ db, publicUrl: process.env.PUBLIC_URL, port: Number(values.port) });
const dids = values.did ? [values.did] : (await createUserRepository(db).listRegistered()).map((u) => u.did);
const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

for (const did of dids) {
  let agent: Agent;
  try {
    agent = new Agent(await oauth.restore(did));
  } catch (err) {
    console.log(`${did}: ログイン情報が使えないので飛ばします（${(err as Error).message}）`);
    continue;
  }
  const records: { rkey: string; cid: string; value: unknown }[] = [];
  let cursor: string | undefined;
  do {
    const { data } = await agent.com.atproto.repo.listRecords({ repo: did, collection: ARTWORK_COLLECTION, limit: 100, ...(cursor ? { cursor } : {}) });
    for (const r of data.records) records.push({ rkey: rkeyOf(r.uri), cid: r.cid, value: r.value });
    cursor = data.records.length > 0 ? data.cursor : undefined;
  } while (cursor);

  const self = records.find((r) => r.rkey === ARTWORK_RKEY);
  const old = records.filter((r) => r.rkey !== ARTWORK_RKEY).sort((a, b) => (a.rkey < b.rkey ? 1 : -1));
  const newest = old.find((r) => ArtworkRecord.safeParse(r.value).success);
  const gen = (v: unknown) => (v as { generator?: { id?: string } }).generator?.id ?? "?";
  console.log(`${did}: 作品 ${records.length} 件（self ${self ? "あり" : "なし"}、以前の方式 ${old.length} 件）`);
  for (const r of old) console.log(`  削除予定 ${r.rkey}  ${gen(r.value)}  ${(r.value as { createdAt?: string }).createdAt ?? ""}`);
  if (!self && newest) console.log(`  self にコピー ← ${newest.rkey}（${gen(newest.value)}）`);
  if (!values.apply) continue;

  if (!self && newest) {
    await agent.com.atproto.repo.putRecord({ repo: did, collection: ARTWORK_COLLECTION, rkey: ARTWORK_RKEY, record: newest.value as Record<string, unknown> });
    console.log(`  self を作成しました`);
  }
  if (!self && !newest && old.length > 0) {
    console.log(`  形式の正しい作品がないので、削除はしません`);
    continue;
  }
  for (const r of old) await agent.com.atproto.repo.deleteRecord({ repo: did, collection: ARTWORK_COLLECTION, rkey: r.rkey });
  console.log(`  ${old.length} 件を削除しました`);
}
