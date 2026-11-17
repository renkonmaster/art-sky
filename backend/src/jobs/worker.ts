/**
 * queued のジョブを 1 つずつ実行する。定期実行（Cron）のたびと、登録・再試行の直後に呼ぶ。
 * 1 回に処理する件数と時間に上限を設け、残りは次回に回す（Cloudflare Workers の制限に合わせる）。
 */
import type { JobErrorCode } from "./repository.ts";
import { JobError, runJob, type RunnerDeps } from "./runner.ts";

/** セッションを復元できなかった（ログインし直しが必要）。 */
export class SessionExpiredError extends Error {
  override name = "SessionExpiredError";
}

/** 利用者に見せるエラーの種類と文。内部の詳細はログにだけ出す。 */
export function describeError(err: unknown): { code: JobErrorCode; message: string } {
  if (err instanceof JobError) return { code: err.code, message: err.message };
  if (err instanceof SessionExpiredError) {
    return { code: "auth_expired", message: "ログインの有効期限が切れました。ログインし直してから再試行してください" };
  }
  return { code: "internal", message: err instanceof Error ? err.message : String(err) };
}

export interface RunJobsOptions {
  /** 1 回に処理するジョブの上限。 */
  maxJobs?: number;
  /** この時間を過ぎたら、新しいジョブは始めない。 */
  budgetMs?: number;
  now?: () => number;
  log?: (message: string) => void;
}

/** 処理したジョブの数（成功と失敗）を返す。 */
export async function runQueuedJobs(deps: RunnerDeps, options: RunJobsOptions = {}): Promise<{ done: number; failed: number }> {
  const { maxJobs = 10, budgetMs = 20_000, now = Date.now } = options;
  const log = options.log ?? ((m: string) => console.log(`[worker] ${m}`));
  const deadline = now() + budgetMs;
  const result = { done: 0, failed: 0 };
  while (result.done + result.failed < maxJobs && now() < deadline) {
    const job = deps.jobs.claimNext();
    if (!job) break;
    log(`job ${job.id} (${job.kind}, ${job.did}) 開始（${job.attempts} 回目）`);
    try {
      const artwork = await runJob(deps, job);
      log(`job ${job.id} 完了: ${artwork.uri}`);
      result.done++;
    } catch (err) {
      console.error(`[worker] job ${job.id} 失敗:`, err);
      const { code, message } = describeError(err);
      deps.jobs.fail(job.id, message, code);
      result.failed++;
    }
  }
  return result;
}
