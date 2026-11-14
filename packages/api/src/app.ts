import { z } from "zod";
import { Datetime, Did, StrongRef } from "./common.ts";

/**
 * 内部 API（このサービスの画面だけが使う）。認証はセッション Cookie。
 * 共通のエラー本文は common.ts の ErrorBody。
 */

// ---- 設定 ----

export const Settings = z.object({
  /** false にすると、以後 Bluesky に投稿しても作品を生成しない。 */
  generationEnabled: z.boolean(),
  /** false にすると、ギャラリーに作品を表示しない。 */
  listed: z.boolean(),
});
export type Settings = z.infer<typeof Settings>;

// ---- ログイン中のユーザー ----

export const Me = z.object({
  did: Did,
  handle: z.string(),
  displayName: z.string().optional(),
  avatar: z.url().optional(),
  /** 初回登録（POST /api/register）を済ませたか。 */
  registered: z.boolean(),
  registeredAt: Datetime.optional(),
  /** 未登録なら null。 */
  settings: Settings.nullable(),
});
export type Me = z.infer<typeof Me>;

/** GET /api/me。ログインしていなければ user が null（401 にはしない）。 */
export const MeResponse = z.object({
  user: Me.nullable(),
});
export type MeResponse = z.infer<typeof MeResponse>;

// ---- ジョブ ----

export const JobKind = z.enum(["genesis", "evolution"]);
export type JobKind = z.infer<typeof JobKind>;

/** queued → generating → validating → saving → done。失敗したら failed。 */
export const JobStatus = z.enum(["queued", "generating", "validating", "saving", "done", "failed"]);
export type JobStatus = z.infer<typeof JobStatus>;

export const JobErrorCode = z.enum([
  "refusal", // Claude が生成を拒否した
  "invalid_output", // Claude の出力が形式に合わない
  "validation_failed", // 生成したコードが検証に通らない
  "pds_write_failed", // PDS への保存に失敗した
  "auth_expired", // ログインの期限切れ。再ログインが必要
  "upstream_error", // Claude API や Bluesky が一時的に使えない
  "internal", // その他
]);
export type JobErrorCode = z.infer<typeof JobErrorCode>;

export const Job = z.object({
  id: z.string(),
  kind: JobKind,
  status: JobStatus,
  /** evolution のきっかけになった Bluesky の投稿。 */
  trigger: StrongRef.optional(),
  /** done になったら、保存した作品。 */
  artwork: StrongRef.optional(),
  /** failed のときのエラー。 */
  error: z
    .object({
      code: JobErrorCode,
      message: z.string(),
      /** true なら POST /api/jobs/:id/retry で再試行できる。 */
      retryable: z.boolean(),
    })
    .optional(),
  attempts: z.number().int().min(0),
  createdAt: Datetime,
  updatedAt: Datetime,
});
export type Job = z.infer<typeof Job>;

/** 終わった状態。これ以外ならフロントエンドは状態の取得を続ける。 */
export const FINISHED_JOB_STATUSES: readonly JobStatus[] = ["done", "failed"];

// ---- 初回登録 ----

/**
 * POST /api/register。
 * 投稿履歴を Claude（外部 AI）に送ることと、推定結果（感情や性格の傾向）が作品と一緒に公開されることへの同意が必須。
 */
export const RegisterRequest = z.object({
  consent: z.object({
    externalAi: z.literal(true),
  }),
});
export type RegisterRequest = z.infer<typeof RegisterRequest>;

export const RegisterResponse = z.object({
  me: Me,
  job: Job,
});
export type RegisterResponse = z.infer<typeof RegisterResponse>;

// ---- ジョブの一覧・取得・再試行 ----

/** GET /api/jobs */
export const ListJobsQuery = z.object({
  status: JobStatus.optional(),
  limit: z.coerce.number().int().min(1).max(100).default(30),
  cursor: z.string().optional(),
});
export type ListJobsQuery = z.input<typeof ListJobsQuery>;

export const ListJobsResponse = z.object({
  jobs: z.array(Job),
  cursor: z.string().optional(),
});
export type ListJobsResponse = z.infer<typeof ListJobsResponse>;

/** GET /api/jobs/:id、POST /api/jobs/:id/retry */
export const JobResponse = z.object({
  job: Job,
});
export type JobResponse = z.infer<typeof JobResponse>;

// ---- 設定の取得・変更 ----

/** GET /api/settings、PATCH /api/settings のレスポンス */
export const SettingsResponse = z.object({
  settings: Settings,
});
export type SettingsResponse = z.infer<typeof SettingsResponse>;

/** PATCH /api/settings。送った項目だけ変える。 */
export const UpdateSettingsRequest = Settings.partial().refine(
  (s) => Object.keys(s).length > 0,
  "変更する項目がありません",
);
export type UpdateSettingsRequest = z.infer<typeof UpdateSettingsRequest>;

// ---- OAuth（ブラウザの画面遷移で使う。JSON ではない） ----

/**
 * GET /oauth/login?handle=&returnTo=
 * returnTo は "/" で始まるサイト内のパスだけ受け付ける（外部サイトへのリダイレクトを防ぐ）。
 */
export const LoginQuery = z.object({
  handle: z.string().min(1),
  returnTo: z
    .string()
    .regex(/^\/(?!\/)/, "サイト内のパスを指定してください")
    .default("/"),
});
export type LoginQuery = z.input<typeof LoginQuery>;
