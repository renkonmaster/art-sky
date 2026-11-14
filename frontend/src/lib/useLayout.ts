import { useCallback, useState } from "react";

/** feed: 1 枚ずつ縦に流す。tiles: タイルを敷き詰める。 */
export type GalleryLayout = "feed" | "tiles";

const KEY = "art-sky.gallery-layout";

function read(): GalleryLayout {
  try {
    return window.localStorage.getItem(KEY) === "tiles" ? "tiles" : "feed";
  } catch {
    return "feed"; // プライベートウィンドウなどで読めないとき
  }
}

/** ギャラリーの配置。選んだ配置はブラウザに覚えておき、次に開いたときも同じにする。 */
export function useLayout(): [GalleryLayout, (layout: GalleryLayout) => void] {
  const [layout, setLayout] = useState<GalleryLayout>(read);
  const change = useCallback((next: GalleryLayout) => {
    setLayout(next);
    try {
      window.localStorage.setItem(KEY, next);
    } catch {
      // 保存できなくても、この画面の間は切り替わる。
    }
  }, []);
  return [layout, change];
}
