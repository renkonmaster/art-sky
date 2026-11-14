import { type FormEvent, useState } from "react";
import { Navigate, useSearchParams } from "react-router";
import { useAuth } from "../auth/AuthContext.tsx";
import { Loading } from "../components/States.tsx";

const ERROR_TEXT: Record<string, string> = {
  invalid_handle: "ハンドル名を確認してください。",
  access_denied: "Bluesky での許可が取り消されました。",
};

/** サイト内のパスだけを戻り先として受け付ける。 */
function safeNext(value: string | null): string {
  return value && /^\/(?!\/)/.test(value) ? value : "/manage";
}

/** ログイン：ハンドル名を入力して、Bluesky の認可画面へ進む。 */
export function LoginPage() {
  const { loading, user } = useAuth();
  const [params] = useSearchParams();
  const [handle, setHandle] = useState("");
  const [submitting, setSubmitting] = useState(false);
  const next = safeNext(params.get("next"));
  const error = params.get("error");

  if (loading) return <Loading />;
  if (user) return <Navigate to={user.registered ? next : "/register"} replace />;

  const onSubmit = (event: FormEvent) => {
    event.preventDefault();
    const value = handle.trim().replace(/^@/, "");
    if (!value) return;
    setSubmitting(true);
    // 認可は画面遷移で行う（docs/api.md の「認証」）。
    window.location.assign(`/oauth/login?handle=${encodeURIComponent(value)}&returnTo=${encodeURIComponent(next)}`);
  };

  return (
    <section className="panel narrow" aria-labelledby="login-heading">
      <h1 id="login-heading" className="page-heading">
        ログイン
      </h1>
      <p className="muted">Bluesky のアカウントでログインします。パスワードをこのサイトに入力することはありません。</p>
      {error ? (
        <p className="form-error" role="alert">
          ログインできませんでした。{ERROR_TEXT[error] ?? "もう一度試してください。"}
        </p>
      ) : null}
      <form className="form" onSubmit={onSubmit}>
        <label className="field">
          <span className="field-label">ハンドル名</span>
          <input
            className="input"
            name="handle"
            value={handle}
            onChange={(event) => setHandle(event.target.value)}
            placeholder="example.bsky.social"
            autoComplete="username"
            autoCapitalize="none"
            spellCheck={false}
            required
          />
        </label>
        <button type="submit" className="button primary" disabled={submitting || handle.trim() === ""}>
          {submitting ? "移動中…" : "Bluesky でログイン"}
        </button>
      </form>
      {__MOCK__ ? (
        <p className="hint">
          開発用のモックで動いています。どんなハンドル名でもログインでき、認可画面は出ません。
          <code>mio.example.com</code> と入れると、登録済みの人として入れます。
        </p>
      ) : null}
    </section>
  );
}
