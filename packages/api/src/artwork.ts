import { z } from "zod";
import { Datetime, StrongRef } from "./common.ts";

/**
 * 作品レコード com.example.artsky.artwork（lexicons/com/example/artsky/artwork.json）。
 * 表示側が受け取ったレコードを検証するのに使う。Lexicon と食い違わないことはテストで確かめる。
 */
export const ArtworkRecord = z.object({
  $type: z.literal("com.example.artsky.artwork").optional(),
  kind: z.string(), // knownValues: genesis | evolution（未知の値も受け付ける）
  trigger: StrongRef.optional(),
  previous: StrongRef.optional(),
  renderer: z.object({
    runtime: z.string(), // knownValues: canvas2d
    version: z.string().max(32),
    animated: z.boolean().default(false),
  }),
  code: z.string().refine((s) => new TextEncoder().encode(s).length <= 65536, "code が 64KB を超えています"),
  params: z.record(z.string(), z.unknown()).optional(),
  seed: z.number().int().min(0).max(4294967295),
  aspectRatio: z.object({
    width: z.number().int().min(1),
    height: z.number().int().min(1),
  }),
  title: z.string().optional(),
  generator: z.object({
    id: z.string(),
    version: z.string(),
    model: z.string().optional(),
  }),
  inputs: z
    .object({
      postsSampled: z.number().int().min(0).optional(),
      oldestPostAt: Datetime.optional(),
      newestPostAt: Datetime.optional(),
      profile: z
        .object({
          postsCount: z.number().int().min(0).optional(),
          followersCount: z.number().int().min(0).optional(),
          followsCount: z.number().int().min(0).optional(),
          accountCreatedAt: Datetime.optional(),
        })
        .optional(),
    })
    .optional(),
  state: z.record(z.string(), z.unknown()).optional(),
  createdAt: Datetime,
});
export type ArtworkRecord = z.infer<typeof ArtworkRecord>;
