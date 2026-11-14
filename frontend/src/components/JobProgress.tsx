import type { Job, JobStatus } from "@art-sky/api";
import { useEffect, useState } from "react";
import { Link } from "react-router";
import { ApiError, callApi } from "../api/client.ts";
import { isFinished, useJob } from "../api/useJob.ts";
import { artworkPath } from "../lib/atUri.ts";

const STEPS: ReadonlyArray<{ status: JobStatus; label: string }> = [
  { status: "queued", label: "待機中" },
  { status: "generating", label: "生成中" },
  { status: "validating", label: "検証中" },
  { status: "saving", label: "保存中" },
  { status: "done", label: "完了" },
];

export const JOB_STATUS_LABEL: Record<JobStatus, string> = {
  queued: "待機中",
  generating: "生成中",
  validating: "検証中",
  saving: "保存中",
  done: "完了",
  failed: "失敗",
};

interface Props {
  job: Job;
  /** ジョブが終わったとき（done か failed）に 1 回呼ぶ。 */
  onFinished?: (job: Job) => void;
}

/** 生成ジョブの進み具合を見せ、完了まで追いかける。失敗したら再試行できる。 */
export function JobProgress({ job: initial, onFinished }: Props) {
  const [base, setBase] = useState(initial);
  const [retryError, setRetryError] = useState<string | null>(null);
  const [retrying, setRetrying] = useState(false);
  useEffect(() => setBase(initial), [initial]);
  const job = useJob(base);

  const finished = isFinished(job);
  // biome-ignore lint/correctness/useExhaustiveDependencies: 終わった瞬間に 1 回だけ知らせる
  useEffect(() => {
    if (finished) onFinished?.(job);
  }, [finished, job.id, job.attempts]);

  const retry = async () => {
    setRetrying(true);
    setRetryError(null);
    try {
      setBase((await callApi("retryJob", { params: { id: job.id } })).job);
    } catch (err) {
      setRetryError(err instanceof ApiError ? err.message : "再試行できませんでした");
    } finally {
      setRetrying(false);
    }
  };

  const current = STEPS.findIndex((step) => step.status === job.status);
  return (
    <div className="job" data-status={job.status} aria-live="polite">
      <ol className="job-steps">
        {STEPS.map((step, index) => (
          <li
            key={step.status}
            data-state={
              job.status === "failed" ? "idle" : index < current || job.status === "done" ? "done" : index === current ? "now" : "idle"
            }
          >
            {step.label}
          </li>
        ))}
      </ol>
      {job.status === "done" && job.artwork ? (
        <p className="job-note">
          作品ができました。<Link to={artworkPath(job.artwork.uri)}>作品を見る</Link>
        </p>
      ) : null}
      {job.status === "failed" ? (
        <div className="job-note job-failed" role="alert">
          <p>生成に失敗しました：{job.error?.message ?? "原因不明のエラー"}</p>
          {job.error?.code === "auth_expired" ? <p>ログインし直してから、もう一度試してください。</p> : null}
          {job.error?.retryable !== false ? (
            <button type="button" className="button" onClick={() => void retry()} disabled={retrying}>
              {retrying ? "再試行中…" : "もう一度生成する"}
            </button>
          ) : null}
          {retryError ? <p>{retryError}</p> : null}
        </div>
      ) : null}
      {!finished ? <p className="job-note muted">作品を作っています。このままお待ちください（ページを離れても処理は続きます）。</p> : null}
    </div>
  );
}
