import { useParams } from "react-router";
import { callApi } from "../api/client.ts";
import { useLoad } from "../api/useApi.ts";
import { ArtworkCollection } from "../components/ArtworkCollection.tsx";
import { Avatar } from "../components/Avatar.tsx";
import { LayoutSwitch } from "../components/LayoutSwitch.tsx";
import { ErrorNote, Loading } from "../components/States.tsx";
import { useLayout } from "../lib/useLayout.ts";

/** 個人ギャラリー：1 人の作品を新しい順に並べ、変化をたどれるようにする。 */
export function ActorPage() {
  const { actor = "" } = useParams();
  const state = useLoad((signal) => callApi("listByActor", { query: { actor, limit: 100 }, signal }), [actor]);
  const [layout, setLayout] = useLayout();

  if (state.status === "loading") return <Loading />;
  if (state.status === "error") return <ErrorNote error={state.error} notFound="この人の作品は見つかりませんでした。" />;

  const { author, items } = state.data;
  const name = author.displayName ?? author.handle;
  return (
    <section aria-labelledby="actor-heading">
      <div className="actor-header">
        <Avatar author={author} size={56} />
        <div>
          <h1 id="actor-heading" className="page-heading">
            {name}
          </h1>
          <p className="muted">
            @{author.handle}・{items.length} 作品
          </p>
        </div>
        <LayoutSwitch layout={layout} onChange={setLayout} />
      </div>
      {items.length > 0 ? (
        <ArtworkCollection items={items} layout={layout} variant="history" />
      ) : (
        <p className="state">まだ作品がありません。</p>
      )}
    </section>
  );
}
