import { ArtworkRecord } from "@art-sky/api";
import { Link, useParams } from "react-router";
import { callApi } from "../api/client.ts";
import { useLoad } from "../api/useApi.ts";
import { useAuth } from "../auth/AuthContext.tsx";
import { ArtworkFrame } from "../components/ArtworkFrame.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { ErrorNote, Loading } from "../components/States.tsx";
import { actorPath, artworkPath, artworkUri, blueskyPostUrl } from "../lib/atUri.ts";
import { formatDateTime } from "../lib/format.ts";

/** 作品詳細：作品を大きく描画し、作者・生成日時・元投稿・前後の作品へのリンクを見せる。 */
export function ArtworkPage() {
  const { did = "", rkey = "" } = useParams();
  const uri = artworkUri(did, rkey);
  const state = useLoad((signal) => callApi("getArtwork", { query: { uri }, signal }), [uri]);
  const { user } = useAuth();

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNote error={state.error} notFound="作品が見つかりませんでした。" />;

  const { artwork, previous, next } = state.data;
  const parsed = ArtworkRecord.safeParse(artwork.record);
  const record = parsed.success ? parsed.data : null;
  const name = artwork.author.displayName ?? artwork.author.handle;
  const postUrl = record?.trigger ? blueskyPostUrl(record.trigger.uri) : null;
  const wide = record ? record.aspectRatio.width > record.aspectRatio.height : false;

  return (
    <article className="detail" data-wide={wide}>
      <div className="detail-art">
        <ArtworkFrame uri={artwork.uri} record={artwork.record} renderSize={1200} label={`${name}の作品`} />
      </div>
      <div className="detail-side">
        <Link className="tile-author" to={actorPath(artwork.author.handle)}>
          <Avatar author={artwork.author} size={40} />
          <span className="tile-author-text">
            <span className="tile-name">{name}</span>
            <span className="tile-handle">@{artwork.author.handle}</span>
          </span>
        </Link>
        {record ? (
          <dl className="facts">
            <dt>生成日時</dt>
            <dd>
              <time dateTime={record.createdAt}>{formatDateTime(record.createdAt)}</time>
            </dd>
            <dt>種類</dt>
            <dd>{record.kind === "genesis" ? "最初の作品（過去の投稿から生成）" : "投稿をきっかけに変化した作品"}</dd>
            <dt>形式</dt>
            <dd>{record.renderer.animated ? "アニメーション" : "静止画"}</dd>
            {postUrl ? (
              <>
                <dt>元の投稿</dt>
                <dd>
                  <a href={postUrl} target="_blank" rel="noreferrer">
                    Bluesky で見る
                  </a>
                </dd>
              </>
            ) : null}
          </dl>
        ) : null}
        {user?.did === artwork.author.did ? (
          <p className="actions">
            <Link className="button primary" to={`${artworkPath(artwork.uri)}/card`}>
              この作品を名刺にする
            </Link>
          </p>
        ) : null}
        <nav className="detail-nav" aria-label="前後の作品">
          {previous ? (
            <Link className="button" to={artworkPath(previous)} rel="prev">
              ← 前の作品
            </Link>
          ) : (
            <span className="button" aria-disabled="true">
              ← 前の作品
            </span>
          )}
          {next ? (
            <Link className="button" to={artworkPath(next)} rel="next">
              次の作品 →
            </Link>
          ) : (
            <span className="button" aria-disabled="true">
              次の作品 →
            </span>
          )}
        </nav>
      </div>
    </article>
  );
}
