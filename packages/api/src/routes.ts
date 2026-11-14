import type { z } from "zod";
import * as app from "./app.ts";
import * as gallery from "./gallery.ts";

/**
 * JSON を返す API の一覧。バックエンドのルーティングとフロントエンドのクライアント・モックは
 * この表を元にして、パスや型が食い違わないようにする。
 *
 * - query: クエリ文字列のスキーマ
 * - body: リクエスト本文のスキーマ
 * - response: 成功時のレスポンスのスキーマ
 * - auth: true ならセッション Cookie が必要（なければ 401 AuthRequired）
 */
export interface RouteDef {
  method: "GET" | "POST" | "PATCH";
  path: string;
  auth: boolean;
  status: 200 | 201 | 202;
  query?: z.ZodType;
  body?: z.ZodType;
  response: z.ZodType;
}

export const routes = {
  // 内部 API
  getMe: { method: "GET", path: "/api/me", auth: false, status: 200, response: app.MeResponse },
  register: {
    method: "POST",
    path: "/api/register",
    auth: true,
    status: 202,
    body: app.RegisterRequest,
    response: app.RegisterResponse,
  },
  createPost: {
    method: "POST",
    path: "/api/posts",
    auth: true,
    status: 201,
    body: app.CreatePostRequest,
    response: app.CreatePostResponse,
  },
  listJobs: {
    method: "GET",
    path: "/api/jobs",
    auth: true,
    status: 200,
    query: app.ListJobsQuery,
    response: app.ListJobsResponse,
  },
  getJob: { method: "GET", path: "/api/jobs/:id", auth: true, status: 200, response: app.JobResponse },
  retryJob: { method: "POST", path: "/api/jobs/:id/retry", auth: true, status: 202, response: app.JobResponse },
  getSettings: { method: "GET", path: "/api/settings", auth: true, status: 200, response: app.SettingsResponse },
  updateSettings: {
    method: "PATCH",
    path: "/api/settings",
    auth: true,
    status: 200,
    body: app.UpdateSettingsRequest,
    response: app.SettingsResponse,
  },

  // ギャラリー API（XRPC）
  listLatest: {
    method: "GET",
    path: `/xrpc/${gallery.GALLERY_NSID.listLatest}`,
    auth: false,
    status: 200,
    query: gallery.ListLatestParams,
    response: gallery.ListLatestOutput,
  },
  listByActor: {
    method: "GET",
    path: `/xrpc/${gallery.GALLERY_NSID.listByActor}`,
    auth: false,
    status: 200,
    query: gallery.ListByActorParams,
    response: gallery.ListByActorOutput,
  },
  getArtwork: {
    method: "GET",
    path: `/xrpc/${gallery.GALLERY_NSID.getArtwork}`,
    auth: false,
    status: 200,
    query: gallery.GetArtworkParams,
    response: gallery.GetArtworkOutput,
  },
} as const satisfies Record<string, RouteDef>;

export type RouteName = keyof typeof routes;
