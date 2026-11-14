import { z } from "zod";

/** ISO 8601 の日時文字列。 */
export const Datetime = z.iso.datetime({ offset: true });

export const Did = z.string().regex(/^did:[a-z]+:[a-zA-Z0-9._:%-]+$/, "DID の形式ではありません");

export const AtUri = z.string().startsWith("at://", "AT URI の形式ではありません");

/** com.atproto.repo.strongRef */
export const StrongRef = z.object({
  uri: AtUri,
  cid: z.string().min(1),
});
export type StrongRef = z.infer<typeof StrongRef>;

/** 一覧 API の共通クエリ。cursor は前のレスポンスの値をそのまま渡す（中身に意味を持たせない）。 */
export const PageQuery = z.object({
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});
export type PageQuery = z.infer<typeof PageQuery>;

/**
 * エラーレスポンスの本文。XRPC のエラー形式（{ error, message }）に合わせ、
 * 内部 API も同じ形にする。
 */
export const ErrorBody = z.object({
  error: z.string(),
  message: z.string().optional(),
});
export type ErrorBody = z.infer<typeof ErrorBody>;

/** エラーコードと HTTP ステータスの対応。 */
export const ERRORS = {
  InvalidRequest: 400,
  AuthRequired: 401,
  NotFound: 404,
  ActorNotFound: 404,
  AlreadyRegistered: 409,
  NotRegistered: 409,
  JobNotRetryable: 409,
  RateLimited: 429,
  InternalError: 500,
  UpstreamError: 502,
} as const;
export type ErrorCode = keyof typeof ERRORS;
