import { ArtworkRecord } from "@art-sky/api";
import { buildSrcdoc, isRendererMessage } from "@art-sky/renderer";
import { useEffect, useId, useMemo, useRef, useState } from "react";

/** 描き終えた静止画の PNG（object URL）。同じ作品を二度描かないために覚えておく。 */
const snapshots = new Map<string, string>();

interface Props {
  /** 作品の AT URI。スナップショットのキーに使う。 */
  uri: string;
  /** 作品レコード（API から受け取ったままの値）。ここで検証する。 */
  record: unknown;
  /** キャンバスの長辺の画素数。 */
  renderSize?: number;
  /** 代替テキスト。 */
  label: string;
}

/** 画面に近づいてから描画を始めるまでの待ち時間。 */
const NEAR_DELAY_MS = 120;

type Phase = "idle" | "drawing" | "shown" | "error";

/**
 * 作品をその場で描画する。
 *
 * - コードは sandbox 付きの iframe（さらにその中の Worker）で動かす（packages/renderer）。
 * - 画面に近づいて、少しとどまったときだけ描画を始める。
 * - 静止画は描き終えたら PNG に置き換え、iframe を片づける。
 * - アニメーションは画面から外れたら止める。
 */
export function ArtworkFrame({ uri, record, renderSize = 720, label }: Props) {
  const parsed = useMemo(() => ArtworkRecord.safeParse(record), [record]);
  const artwork = parsed.success ? parsed.data : null;
  const supported = artwork?.renderer.runtime === "canvas2d" && artwork.renderer.version === "1";
  const animated = artwork?.renderer.animated === true;
  const cacheKey = `${uri}@${renderSize}`;

  const id = useId();
  const boxRef = useRef<HTMLDivElement>(null);
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [near, setNear] = useState(false);
  const [snapshot, setSnapshot] = useState<string | undefined>(() => snapshots.get(cacheKey));
  const [phase, setPhase] = useState<Phase>(snapshot ? "shown" : "idle");

  // 作品や大きさが変わったら最初からやり直す。
  useEffect(() => {
    const cached = snapshots.get(cacheKey);
    setSnapshot(cached);
    setPhase(cached ? "shown" : "idle");
  }, [cacheKey]);

  // 画面から 1 画面ぶん以内に近づいたら描画する。
  // 素早くスクロールして通り過ぎるだけの作品まで描き始めると引っかかるので、少しとどまってから始める。
  useEffect(() => {
    const box = boxRef.current;
    if (!box) return;
    let timer = 0;
    const observer = new IntersectionObserver(
      (entries) => {
        const intersecting = entries.some((entry) => entry.isIntersecting);
        window.clearTimeout(timer);
        if (intersecting) timer = window.setTimeout(() => setNear(true), NEAR_DELAY_MS);
        else setNear(false);
      },
      { rootMargin: "100% 0px" },
    );
    observer.observe(box);
    return () => {
      window.clearTimeout(timer);
      observer.disconnect();
    };
  }, []);

  const mountFrame = supported && near && !snapshot && phase !== "error";

  const srcdoc = useMemo(
    () => (artwork && mountFrame ? buildSrcdoc(artwork, { id, renderSize, snapshot: !animated }) : null),
    [artwork, mountFrame, id, renderSize, animated],
  );

  useEffect(() => {
    if (!srcdoc) return;
    setPhase("drawing");
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!isRendererMessage(message) || message.id !== id) return;
      if (message.type === "error") {
        console.warn(`作品を描画できませんでした: ${uri}: ${message.message}`);
        setPhase("error");
        return;
      }
      if (message.blob) {
        const url = URL.createObjectURL(message.blob);
        snapshots.set(cacheKey, url);
        setSnapshot(url);
      }
      setPhase("shown");
    };
    window.addEventListener("message", onMessage);
    return () => window.removeEventListener("message", onMessage);
  }, [srcdoc, id, uri, cacheKey]);

  const ratio = artwork ? `${artwork.aspectRatio.width} / ${artwork.aspectRatio.height}` : "1 / 1";
  const failed = !supported || phase === "error";

  return (
    <div
      ref={boxRef}
      className="artwork-frame"
      data-phase={failed ? "error" : phase}
      style={{ aspectRatio: ratio }}
      role="img"
      aria-label={label}
    >
      {snapshot ? (
        <img src={snapshot} alt="" draggable={false} decoding="async" />
      ) : srcdoc ? (
        // allow-same-origin は付けない。付けると作品のコードがこのページに触れられるようになる。
        <iframe ref={frameRef} sandbox="allow-scripts" srcDoc={srcdoc} title={label} tabIndex={-1} />
      ) : null}
      {failed ? <p className="artwork-frame-note">{supported ? "描画できませんでした" : "表示できない形式の作品です"}</p> : null}
    </div>
  );
}
