import { type Job, type Settings } from "@art-sky/api";
import { useCallback, useEffect, useState } from "react";
import { Link, useNavigate } from "react-router";
import { ApiError, callApi } from "../api/client.ts";
import { isFinished, JOB_POLL_MS } from "../api/useJob.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { RequireAuth } from "../auth/RequireAuth.tsx";
import { JOB_STATUS_LABEL } from "../components/JobProgress.tsx";
import { ErrorNote, Loading } from "../components/States.tsx";
import { actorPath, artworkPath, blueskyPostUrl } from "../lib/atUri.ts";
import { formatDateTime } from "../lib/format.ts";

/** 管理：生成と掲載の設定、生成ジョブの一覧と再試行、ログアウト。 */
export function ManagePage() {
  return <RequireAuth registered>{(user) => <Manage handle={user.handle} initial={user.settings} />}</RequireAuth>;
}

function Manage({ handle, initial }: { handle: string; initial: Settings | null }) {
  const { refresh, logout } = useAuth();
  const navigate = useNavigate();
  return (
    <div className="stack">
      <div className="toolbar">
        <h1 className="page-heading">管理</h1>
        <div className="toolbar-actions">
          <Link className="button" to={actorPath(handle)}>
            自分のギャラリー
          </Link>
          <button
            type="button"
            className="button"
            onClick={() => void logout().then(() => navigate("/"))}
          >
            ログアウト
          </button>
        </div>
      </div>
      <SettingsPanel initial={initial} onChanged={refresh} />
      <JobsPanel />
    </div>
  );
}

const SETTING_ITEMS: ReadonlyArray<{ key: keyof Settings; label: string; on: string; off: string }> = [
  {
    key: "generationEnabled",
    label: "投稿のたびに作品を作る",
    on: "Bluesky に投稿すると、新しい作品を生成します。",
    off: "投稿しても作品は生成しません。これまでの作品は残ります。",
  },
  {
    key: "listed",
    label: "ギャラリーに掲載する",
    on: "あなたの作品が、みんなのギャラリーと個人ギャラリーに表示されます。",
    off: "ギャラリーには表示されません。作品のレコードはあなたの PDS に残ります。",
  },
];

function SettingsPanel({ initial, onChanged }: { initial: Settings | null; onChanged: () => Promise<void> }) {
  const [settings, setSettings] = useState<Settings | null>(initial);
  const [saving, setSaving] = useState<keyof Settings | null>(null);
  const [error, setError] = useState<string | null>(null);

  const toggle = async (key: keyof Settings) => {
    if (!settings) return;
    setSaving(key);
    setError(null);
    try {
      const result = await callApi("updateSettings", { body: { [key]: !settings[key] } });
      setSettings(result.settings);
      await onChanged();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "設定を変えられませんでした。");
    } finally {
      setSaving(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="settings-heading">
      <h2 id="settings-heading" className="page-heading">
        設定
      </h2>
      {settings ? (
        <ul className="settings">
          {SETTING_ITEMS.map((item) => (
            <li key={item.key}>
              <div>
                <p className="settings-label" id={`setting-${item.key}`}>
                  {item.label}
                </p>
                <p className="muted">{settings[item.key] ? item.on : item.off}</p>
              </div>
              <button
                type="button"
                className="switch"
                role="switch"
                aria-checked={settings[item.key]}
                aria-labelledby={`setting-${item.key}`}
                disabled={saving !== null}
                onClick={() => void toggle(item.key)}
              >
                <span className="switch-knob" />
              </button>
            </li>
          ))}
        </ul>
      ) : (
        <p className="muted">設定を読み込めませんでした。</p>
      )}
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
    </section>
  );
}

function JobsPanel() {
  const [jobs, setJobs] = useState<Job[] | null>(null);
  const [error, setError] = useState<Error | null>(null);
  const [retrying, setRetrying] = useState<string | null>(null);

  const load = useCallback(async () => {
    try {
      setJobs((await callApi("listJobs", { query: { limit: 50 } })).jobs);
      setError(null);
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    }
  }, []);

  useEffect(() => {
    void load();
  }, [load]);

  // 終わっていないジョブがある間は、一覧を取り直し続ける。
  const active = jobs?.some((job) => !isFinished(job)) === true;
  useEffect(() => {
    if (!active) return;
    const timer = setInterval(() => void load(), JOB_POLL_MS);
    return () => clearInterval(timer);
  }, [active, load]);

  const retry = async (id: string) => {
    setRetrying(id);
    try {
      await callApi("retryJob", { params: { id } });
      await load();
    } catch (err) {
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      setRetrying(null);
    }
  };

  return (
    <section className="panel" aria-labelledby="jobs-heading">
      <h2 id="jobs-heading" className="page-heading">
        生成の履歴
      </h2>
      {error ? <ErrorNote error={error} /> : null}
      {jobs === null && !error ? <Loading /> : null}
      {jobs && jobs.length === 0 ? (
        <p className="muted">
          まだ履歴がありません。Bluesky に投稿すると、ここに生成の状況が並びます。
        </p>
      ) : null}
      {jobs && jobs.length > 0 ? (
        <ul className="jobs">
          {jobs.map((job) => {
            const postUrl = job.trigger ? blueskyPostUrl(job.trigger.uri) : null;
            return (
              <li key={job.id} data-status={job.status}>
                <span className="badge" data-status={job.status}>
                  {JOB_STATUS_LABEL[job.status]}
                </span>
                <div className="jobs-body">
                  <p>
                    {job.kind === "genesis" ? "最初の作品" : "投稿からの作品"}
                    <span className="muted">・{formatDateTime(job.createdAt)}</span>
                    {job.attempts > 1 ? <span className="muted">・{job.attempts} 回目</span> : null}
                  </p>
                  {job.error ? <p className="form-error">{job.error.message}</p> : null}
                  <p className="jobs-links">
                    {job.artwork ? <Link to={artworkPath(job.artwork.uri)}>作品を見る</Link> : null}
                    {postUrl ? (
                      <a href={postUrl} target="_blank" rel="noreferrer">
                        元の投稿
                      </a>
                    ) : null}
                  </p>
                </div>
                {job.status === "failed" && job.error?.retryable !== false ? (
                  <button type="button" className="button" disabled={retrying !== null} onClick={() => void retry(job.id)}>
                    {retrying === job.id ? "再試行中…" : "再試行"}
                  </button>
                ) : null}
              </li>
            );
          })}
        </ul>
      ) : null}
    </section>
  );
}
