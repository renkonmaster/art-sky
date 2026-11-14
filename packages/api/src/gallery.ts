import { z } from "zod";
import { AtUri, Datetime, Did, PageQuery } from "./common.ts";

/**
 * ギャラリー API（XRPC、ログイン不要）。
 * 正本は lexicons/com/example/artsky/gallery/*.json。ここは TypeScript から使うための写しで、
 * Lexicon と食い違わないことはテストで確かめる。
 */

export const AuthorView = z.object({
  did: Did,
  handle: z.string(),
  displayName: z.string().optional(),
  avatar: z.url().optional(),
});
export type AuthorView = z.infer<typeof AuthorView>;

export const ArtworkView = z.object({
  uri: AtUri,
  cid: z.string(),
  author: AuthorView,
  /** com.example.artsky.artwork のレコード。描画前に ArtworkRecord で検証する。 */
  record: z.record(z.string(), z.unknown()),
  indexedAt: Datetime,
});
export type ArtworkView = z.infer<typeof ArtworkView>;

// com.example.artsky.gallery.listLatest
export const ListLatestParams = PageQuery;
export type ListLatestParams = z.input<typeof ListLatestParams>;
export const ListLatestOutput = z.object({
  cursor: z.string().optional(),
  items: z.array(ArtworkView),
});
export type ListLatestOutput = z.infer<typeof ListLatestOutput>;

// com.example.artsky.gallery.listByActor
export const ListByActorParams = PageQuery.extend({
  actor: z.string().min(1), // DID またはハンドル名
});
export type ListByActorParams = z.input<typeof ListByActorParams>;
export const ListByActorOutput = z.object({
  author: AuthorView,
  cursor: z.string().optional(),
  items: z.array(ArtworkView),
});
export type ListByActorOutput = z.infer<typeof ListByActorOutput>;

// com.example.artsky.gallery.getArtwork
export const GetArtworkParams = z.object({
  uri: AtUri,
});
export type GetArtworkParams = z.input<typeof GetArtworkParams>;
export const GetArtworkOutput = z.object({
  artwork: ArtworkView,
  previous: AtUri.optional(),
  next: AtUri.optional(),
});
export type GetArtworkOutput = z.infer<typeof GetArtworkOutput>;

export const GALLERY_NSID = {
  listLatest: "com.example.artsky.gallery.listLatest",
  listByActor: "com.example.artsky.gallery.listByActor",
  getArtwork: "com.example.artsky.gallery.getArtwork",
} as const;
