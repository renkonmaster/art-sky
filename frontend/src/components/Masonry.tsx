import { type ReactNode, useEffect, useMemo, useRef, useState } from "react";

interface Props<T> {
  items: readonly T[];
  getKey: (item: T) => string;
  /** タイルの高さ ÷ 幅（絵の部分）。列の振り分けに使う。 */
  getRatio: (item: T) => number;
  render: (item: T) => ReactNode;
  /** 列の最小幅（px）。これを下回らない範囲で列を増やす。 */
  minColumnWidth?: number;
  gap?: number;
  /** 絵の下に付く説明の高さ（px）。振り分けの見積もりに使う。 */
  captionHeight?: number;
}

/**
 * 高さの違うタイルを縦に積む。新しい順を保つため、先頭から順に「いちばん低い列」へ置く。
 */
export function Masonry<T>({ items, getKey, getRatio, render, minColumnWidth = 260, gap = 20, captionHeight = 64 }: Props<T>) {
  const ref = useRef<HTMLDivElement>(null);
  const [width, setWidth] = useState(0);

  useEffect(() => {
    const el = ref.current;
    if (!el) return;
    setWidth(el.clientWidth);
    const observer = new ResizeObserver(() => setWidth(el.clientWidth));
    observer.observe(el);
    return () => observer.disconnect();
  }, []);

  const columns = useMemo(() => {
    const count = Math.max(1, Math.floor((width + gap) / (minColumnWidth + gap)));
    const columnWidth = Math.max(1, (width - gap * (count - 1)) / count);
    const cols: T[][] = Array.from({ length: count }, () => []);
    const heights = new Array<number>(count).fill(0);
    for (const item of items) {
      let target = 0;
      for (let i = 1; i < count; i++) if ((heights[i] as number) < (heights[target] as number) - 1) target = i;
      (cols[target] as T[]).push(item);
      heights[target] = (heights[target] as number) + columnWidth * getRatio(item) + captionHeight + gap;
    }
    return cols;
  }, [items, width, gap, minColumnWidth, captionHeight, getRatio]);

  return (
    <div ref={ref} className="masonry" style={{ gap }}>
      {width > 0
        ? columns.map((column, index) => (
            // biome-ignore lint/suspicious/noArrayIndexKey: 列は位置で決まる
            <div key={index} className="masonry-column" style={{ gap }}>
              {column.map((item) => (
                <div key={getKey(item)}>{render(item)}</div>
              ))}
            </div>
          ))
        : null}
    </div>
  );
}
