import type { ArtworkRecord } from "@art-sky/api";
import { buildSrcdoc, isRendererMessage } from "@art-sky/renderer";
import { type ReactNode, useEffect, useId, useMemo, useRef, useState } from "react";

export type SnapshotState =
  | { status: "drawing" }
  | { status: "ready"; image: ImageBitmap }
  | { status: "error"; message: string };

/**
 * 作品を画面に見せずに描画して、その絵（スナップショット）を受け取る。
 *
 * 返ってくる frame を画面のどこかに置くこと（見えない iframe で、その中で作品を描く）。
 * アニメーション作品は、開始から 1.5 秒の時点の絵になる（何度取っても同じ絵）。
 */
export function useArtworkSnapshot(artwork: ArtworkRecord | null, renderSize: number): { frame: ReactNode; state: SnapshotState } {
  const id = useId();
  const frameRef = useRef<HTMLIFrameElement>(null);
  const [state, setState] = useState<SnapshotState>({ status: "drawing" });

  const srcdoc = useMemo(
    () => (artwork ? buildSrcdoc(artwork, { id, renderSize, snapshot: true }) : null),
    [artwork, id, renderSize],
  );

  useEffect(() => {
    if (!srcdoc) return;
    setState({ status: "drawing" });
    let cancelled = false;
    const onMessage = (event: MessageEvent) => {
      if (event.source !== frameRef.current?.contentWindow) return;
      const message = event.data;
      if (!isRendererMessage(message) || message.id !== id) return;
      if (message.type === "error" || !message.blob) {
        setState({ status: "error", message: message.type === "error" ? message.message : "絵を受け取れませんでした" });
        return;
      }
      createImageBitmap(message.blob).then(
        (image) => {
          if (cancelled) image.close();
          else setState({ status: "ready", image });
        },
        () => {
          if (!cancelled) setState({ status: "error", message: "絵を読み込めませんでした" });
        },
      );
    };
    window.addEventListener("message", onMessage);
    return () => {
      cancelled = true;
      window.removeEventListener("message", onMessage);
    };
  }, [srcdoc, id]);

  const frame = srcdoc ? (
    // allow-same-origin は付けない（ArtworkFrame と同じ）。
    <iframe ref={frameRef} className="offscreen-frame" sandbox="allow-scripts" srcDoc={srcdoc} title="" aria-hidden="true" tabIndex={-1} />
  ) : null;
  return { frame, state };
}
