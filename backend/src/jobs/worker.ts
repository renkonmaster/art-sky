/**
 * ジョブテーブルを一定間隔で見て、queued のジョブを 1 つずつ実行する。
 * 初期版は 1 台・同時 1 件で動かす（docs/tech-stack.md）。
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

export function startWorker(deps: RunnerDeps, { intervalMs = 1000 } = {}): { stop(): Promise<void> } {
  const reset = deps.jobs.resetInterrupted();
  if (reset > 0) console.log(`[worker] 中断していたジョブ ${reset} 件をやり直します`);

  let running: Promise<void> | null = null;
  let stopped = false;

  async function tick() {
    for (let job = deps.jobs.claimNext(); job && !stopped; job = deps.jobs.claimNext()) {
      console.log(`[worker] job ${job.id} (${job.kind}, ${job.did}) 開始（${job.attempts} 回目）`);
      try {
        const artwork = await runJob(deps, job);
        console.log(`[worker] job ${job.id} 完了: ${artwork.uri}`);
      } catch (err) {
        console.error(`[worker] job ${job.id} 失敗:`, err);
        const { code, message } = describeError(err);
        deps.jobs.fail(job.id, message, code);
      }
    }
  }

  const timer = setInterval(() => {
    if (running || stopped) return;
    running = tick().finally(() => {
      running = null;
    });
  }, intervalMs);

  return {
    async stop() {
      stopped = true;
      clearInterval(timer);
      await running;
    },
  };
}
