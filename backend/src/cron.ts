/**
 * 定期実行（Cron）1 回分の処理。
 *   1. 処理中のまま止まったジョブをやり直す
 *   2. Jetstream から前回の続きを受け取り、新しい投稿のジョブを作る（pullOnce）
 *   3. たまったジョブを上限まで処理する（runQueuedJobs）
 *
 * Node.js のサーバーでは startCron が一定間隔で呼ぶ。Cloudflare Workers では scheduled ハンドラーから呼ぶ。
 */
import { type ConsumerDeps, type PullOptions, type PullResult, pullOnce } from "./jetstream/consumer.ts";
import type { RunnerDeps } from "./jobs/runner.ts";
import { type RunJobsOptions, runQueuedJobs } from "./jobs/worker.ts";

/** これより長く処理中のままのジョブは、途中で打ち切られたものとしてやり直す。 */
const STALE_JOB_MS = 10 * 60_000;

export interface CronDeps {
  consumer: ConsumerDeps;
  pull: PullOptions;
  runner: RunnerDeps;
  jobs?: RunJobsOptions;
  log?: (message: string) => void;
}

export interface CronResult {
  pull: PullResult;
  jobs: { done: number; failed: number };
}

export async function runCron(deps: CronDeps): Promise<CronResult> {
  const log = deps.log ?? ((m: string) => console.log(`[cron] ${m}`));
  const reset = await deps.runner.jobs.resetStale(STALE_JOB_MS);
  if (reset > 0) log(`止まっていたジョブ ${reset} 件をやり直します`);
  const pull = await pullOnce(deps.consumer, deps.pull);
  const jobs = await runQueuedJobs(deps.runner, deps.jobs);
  if (pull.jobs > 0 || jobs.done + jobs.failed > 0 || pull.outcome === "failed") {
    log(`投稿 ${pull.events} 件を受け取り、ジョブ ${pull.jobs} 件を作成、${jobs.done} 件完了、${jobs.failed} 件失敗（${pull.outcome}）`);
  }
  return { pull, jobs };
}

/**
 * runCron を intervalMs ごとに実行する（Node.js のサーバー用）。
 * 実行は重ならないようにする。kick() は、登録や再試行の直後にジョブだけをすぐ処理するのに使う。
 */
export function startCron(deps: CronDeps, { intervalMs = 60_000 } = {}): { kick(): void; stop(): Promise<void> } {
  let chain: Promise<unknown> = Promise.resolve();
  let stopped = false;
  let kicked = false;
  const enqueue = (task: () => Promise<unknown>) => {
    chain = chain.then(task).catch((err) => console.error("[cron] 失敗:", err));
  };

  enqueue(() => runCron(deps));
  const timer = setInterval(() => {
    if (!stopped) enqueue(() => runCron(deps));
  }, intervalMs);

  return {
    kick() {
      if (stopped || kicked) return;
      kicked = true;
      enqueue(async () => {
        kicked = false;
        await runQueuedJobs(deps.runner, deps.jobs);
      });
    },
    async stop() {
      stopped = true;
      clearInterval(timer);
      await chain;
    },
  };
}
