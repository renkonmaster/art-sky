/**
 * ギャラリー用の索引（Plan.md 7.2）。作品の正本は本人の PDS にあり、ここはその写し。
 *
 * 索引に入る経路は 3 つ。どれも同じ upsert を通るので、何度入っても同じ結果になる。
 *   1. 生成ジョブが PDS に保存した直後（すぐ表示するため）
 *   2. Jetstream で作品レコードの作成・更新・削除を受け取ったとき（PDS で直接消された場合も追える）
 *   3. ログイン時に、その人の PDS から作品の一覧を読み直したとき（索引の作り直し）
 *
 * 入れる前に必ず ArtworkRecord で検証する。PDS には誰でも任意のレコードを書けるため。
 *
 * 1 人につき最新の作品 1 件だけを持つ。過去の作品は本人の PDS に残るが、サービス側では保持しない。
 * 次の作品の生成は PDS の作品から前作品を探すので（jobs/runner.ts）、ここに過去の作品がなくても困らない。
 */
import { ArtworkRecord, type ArtworkView, type AuthorView } from "@art-sky/api";
import { nowIso, type Sql } from "../db/sql.ts";
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

export function createGalleryIndex(db: Sql) {
  const one = async (sql: string, ...params: (string | number)[]) => {
    const row = await db.get<ArtworkRow>(sql, ...params);
    return row ? toArtwork(row) : undefined;
  };
  const many = async (sql: string, ...params: (string | number)[]) => (await db.all<ArtworkRow>(sql, ...params)).map(toArtwork);

  return {
    /**
     * 作品を索引に入れる。レコードの形式が正しくなければ入れずに false を返す。
     * すでにもっと新しい作品があれば入れない。入れたら、その人の古い作品は索引から消す。
     */
    async upsert(input: { did: string; rkey: string; cid: string; record: unknown }): Promise<boolean> {
      const parsed = ArtworkRecord.safeParse(input.record);
      if (!parsed.success) return false;
      const newest = (await db.get<{ rkey: string | null }>("SELECT MAX(rkey) AS rkey FROM artworks WHERE did = ?", input.did))?.rkey;
      if (newest && newest > input.rkey) return true;
      // 同じ版がすでに入っていれば書き込まない（Jetstream で同じイベントを読み直したとき）
      const current = await db.get<{ cid: string }>("SELECT cid FROM artworks WHERE uri = ?", artworkUri(input.did, input.rkey));
      if (current?.cid === input.cid) return true;
      await db.run(
        `INSERT INTO artworks (uri, did, rkey, cid, record, created_at, indexed_at) VALUES (?, ?, ?, ?, ?, ?, ?)
         ON CONFLICT (uri) DO UPDATE SET cid = excluded.cid, record = excluded.record, created_at = excluded.created_at`,
        artworkUri(input.did, input.rkey),
        input.did,
        input.rkey,
        input.cid,
        JSON.stringify(input.record),
        parsed.data.createdAt,
        nowIso(),
      );
      await db.run("DELETE FROM artworks WHERE did = ? AND rkey <> ?", input.did, input.rkey);
      return true;
    },
    async remove(did: string, rkey: string): Promise<void> {
      await db.run("DELETE FROM artworks WHERE uri = ?", artworkUri(did, rkey));
    },
    /** その人の索引を、PDS から読んだ一覧のうち最新の作品 1 件だけにする。入れた件数（0 か 1）を返す。 */
    async replaceAll(did: string, records: ReadonlyArray<{ rkey: string; cid: string; record: unknown }>): Promise<number> {
      const valid = records.filter((r) => ArtworkRecord.safeParse(r.record).success);
      const newest = valid.reduce<(typeof valid)[number] | undefined>((a, r) => (!a || r.rkey > a.rkey ? r : a), undefined);
      await db.run("DELETE FROM artworks WHERE did = ?", did);
      return newest && (await this.upsert({ did, ...newest })) ? 1 : 0;
    },
    get(uri: string): Promise<IndexedArtwork | undefined> {
      return one("SELECT * FROM artworks WHERE uri = ?", uri);
    },
    /** 1 人の作品を新しい順に（レコードキーは時刻順に並ぶので、新旧はレコードキーで決める）。 */
    listByDid(did: string, limit: number, offset: number): Promise<IndexedArtwork[]> {
      return many("SELECT * FROM artworks WHERE did = ? ORDER BY rkey DESC LIMIT ? OFFSET ?", did, limit, offset);
    },
    /** 掲載中の参加者ごとの最新作品を、更新が新しい順に。 */
    listLatest(limit: number, offset: number): Promise<IndexedArtwork[]> {
      return many(
        `SELECT a.* FROM artworks a JOIN users u ON u.did = a.did
         WHERE u.consented_at IS NOT NULL AND u.listed = 1
           AND a.rkey = (SELECT MAX(b.rkey) FROM artworks b WHERE b.did = a.did)
         ORDER BY a.created_at DESC, a.uri LIMIT ? OFFSET ?`,
        limit,
        offset,
      );
    },
    /** 同じ作者の 1 つ前（古い）と 1 つ後（新しい）の作品。 */
    async neighbors(artwork: IndexedArtwork): Promise<{ previous?: IndexedArtwork; next?: IndexedArtwork }> {
      const prev = await one("SELECT * FROM artworks WHERE did = ? AND rkey < ? ORDER BY rkey DESC LIMIT 1", artwork.did, artwork.rkey);
      const next = await one("SELECT * FROM artworks WHERE did = ? AND rkey > ? ORDER BY rkey ASC LIMIT 1", artwork.did, artwork.rkey);
      return { ...(prev ? { previous: prev } : {}), ...(next ? { next } : {}) };
    },
  };
}

export type GalleryIndex = ReturnType<typeof createGalleryIndex>;
