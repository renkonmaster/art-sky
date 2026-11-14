/**
 * 作品の絵を名刺の形に加工して、キャンバスに描く。
 *
 * 大きさは日本の名刺（91mm × 55mm）と同じ縦横比で、1 mm を 20 画素として描く
 * （横向きで 1820 × 1100 画素。約 508dpi なので、そのまま印刷にも使える）。
 */

export type CardOrientation = "landscape" | "portrait";
export type CardTheme = "dark" | "light";

export interface CardContent {
  /** 作品のスナップショット。 */
  image: ImageBitmap;
  name: string;
  handle: string;
  title: string;
  /** ISO 8601 の生成日時。 */
  createdAt: string;
}

export interface CardOptions {
  orientation: CardOrientation;
  theme: CardTheme;
}

const LONG = 1820;
const SHORT = 1100;
const FONT = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif';

const THEMES: Record<CardTheme, { panel: string; text: string; muted: string }> = {
  dark: { panel: "#101014", text: "#f4f4f6", muted: "#9a9aa8" },
  light: { panel: "#faf9f6", text: "#17171c", muted: "#6a6a75" },
};

export function cardSize(orientation: CardOrientation): { width: number; height: number } {
  return orientation === "landscape" ? { width: LONG, height: SHORT } : { width: SHORT, height: LONG };
}

/** 絵の中心を残して、枠いっぱいに切り抜いて描く。 */
function drawCover(ctx: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

/** 絵全体の平均の色。名刺の差し色に使う。 */
function averageColor(image: ImageBitmap): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  if (!ctx) return "#8ab4ff";
  ctx.drawImage(image, 0, 0, 1, 1);
  const [r = 138, g = 180, b = 255] = ctx.getImageData(0, 0, 1, 1).data;
  // 暗すぎる・くすんだ色は差し色として見えないので、明るさを持ち上げる。
  const max = Math.max(r, g, b, 1);
  const lift = Math.max(1, 170 / max);
  const c = (v: number) => Math.min(255, Math.round(v * lift));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/** 幅に収まるまで文字を小さくし、それでも収まらなければ末尾を「…」にする。 */
function fitText(
  ctx: CanvasRenderingContext2D,
  text: string,
  maxWidth: number,
  weight: number,
  size: number,
  minSize: number,
): { text: string; size: number } {
  let current = size;
  const measure = (value: string) => {
    ctx.font = `${weight} ${current}px ${FONT}`;
    return ctx.measureText(value).width;
  };
  while (current > minSize && measure(text) > maxWidth) current -= 2;
  if (measure(text) <= maxWidth) return { text, size: current };
  const chars = [...text];
  while (chars.length > 1 && measure(`${chars.join("")}…`) > maxWidth) chars.pop();
  return { text: `${chars.join("")}…`, size: current };
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}.${pad(date.getMonth() + 1)}.${pad(date.getDate())}`;
}

/** 名刺を描く。キャンバスの大きさもここで決める。 */
export function drawCard(canvas: HTMLCanvasElement, content: CardContent, options: CardOptions): void {
  const { width, height } = cardSize(options.orientation);
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("キャンバスを使えません");
  const theme = THEMES[options.theme];
  const landscape = options.orientation === "landscape";

  // 絵の枠と、文字を置く枠。
  const art = landscape ? { x: 0, y: 0, w: 1000, h: height } : { x: 0, y: 0, w: width, h: 1100 };
  const panel = landscape
    ? { x: art.w, y: 0, w: width - art.w, h: height }
    : { x: 0, y: art.h, w: width, h: height - art.h };

  ctx.fillStyle = theme.panel;
  ctx.fillRect(0, 0, width, height);
  drawCover(ctx, content.image, art.x, art.y, art.w, art.h);

  const pad = 84;
  const left = panel.x + pad;
  const maxWidth = panel.w - pad * 2;
  const accent = averageColor(content.image);
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // 上：サービス名
  ctx.fillStyle = theme.muted;
  ctx.font = `600 30px ${FONT}`;
  ctx.letterSpacing = "6px";
  ctx.fillText("ART-SKY", left, panel.y + pad + 26);
  ctx.letterSpacing = "0px";

  // 中央：名前とハンドル名
  const centerY = panel.y + panel.h * (landscape ? 0.47 : 0.45);
  const name = fitText(ctx, content.name, maxWidth, 700, landscape ? 88 : 96, 44);
  ctx.fillStyle = theme.text;
  ctx.font = `700 ${name.size}px ${FONT}`;
  ctx.fillText(name.text, left, centerY);
  const handle = fitText(ctx, `@${content.handle}`, maxWidth, 400, 36, 24);
  ctx.fillStyle = theme.muted;
  ctx.font = `400 ${handle.size}px ${FONT}`;
  ctx.fillText(handle.text, left, centerY + 62);
  ctx.fillStyle = accent;
  ctx.fillRect(left, centerY + 104, 120, 8);

  // 下：作品の題名と生成日
  const bottom = panel.y + panel.h - pad;
  const title = fitText(ctx, `「${content.title}」`, maxWidth + 20, 500, 38, 26);
  ctx.fillStyle = theme.text;
  ctx.font = `500 ${title.size}px ${FONT}`;
  ctx.fillText(title.text, left - 20, bottom - 48); // かぎ括弧のぶん少し左へ寄せて、文字の頭をそろえる
  ctx.fillStyle = theme.muted;
  ctx.font = `400 28px ${FONT}`;
  ctx.fillText(formatDate(content.createdAt), left, bottom);
}

/** キャンバスを PNG にする。 */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("画像にできませんでした"))), "image/png");
  });
}
