import type { ArtworkView } from "@art-sky/api";
import { useCallback } from "react";
import type { GalleryLayout } from "../lib/useLayout.ts";
import { ArtworkTile, tileRatio } from "./ArtworkTile.tsx";
import { Feed } from "./Feed.tsx";
import { Masonry } from "./Masonry.tsx";

interface Props {
  items: readonly ArtworkView[];
  layout: GalleryLayout;
  variant: "author" | "history";
  onNearEnd?: (() => void) | undefined;
}

/** 作品の並びを、選ばれた配置で表示する。 */
export function ArtworkCollection({ items, layout, variant, onNearEnd }: Props) {
  const getKey = useCallback((view: ArtworkView) => view.uri, []);
  const render = useCallback((view: ArtworkView) => <ArtworkTile view={view} variant={variant} />, [variant]);
  if (layout === "feed") return <Feed items={items} variant={variant} onNearEnd={onNearEnd} />;
  return <Masonry items={items} getKey={getKey} getRatio={tileRatio} render={render} />;
}
