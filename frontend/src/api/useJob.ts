import { FINISHED_JOB_STATUSES, type Job } from "@art-sky/api";
import { useEffect, useState } from "react";
import { callApi } from "./client.ts";

/** ジョブの状態を取りにいく間隔（docs/api.md）。 */
export const JOB_POLL_MS = 2000;

export function isFinished(job: Job): boolean {
  return FINISHED_JOB_STATUSES.includes(job.status);
}

/**
 * ジョブが終わる（done か failed）まで、一定間隔で状態を取り直す。
 * 再試行などで initial が差し替わったら、そこから追いかけ直す。
 */
export function useJob(initial: Job): Job {
  const [job, setJob] = useState(initial);

  useEffect(() => setJob(initial), [initial]);

  useEffect(() => {
    if (isFinished(job)) return;
    let cancelled = false;
    const timer = setTimeout(async () => {
      try {
        const next = (await callApi("getJob", { params: { id: job.id } })).job;
        if (!cancelled) setJob(next);
      } catch {
        // 一時的な失敗は無視して、次の周期でもう一度取りにいく。
        if (!cancelled) setJob((current) => ({ ...current }));
      }
    }, JOB_POLL_MS);
    return () => {
      cancelled = true;
      clearTimeout(timer);
    };
  }, [job]);

  return job;
}
