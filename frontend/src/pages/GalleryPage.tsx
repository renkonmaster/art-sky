import type { ArtworkView } from "@art-sky/api";
import { useCallback, useEffect, useState } from "react";
import { callApi } from "../api/client.ts";
import { ArtworkCollection } from "../components/ArtworkCollection.tsx";
import { LayoutSwitch } from "../components/LayoutSwitch.tsx";
import { ErrorNote, Loading } from "../components/States.tsx";
import { useLayout } from "../lib/useLayout.ts";

const PAGE_SIZE = 30;

/** 全体ギャラリー：参加者ごとの最新作品を、更新が新しい順に並べる。配置は切り替えられる。 */
export function GalleryPage() {
  const [items, setItems] = useState<ArtworkView[]>([]);
  const [cursor, setCursor] = useState<string | undefined>();
  const [loading, setLoading] = useState(true);
  const [error, setError] = useState<Error | null>(null);
  const [layout, setLayout] = useLayout();

  const load = useCallback(async (from: string | undefined, signal?: AbortSignal) => {
    setLoading(true);
    setError(null);
    try {
      const page = await callApi("listLatest", {
        query: { limit: PAGE_SIZE, ...(from ? { cursor: from } : {}) },
        ...(signal ? { signal } : {}),
      });
      setItems((prev) => {
        if (!from) return page.items;
        const seen = new Set(prev.map((i) => i.uri));
        return [...prev, ...page.items.filter((i) => !seen.has(i.uri))];
      });
      setCursor(page.cursor);
    } catch (err) {
      if (signal?.aborted) return;
      setError(err instanceof Error ? err : new Error(String(err)));
    } finally {
      if (!signal?.aborted) setLoading(false);
    }
  }, []);

  useEffect(() => {
    const controller = new AbortController();
    void load(undefined, controller.signal);
    return () => controller.abort();
  }, [load]);

  // 1 枚ずつの配置では、終わりが近づいたら続きを自動で読み込む。
  const loadMore = useCallback(() => {
    if (cursor && !loading) void load(cursor);
  }, [cursor, loading, load]);

  return (
    <section aria-labelledby="gallery-heading">
      <div className="toolbar">
        <h1 id="gallery-heading" className="page-heading">
          みんなの最新作品
        </h1>
        <LayoutSwitch layout={layout} onChange={setLayout} />
      </div>
      {items.length > 0 ? (
        <ArtworkCollection items={items} layout={layout} variant="author" onNearEnd={loadMore} />
      ) : null}
      {!loading && !error && items.length === 0 ? <p className="state">まだ作品がありません。</p> : null}
      {loading && items.length === 0 ? <Loading /> : null}
      {error ? <ErrorNote error={error} /> : null}
      {layout === "tiles" && cursor && !loading ? (
        <p className="more">
          <button type="button" className="button" onClick={() => void load(cursor)}>
            もっと見る
          </button>
        </p>
      ) : null}
    </section>
  );
}
