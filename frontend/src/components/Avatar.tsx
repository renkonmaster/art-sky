import type { AuthorView } from "@art-sky/api";

/** DID から決まる色相。アバター画像がない人の背景色に使う。 */
function hueOf(text: string): number {
  let h = 0;
  for (let i = 0; i < text.length; i++) h = (h * 31 + text.charCodeAt(i)) >>> 0;
  return h % 360;
}

export function Avatar({ author, size }: { author: AuthorView; size: number }) {
  const name = author.displayName ?? author.handle;
  const style = { width: size, height: size, fontSize: size * 0.45 };
  if (author.avatar) {
    return <img className="avatar" src={author.avatar} alt="" style={style} referrerPolicy="no-referrer" />;
  }
  const initial = [...name][0]?.toUpperCase() ?? "?";
  return (
    <span className="avatar" aria-hidden="true" style={{ ...style, background: `hsl(${hueOf(author.did)} 45% 42%)` }}>
      {initial}
    </span>
  );
}
