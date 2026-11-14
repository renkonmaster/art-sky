/**
 * ギャラリー用の索引（Plan.md 7.2）。作品の正本は本人の PDS にあり、ここはその写し。
 *
 * 索引に入る経路は 3 つ。どれも同じ upsert を通るので、何度入っても同じ結果になる。
 *   1. 生成ジョブが PDS に保存した直後（すぐ表示するため）
 *   2. Jetstream で作品レコードの作成・更新・削除を受け取ったとき（PDS で直接消された場合も追える）
 *   3. ログイン時に、その人の PDS から作品の一覧を読み直したとき（索引の作り直し）
 *
 * 入れる前に必ず ArtworkRecord で検証する。PDS には誰でも任意のレコードを書けるため。
 */
import { ArtworkRecord, type ArtworkView, type AuthorView } from "@art-sky/api";
import { nowIso, type Database } from "../db/database.ts";
import { ARTWORK_COLLECTION } from "../generation/record.ts";
import type { User } from "../users.ts";

interface ArtworkRow {
  uri: string;
  did: string;
  rkey: string;
  cid: string;
  record: string;
  created_at: string;
  indexed_at: string;
}

export interface IndexedArtwork {
  uri: string;
  did: string;
  rkey: string;
  cid: string;
  record: Record<string, unknown>;
  createdAt: string;
  indexedAt: string;
}

const toArtwork = (r: ArtworkRow): IndexedArtwork => ({
  uri: r.uri,
  did: r.did,
  rkey: r.rkey,
  cid: r.cid,
  record: JSON.parse(r.record) as Record<string, unknown>,
  createdAt: r.created_at,
  indexedAt: r.indexed_at,
});

export const artworkUri = (did: string, rkey: string): string => `at://${did}/${ARTWORK_COLLECTION}/${rkey}`;

export function authorView(user: User): AuthorView {
  return {
    did: user.did,
    handle: user.handle,
    ...(user.displayName ? { displayName: user.displayName } : {}),
    ...(user.avatar ? { avatar: user.avatar } : {}),
  };
}

export function artworkView(artwork: IndexedArtwork, author: User): ArtworkView {
  return { uri: artwork.uri, cid: artwork.cid, author: authorView(author), record: artwork.record, indexedAt: artwork.indexedAt };
}

export function createGalleryIndex(db: Database) {
  const upsert = db.prepare(
    `INSERT INTO artworks (uri, did, rkey, cid, record, created_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
     ON CONFLICT (uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, created_at = excluded.created_at`,
  );
  const remove = db.prepare("DELETE FROM artworks WHERE uri = ?");
  const removeMissing = db.prepare("DELETE FROM artworks WHERE did = ? AND rkey NOT IN (SELECT value FROM json_each(?))");
  const byUri = db.prepare("SELECT * FROM artworks WHERE uri = ?");
  // レコードキー（TID）は時刻順に並ぶので、作品の新旧はレコードキーで決める。
  const byDid = db.prepare("SELECT * FROM artworks WHERE did = ? ORDER BY rkey DESC LIMIT ? OFFSET ?");
  const older = db.prepare("SELECT * FROM artworks WHERE did = ? AND rkey < ? ORDER BY rkey DESC LIMIT 1");
  const newer = db.prepare("SELECT * FROM artworks WHERE did = ? AND rkey > ? ORDER BY rkey ASC LIMIT 1");
  // 掲載中の参加者ごとに最新の 1 件。更新が新しい順。
  const latest = db.prepare(
    `SELECT a.* FROM artworks a JOIN users u ON u.did = a.did
     WHERE u.consented_at IS NOT NULL AND u.listed = 1
       AND a.rkey = (SELECT MAX(b.rkey) FROM artworks b WHERE b.did = a.did)
     ORDER BY a.created_at DESC, a.uri LIMIT ? OFFSET ?`,
  );

  return {
    /**
     * 作品を索引に入れる。レコードの形式が正しくなければ入れずに false を返す。
     */
    upsert(input: { did: string; rkey: string; cid: string; record: unknown }): boolean {
      const parsed = ArtworkRecord.safeParse(input.record);
      if (!parsed.success) return false;
      upsert.run(
        artworkUri(input.did, input.rkey),
        input.did,
        input.rkey,
        input.cid,
        JSON.stringify(input.record),
        parsed.data.createdAt,
        nowIso(),
      );
      return true;
    },
    remove(did: string, rkey: string): void {
      remove.run(artworkUri(did, rkey));
    },
    /** その人の索引を、PDS から読んだ一覧と同じ内容にする（足りないものを入れ、消えたものを消す）。 */
    replaceAll(did: string, records: ReadonlyArray<{ rkey: string; cid: string; record: unknown }>): number {
      let count = 0;
      const kept: string[] = [];
      for (const r of records) {
        if (this.upsert({ did, ...r })) {
          count++;
          kept.push(r.rkey);
        }
      }
      removeMissing.run(did, JSON.stringify(kept));
      return count;
    },
    get(uri: string): IndexedArtwork | undefined {
      const row = byUri.get(uri) as ArtworkRow | undefined;
      return row ? toArtwork(row) : undefined;
    },
    /** 1 人の作品を新しい順に。 */
    listByDid(did: string, limit: number, offset: number): IndexedArtwork[] {
      return (byDid.all(did, limit, offset) as unknown as ArtworkRow[]).map(toArtwork);
    },
    /** 掲載中の参加者ごとの最新作品を、更新が新しい順に。 */
    listLatest(limit: number, offset: number): IndexedArtwork[] {
      return (latest.all(limit, offset) as unknown as ArtworkRow[]).map(toArtwork);
    },
    /** 同じ作者の 1 つ前（古い）と 1 つ後（新しい）の作品。 */
    neighbors(artwork: IndexedArtwork): { previous?: IndexedArtwork; next?: IndexedArtwork } {
      const prev = older.get(artwork.did, artwork.rkey) as ArtworkRow | undefined;
      const next = newer.get(artwork.did, artwork.rkey) as ArtworkRow | undefined;
      return { ...(prev ? { previous: toArtwork(prev) } : {}), ...(next ? { next: toArtwork(next) } : {}) };
    },
  };
}

export type GalleryIndex = ReturnType<typeof createGalleryIndex>;
