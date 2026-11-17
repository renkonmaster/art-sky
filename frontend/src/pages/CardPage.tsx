import { ArtworkRecord, type ArtworkView } from "@art-sky/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { callApi } from "../api/client.ts";
import { useLoad } from "../api/useApi.ts";
import { RequireAuth } from "../auth/RequireAuth.tsx";
import { ErrorNote, Loading } from "../components/States.tsx";
import { useArtworkSnapshot } from "../components/useArtworkSnapshot.tsx";
import { artworkPath, artworkUri } from "../lib/atUri.ts";
import { type BlueskyProfile, type CardOrientation, type CardStyle, type CardTheme, canvasToPng, cardSize, drawCard, fetchBlueskyProfile, loadAvatar } from "../lib/card.ts";

/** 名刺：Bluesky のプロフィール（表示名・ハンドル名・自己紹介・ID）に作品の絵を添えて、画像として書き出す。 */
export function CardPage() {
  const { did = "", rkey = "" } = useParams();
  return <RequireAuth>{(user) => <CardLoader uri={artworkUri(did, rkey)} viewerDid={user.did} />}</RequireAuth>;
}

function CardLoader({ uri, viewerDid }: { uri: string; viewerDid: string }) {
  const state = useLoad((signal) => callApi("getArtwork", { query: { uri }, signal }), [uri]);
  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNote error={state.error} notFound="作品が見つかりませんでした。" />;
  const { artwork } = state.data;
  if (artwork.author.did !== viewerDid) {
    return (
      <p className="state">
        名刺にできるのは自分の作品だけです。<Link to={artworkPath(uri)}>作品に戻る</Link>
      </p>
    );
  }
  return <CardEditor view={artwork} />;
}

const ORIENTATIONS: ReadonlyArray<{ value: CardOrientation; label: string }> = [
  { value: "landscape", label: "横" },
  { value: "portrait", label: "縦" },
];
const STYLES: ReadonlyArray<{ value: CardStyle; label: string }> = [
  { value: "full", label: "絵を全面に" },
  { value: "side", label: "絵を片側に" },
];
const THEMES: ReadonlyArray<{ value: CardTheme; label: string }> = [
  { value: "light", label: "白" },
  { value: "dark", label: "黒" },
];

function CardEditor({ view }: { view: ArtworkView }) {
  const record = useMemo(() => {
    const parsed = ArtworkRecord.safeParse(view.record);
    return parsed.success ? parsed.data : null;
  }, [view.record]);
  const { frame, state } = useArtworkSnapshot(record, 1600);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [orientation, setOrientation] = useState<CardOrientation>("landscape");
  const [theme, setTheme] = useState<CardTheme>("light");
  const [style, setStyle] = useState<CardStyle>("full");
  const [drawn, setDrawn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const image = state.status === "ready" ? state.image : null;

  // 最新のプロフィール（自己紹介など）は Bluesky から読む。undefined は読み込み中、null は読めなかった。
  const [profile, setProfile] = useState<BlueskyProfile | null | undefined>(undefined);
  useEffect(() => {
    const controller = new AbortController();
    void fetchBlueskyProfile(view.author.did, controller.signal).then((p) => {
      if (!controller.signal.aborted) setProfile(p);
    });
    return () => controller.abort();
  }, [view.author.did]);
  const name = profile?.displayName ?? view.author.displayName ?? view.author.handle;

  // アバターは読み込めたときだけ使う（読めなければ作品の絵で代える）。undefined は読み込み中。
  // Bluesky の画像配信は CORS に対応していないので、バックエンドの中継（/api/avatar）から読む。
  const [avatar, setAvatar] = useState<ImageBitmap | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadAvatar("/api/avatar").then((bitmap) => {
      if (!cancelled) setAvatar(bitmap);
    });
    return () => {
      cancelled = true;
    };
  }, []);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !record || avatar === undefined || profile === undefined) return;
    drawCard(
      canvas,
      {
        image,
        avatar,
        name,
        handle: view.author.handle,
        bio: profile?.description ?? "",
        did: view.author.did,
        profileUrl: `https://bsky.app/profile/${view.author.handle}`,
      },
      { orientation, theme, style },
    );
    setDrawn(true);
  }, [image, avatar, profile, record, name, view.author.handle, view.author.did, orientation, theme, style]);

  const download = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await canvasToPng(canvas));
      const link = document.createElement("a");
      link.href = url;
      link.download = `card-${view.author.handle}.png`;
      link.click();
      setTimeout(() => URL.revokeObjectURL(url), 10_000);
    } catch (err) {
      setError(err instanceof Error ? err.message : "書き出せませんでした");
    } finally {
      setSaving(false);
    }
  };

  const size = cardSize(orientation);
  return (
    <section className="card-page" aria-labelledby="card-heading">
      <div className="toolbar">
        <h1 id="card-heading" className="page-heading">
          名刺にする
        </h1>
        <Link className="button" to={artworkPath(view.uri)}>
          作品に戻る
        </Link>
      </div>

      <div className="card-stage" data-orientation={orientation}>
        <canvas
          ref={canvasRef}
          className="card-canvas"
          data-ready={drawn}
          width={size.width}
          height={size.height}
          role="img"
          aria-label={`${name}の名刺。表示名、ハンドル名、自己紹介、ID と、Bluesky のプロフィールへの QR コードが入っています`}
        />
        {state.status === "drawing" ? <p className="card-note">作品を描いています…</p> : null}
        {state.status === "error" || !record ? (
          <p className="card-note" role="alert">
            作品を描画できなかったので、名刺を作れません。
          </p>
        ) : null}
      </div>

      <div className="card-controls">
        <div className="segmented" role="group" aria-label="向き">
          {ORIENTATIONS.map((option) => (
            <button key={option.value} type="button" aria-pressed={orientation === option.value} onClick={() => setOrientation(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="絵の置き方">
          {STYLES.map((option) => (
            <button key={option.value} type="button" aria-pressed={style === option.value} onClick={() => setStyle(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <div className="segmented" role="group" aria-label="色">
          {THEMES.map((option) => (
            <button key={option.value} type="button" aria-pressed={theme === option.value} onClick={() => setTheme(option.value)}>
              {option.label}
            </button>
          ))}
        </div>
        <button type="button" className="button primary" disabled={!drawn || saving} onClick={() => void download()}>
          {saving ? "書き出し中…" : "PNG で保存"}
        </button>
      </div>
      {error ? (
        <p className="form-error" role="alert">
          {error}
        </p>
      ) : null}
      <p className="muted card-meta">
        {size.width} × {size.height} 画素（名刺と同じ 91 × 55 mm の比率）。表示名・自己紹介・アイコンは Bluesky の今のプロフィールを使います。
        QR コードは Bluesky のプロフィールを開きます。
      </p>
      {frame}
    </section>
  );
}
