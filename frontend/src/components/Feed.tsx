import { ArtworkRecord, type ArtworkView } from "@art-sky/api";
import { type CSSProperties, useCallback, useEffect, useRef, useState } from "react";
import { Link } from "react-router";
import { actorPath, artworkPath } from "../lib/atUri.ts";
import { formatDateTime, formatRelative } from "../lib/format.ts";
import { ArtworkFrame } from "./ArtworkFrame.tsx";
import { Avatar } from "./Avatar.tsx";

/** 自動で次へ進む間隔。 */
const AUTOPLAY_MS = 7000;

interface Props {
  items: readonly ArtworkView[];
  /** author: 作者を主に見せる（全体ギャラリー）。history: 日付を主に見せる（個人ギャラリー）。 */
  variant: "author" | "history";
  /** 終わりが近づいたら呼ぶ。続きの読み込みに使う。 */
  onNearEnd?: (() => void) | undefined;
}

function info(view: ArtworkView): { createdAt: string; kind: string; ratio: number } {
  const parsed = ArtworkRecord.safeParse(view.record);
  return parsed.success
    ? {
        createdAt: parsed.data.createdAt,
        kind: parsed.data.kind,
        ratio: parsed.data.aspectRatio.width / parsed.data.aspectRatio.height,
      }
    : { createdAt: view.indexedAt, kind: "", ratio: 1 };
}

/**
 * 作品を 1 枚ずつ大きく、縦に並べて見せる。
 *
 * - ページをふつうにスクロールして見る。スクロールを止めたり引っかけたりはしない
 *   （ホイール、トラックパッド、スワイプの慣性がそのまま効く）。
 * - 画面の中央にある作品を「いま見ている作品」として、右の番号に出す。
 * - 上下のボタンと j / k キーで、前後の作品へなめらかに移る。
 * - 「自動で流す」を入れると、一定間隔で次の作品へ進む。
 * - 作品の描画は ArtworkFrame が画面に近いものだけ行う。
 */
export function Feed({ items, variant, onNearEnd }: Props) {
  const list = useRef<HTMLDivElement>(null);
  const [index, setIndex] = useState(0);
  const [autoplay, setAutoplay] = useState(false);

  // 画面の中央の線にかかっている作品を「いま見ている作品」とする。
  // スクロールのたびに計算するのではなく、線をまたいだときだけ知らせてもらう。
  useEffect(() => {
    const el = list.current;
    if (!el) return;
    const observer = new IntersectionObserver(
      (entries) => {
        for (const entry of entries) {
          if (entry.isIntersecting) setIndex(Number((entry.target as HTMLElement).dataset.index));
        }
      },
      { rootMargin: "-50% 0px -50% 0px", threshold: 0 },
    );
    for (const slide of el.querySelectorAll(".feed-slide")) observer.observe(slide);
    return () => observer.disconnect();
  }, [items.length]);

  const go = useCallback(
    (target: number) => {
      const slides = list.current?.querySelectorAll<HTMLElement>(".feed-slide");
      if (!slides || slides.length === 0) return;
      const clamped = Math.max(0, Math.min(slides.length - 1, target));
      const reduce = window.matchMedia("(prefers-reduced-motion: reduce)").matches;
      slides[clamped]?.scrollIntoView({ behavior: reduce ? "auto" : "smooth", block: "center" });
    },
    [],
  );

  useEffect(() => {
    if (index >= items.length - 2) onNearEnd?.();
  }, [index, items.length, onNearEnd]);

  // 自動で流す。最後まで来たら先頭に戻る。タブが裏にある間は進めない。
  useEffect(() => {
    if (!autoplay || items.length < 2) return;
    const timer = setInterval(() => {
      if (document.hidden) return;
      go(index >= items.length - 1 ? 0 : index + 1);
    }, AUTOPLAY_MS);
    return () => clearInterval(timer);
  }, [autoplay, index, items.length, go]);

  // j / k で前後の作品へ。矢印キーやスペースは、ブラウザのふつうのスクロールに任せる。
  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (event.ctrlKey || event.metaKey || event.altKey) return;
      if (event.target instanceof HTMLElement && event.target.closest("input, textarea, select, [contenteditable]")) return;
      if (event.key === "j") go(index + 1);
      else if (event.key === "k") go(index - 1);
    };
    window.addEventListener("keydown", onKeyDown);
    return () => window.removeEventListener("keydown", onKeyDown);
  }, [go, index]);

  return (
    <div className="feed">
      <div ref={list} className="feed-list">
        {items.map((view, i) => {
          const { createdAt, kind, ratio } = info(view);
          const name = view.author.displayName ?? view.author.handle;
          return (
            <article key={view.uri} className="feed-slide" data-index={i} aria-label={`${name}の作品`}>
              <div className="feed-art" style={{ "--ratio": ratio } as CSSProperties}>
                <Link to={artworkPath(view.uri)} aria-label={`${name}の作品の詳細を開く`}>
                  <ArtworkFrame uri={view.uri} record={view.record} renderSize={1080} label={`${name}の作品`} />
                </Link>
              </div>
              <div className="feed-caption">
                {variant === "author" ? (
                  <Link className="tile-author" to={actorPath(view.author.handle)}>
                    <Avatar author={view.author} size={40} />
                    <span className="tile-author-text">
                      <span className="tile-name">{name}</span>
                      <span className="tile-handle">@{view.author.handle}</span>
                    </span>
                  </Link>
                ) : null}
                <div className="feed-date">
                  <time className="tile-handle" dateTime={createdAt} title={formatDateTime(createdAt)}>
                    {variant === "history" && kind === "genesis" ? "最初の作品・" : ""}
                    {formatRelative(createdAt)}
                  </time>
                </div>
              </div>
            </article>
          );
        })}
      </div>

      <div className="feed-controls">
        <button type="button" className="icon-button" onClick={() => go(index - 1)} disabled={index <= 0} aria-label="前の作品">
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 15l6-6 6 6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <span className="feed-count" aria-live="polite">
          {items.length === 0 ? 0 : index + 1} / {items.length}
        </span>
        <button
          type="button"
          className="icon-button"
          onClick={() => go(index + 1)}
          disabled={index >= items.length - 1}
          aria-label="次の作品"
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            <path d="M6 9l6 6 6-6" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
          </svg>
        </button>
        <button
          type="button"
          className="icon-button"
          aria-pressed={autoplay}
          aria-label="自動で流す"
          title={autoplay ? "自動で流すのを止める" : "自動で流す"}
          onClick={() => setAutoplay((value) => !value)}
        >
          <svg viewBox="0 0 24 24" width="20" height="20" aria-hidden="true">
            {autoplay ? (
              <path d="M8 5h3v14H8zM13 5h3v14h-3z" fill="currentColor" />
            ) : (
              <path d="M8 5l11 7-11 7z" fill="currentColor" />
            )}
          </svg>
        </button>
      </div>
    </div>
  );
}
