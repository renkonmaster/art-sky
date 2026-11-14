/**
 * ジョブテーブルを一定間隔で見て、queued のジョブを 1 つずつ実行する。
 * 初期版は 1 台・同時 1 件で動かす（docs/tech-stack.md）。
 */
import Anthropic from "@anthropic-ai/sdk";
import { GenerationError } from "../generation/claude.ts";
import { JobError, runJob, type RunnerDeps } from "./runner.ts";

/** 利用者に見せるエラー文。内部の詳細はログにだけ出す。 */
function describeError(err: unknown): string {
  if (err instanceof JobError) return err.message;
  if (err instanceof GenerationError) return `生成に失敗しました（${err.reason}）: ${err.message}`;
  if (err instanceof Anthropic.RateLimitError) return "Claude API の利用上限に達しました。時間をおいて再試行してください";
  if (err instanceof Anthropic.APIError) return `Claude API のエラー（${err.status ?? "接続エラー"}）`;
  if (err instanceof Error) return err.message;
  return String(err);
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
        deps.jobs.fail(job.id, describeError(err));
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
