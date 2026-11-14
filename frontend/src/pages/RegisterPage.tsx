import type { Job } from "@art-sky/api";
import { type FormEvent, useState } from "react";
import { Link, Navigate } from "react-router";
import { ApiError, callApi } from "../api/client.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { RequireAuth } from "../auth/RequireAuth.tsx";
import { JobProgress } from "../components/JobProgress.tsx";
import { actorPath } from "../lib/atUri.ts";

/** 初回登録：外部 AI に送る内容を説明して同意を取り、最初の作品を作り始める。 */
export function RegisterPage() {
  return <RequireAuth>{(user) => <RegisterForm handle={user.handle} registered={user.registered} />}</RequireAuth>;
}

function RegisterForm({ handle, registered }: { handle: string; registered: boolean }) {
  const { refresh } = useAuth();
  const [agreed, setAgreed] = useState(false);
  const [submitting, setSubmitting] = useState(false);
  const [error, setError] = useState<string | null>(null);
  const [job, setJob] = useState<Job | null>(null);
  const [finished, setFinished] = useState<Job | null>(null);

  // 登録済みの人が開いたら管理画面へ送る（いま登録したばかりの人は進行状況を見せる）。
  if (registered && !job) return <Navigate to="/manage" replace />;

  const onSubmit = async (event: FormEvent) => {
    event.preventDefault();
    setSubmitting(true);
    setError(null);
    try {
      const result = await callApi("register", { body: { consent: { externalAi: true } } });
      setJob(result.job);
      await refresh();
    } catch (err) {
      setError(err instanceof ApiError ? err.message : "登録できませんでした。もう一度試してください。");
    } finally {
      setSubmitting(false);
    }
  };

  if (job) {
    return (
      <section className="panel narrow" aria-labelledby="register-heading">
        <h1 id="register-heading" className="page-heading">
          最初の作品を作っています
        </h1>
        <p className="muted">@{handle} さんの直近の投稿から、最初の作品を生成しています。</p>
        <JobProgress job={job} onFinished={setFinished} />
        {finished?.status === "done" ? (
          <>
            <p className="muted">これからは、Bluesky に投稿するたびに作品が次の姿に変わります。</p>
            <p className="actions">
              <Link className="button primary" to={actorPath(handle)}>
                自分のギャラリーを見る
              </Link>
            </p>
          </>
        ) : null}
      </section>
    );
  }

  return (
    <section className="panel narrow" aria-labelledby="register-heading">
      <h1 id="register-heading" className="page-heading">
        はじめる前に
      </h1>
      <p>
        @{handle} さんの投稿から、あなただけのアートを作ります。作品を作るために、次の情報を外部の AI に送ります。
      </p>
      <dl className="facts wide">
        <dt>送るもの</dt>
        <dd>直近 100 件の投稿の本文と投稿日時、総投稿数・フォロー数などの公開されている統計</dd>
        <dt>送り先</dt>
        <dd>Anthropic の Claude API（描画関数の生成に使います）</dd>
        <dt>これ以降</dt>
        <dd>Bluesky に投稿するたびに、その投稿と直前の作品を同じ送り先に送ります</dd>
        <dt>作品の保存先</dt>
        <dd>あなたの Bluesky のデータ置き場（PDS）に公開のレコードとして保存し、ギャラリーに掲載します</dd>
        <dt>公開されるもの</dt>
        <dd>
          作品のほかに、投稿から推定した感情や性格の傾向と、投稿の時間帯や頻度などの特徴が、作品のレコードに入って誰でも読める状態になります
        </dd>
      </dl>
      <p className="muted">生成の停止とギャラリーへの掲載は、あとから管理画面で変えられます。</p>
      <form className="form" onSubmit={(event) => void onSubmit(event)}>
        <label className="check">
          <input type="checkbox" checked={agreed} onChange={(event) => setAgreed(event.target.checked)} />
          <span>投稿を外部の AI に送ることと、推定結果が作品と一緒に公開されることに同意します</span>
        </label>
        {error ? (
          <p className="form-error" role="alert">
            {error}
          </p>
        ) : null}
        <button type="submit" className="button primary" disabled={!agreed || submitting}>
          {submitting ? "登録中…" : "同意して最初の作品を作る"}
        </button>
      </form>
    </section>
  );
}
