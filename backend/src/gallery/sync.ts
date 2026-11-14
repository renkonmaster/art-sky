/**
 * 1 人の作品を PDS から読み直して、ギャラリーの索引をそろえる。
 * 作品の正本は PDS にあるので、索引が欠けたり古くなったりしても、これで作り直せる（Plan.md 7.2）。
 */
import type { Agent } from "@atproto/api";
import { ARTWORK_COLLECTION } from "../generation/record.ts";
import type { GalleryIndex } from "./index.ts";

type RepoAgent = { com: { atproto: { repo: Pick<Agent["com"]["atproto"]["repo"], "listRecords"> } } };

const rkeyOf = (uri: string) => uri.slice(uri.lastIndexOf("/") + 1);

/** 索引に入った作品の数を返す。 */
export async function syncArtworksFromPds(agent: RepoAgent, did: string, gallery: GalleryIndex): Promise<number> {
  const records: Array<{ rkey: string; cid: string; record: unknown }> = [];
  let cursor: string | undefined;
  do {
    const { data } = await agent.com.atproto.repo.listRecords({
      repo: did,
      collection: ARTWORK_COLLECTION,
      limit: 100,
      ...(cursor ? { cursor } : {}),
    });
    for (const r of data.records) records.push({ rkey: rkeyOf(r.uri), cid: r.cid, record: r.value });
    cursor = data.records.length > 0 ? data.cursor : undefined;
  } while (cursor);
  return gallery.replaceAll(did, records);
}
