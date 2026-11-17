import { ArtworkRecord, type ArtworkView } from "@art-sky/api";
import { Link } from "react-router";
import { actorPath, artworkPath } from "../lib/atUri.ts";
import { formatDateTime, formatRelative } from "../lib/format.ts";
import { ArtworkFrame } from "./ArtworkFrame.tsx";
import { Avatar } from "./Avatar.tsx";

/** タイルの絵の部分の、高さ ÷ 幅。 */
export function tileRatio(view: ArtworkView): number {
  const parsed = ArtworkRecord.safeParse(view.record);
  return parsed.success ? parsed.data.aspectRatio.height / parsed.data.aspectRatio.width : 1;
}

function recordInfo(view: ArtworkView): { createdAt: string; kind: string } {
  const parsed = ArtworkRecord.safeParse(view.record);
  return parsed.success
    ? { createdAt: parsed.data.createdAt, kind: parsed.data.kind }
    : { createdAt: view.indexedAt, kind: "" };
}

interface Props {
  view: ArtworkView;
  /** 全体ギャラリーでは作者を、個人ギャラリーでは日付を主に見せる。 */
  variant: "author" | "history";
}

export function ArtworkTile({ view, variant }: Props) {
  const { createdAt, kind } = recordInfo(view);
  const name = view.author.displayName ?? view.author.handle;
  return (
    <article className="tile">
      <Link className="tile-art" to={artworkPath(view.uri)} aria-label={`${name}の作品を開く`}>
        <ArtworkFrame uri={view.uri} record={view.record} label={`${name}の作品`} />
      </Link>
      {variant === "author" ? (
        <div className="tile-caption">
          <Link className="tile-author" to={actorPath(view.author.handle)}>
            <Avatar author={view.author} size={32} />
            <span className="tile-author-text">
              <span className="tile-name">{name}</span>
              <span className="tile-handle">@{view.author.handle}</span>
            </span>
          </Link>
          <time className="tile-time" dateTime={createdAt} title={formatDateTime(createdAt)}>
            {formatRelative(createdAt)}
          </time>
        </div>
      ) : (
        <div className="tile-caption">
          <span className="tile-author-text">
            <span className="tile-handle">{kind === "genesis" ? "最初の作品" : formatDateTime(createdAt)}</span>
          </span>
          <time className="tile-time" dateTime={createdAt} title={formatDateTime(createdAt)}>
            {formatRelative(createdAt)}
          </time>
        </div>
      )}
    </article>
  );
}
