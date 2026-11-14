import { ArtworkRecord, type ArtworkView } from "@art-sky/api";
import { useEffect, useMemo, useRef, useState } from "react";
import { Link, useParams } from "react-router";
import { callApi } from "../api/client.ts";
import { useLoad } from "../api/useApi.ts";
import { RequireAuth } from "../auth/RequireAuth.tsx";
import { ErrorNote, Loading } from "../components/States.tsx";
import { useArtworkSnapshot } from "../components/useArtworkSnapshot.tsx";
import { artworkPath, artworkUri } from "../lib/atUri.ts";
import { type CardOrientation, type CardTheme, canvasToPng, cardSize, drawCard, loadAvatar } from "../lib/card.ts";

/** 名刺：自分の作品の絵を名刺の形に加工して、画像として書き出す。 */
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
const THEMES: ReadonlyArray<{ value: CardTheme; label: string }> = [
  { value: "light", label: "白" },
  { value: "dark", label: "黒" },
];

/** この作品が何作目か（1 始まり）と、これまでの作品数。 */
interface Position {
  number: number;
  works: number;
}

function CardEditor({ view }: { view: ArtworkView }) {
  const record = useMemo(() => {
    const parsed = ArtworkRecord.safeParse(view.record);
    return parsed.success ? parsed.data : null;
  }, [view.record]);
  const { frame, state } = useArtworkSnapshot(record, 1600);
  const canvasRef = useRef<HTMLCanvasElement>(null);
  const [orientation, setOrientation] = useState<CardOrientation>("landscape");
  const [theme, setTheme] = useState<CardTheme>("light");
  const [drawn, setDrawn] = useState(false);
  const [saving, setSaving] = useState(false);
  const [error, setError] = useState<string | null>(null);

  const name = view.author.displayName ?? view.author.handle;
  const title = record?.title ?? "無題";
  const image = state.status === "ready" ? state.image : null;

  // 何作目かは、その人の作品の一覧から数える。取れなくても名刺は作れる（番号を省く）。
  const [position, setPosition] = useState<Position | null>(null);
  useEffect(() => {
    let cancelled = false;
    callApi("listByActor", { query: { actor: view.author.did, limit: 100 } }).then(
      (page) => {
        // 一覧は新しい順。続きがある（100 件を超える）ときは数えきれないので省く。
        const index = page.items.findIndex((item) => item.uri === view.uri);
        if (!cancelled && index >= 0 && !page.cursor) {
          setPosition({ number: page.items.length - index, works: page.items.length });
        }
      },
      () => undefined,
    );
    return () => {
      cancelled = true;
    };
  }, [view.author.did, view.uri]);

  // アバターは読み込めたときだけ使う。undefined は読み込み中。
  const [avatar, setAvatar] = useState<ImageBitmap | null | undefined>(undefined);
  useEffect(() => {
    let cancelled = false;
    void loadAvatar(view.author.avatar).then((bitmap) => {
      if (!cancelled) setAvatar(bitmap);
    });
    return () => {
      cancelled = true;
    };
  }, [view.author.avatar]);

  useEffect(() => {
    const canvas = canvasRef.current;
    if (!canvas || !image || !record || avatar === undefined) return;
    drawCard(
      canvas,
      {
        image,
        avatar,
        name,
        handle: view.author.handle,
        title,
        createdAt: record.createdAt,
        serial: view.uri.split("/").at(-1) ?? "",
        number: position?.number,
        works: position?.works,
        postsCount: record.inputs?.profile?.postsCount,
        animated: record.renderer.animated,
        profileUrl: `https://bsky.app/profile/${view.author.handle}`,
      },
      { orientation, theme },
    );
    setDrawn(true);
  }, [image, avatar, position, record, name, title, view.author.handle, view.uri, orientation, theme]);

  const download = async () => {
    const canvas = canvasRef.current;
    if (!canvas) return;
    setSaving(true);
    setError(null);
    try {
      const url = URL.createObjectURL(await canvasToPng(canvas));
      const link = document.createElement("a");
      link.href = url;
      link.download = `art-sky-card-${view.author.handle}-${view.uri.split("/").at(-1)}.png`;
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
          aria-label={`${name}の名刺。背景は作品「${title}」の絵で、Bluesky のプロフィールへの QR コードが入っています`}
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
        {size.width} × {size.height} 画素（名刺と同じ 91 × 55 mm の比率）。QR コードは Bluesky のプロフィールを開きます。
        {record?.renderer.animated ? "アニメーション作品は、開始から 1.5 秒の時点の絵を使います。" : ""}
      </p>
      {frame}
    </section>
  );
}
