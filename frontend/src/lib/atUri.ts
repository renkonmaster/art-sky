/** at://<did>/<collection>/<rkey> を分解する。 */
export function parseAtUri(uri: string): { did: string; collection: string; rkey: string } | null {
  const match = uri.match(/^at:\/\/([^/]+)\/([^/]+)\/([^/]+)$/);
  return match ? { did: match[1] as string, collection: match[2] as string, rkey: match[3] as string } : null;
}

const ARTWORK_COLLECTION = "com.example.artsky.artwork";

export function artworkUri(did: string, rkey: string): string {
  return `at://${did}/${ARTWORK_COLLECTION}/${rkey}`;
}

/** 作品詳細ページのパス。 */
export function artworkPath(uri: string): string {
  const parsed = parseAtUri(uri);
  return parsed ? `/u/${encodeURIComponent(parsed.did)}/${encodeURIComponent(parsed.rkey)}` : "/";
}

/** 個人ギャラリーのパス。 */
export function actorPath(actor: string): string {
  return `/u/${encodeURIComponent(actor)}`;
}

/** Bluesky 上の投稿ページ。 */
export function blueskyPostUrl(postUri: string): string | null {
  const parsed = parseAtUri(postUri);
  return parsed ? `https://bsky.app/profile/${parsed.did}/post/${parsed.rkey}` : null;
}
