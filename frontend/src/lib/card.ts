import qrcode from "qrcode-generator";

/**
 * 作品の絵を背景にした名刺を、キャンバスに描く。
 *
 * 大きさは日本の名刺（91mm × 55mm）と同じ縦横比で、1 mm を 20 画素として描く
 * （横向きで 1820 × 1100 画素。約 508dpi なので、そのまま印刷にも使える）。
 *
 * 構成：背景いっぱいに作品の絵（文字が読めるように色をかぶせる）、左上にロゴとサービス名、
 * 右上に通し番号、大きな名前とハンドル名、作品の情報の枠、タグ、アイコン、QR コード、発行日。
 */

export type CardOrientation = "landscape" | "portrait";
export type CardTheme = "light" | "dark";

export interface CardContent {
  /** 作品のスナップショット。背景に使う。 */
  image: ImageBitmap;
  /** アバター画像。なければ、作品の絵をそのままアイコンの枠に入れる。 */
  avatar: ImageBitmap | null;
  name: string;
  handle: string;
  /** ISO 8601 の生成日時。 */
  createdAt: string;
  /** 右上に出す通し番号（作品のレコードキー）。 */
  serial: string;
  /** 何作目か（1 始まり）。分からなければ省く。 */
  number?: number | undefined;
  /** これまでの作品数。 */
  works?: number | undefined;
  /** 生成時点の総投稿数。 */
  postsCount?: number | undefined;
  animated: boolean;
  /** QR コードにする URL。 */
  profileUrl: string;
}

export interface CardOptions {
  orientation: CardOrientation;
  theme: CardTheme;
}

const LONG = 1820;
const SHORT = 1100;
const SANS = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", monospace';

interface Palette {
  /** 背景の絵にかぶせる色。 */
  wash: string;
  text: string;
  muted: string;
  /** 枠やタグの地の色。 */
  surface: string;
  surfaceLine: string;
}

const PALETTES: Record<CardTheme, Palette> = {
  light: {
    wash: "rgba(240, 242, 255, 0.74)",
    text: "#14162b",
    muted: "#565b76",
    surface: "rgba(255, 255, 255, 0.62)",
    surfaceLine: "rgba(255, 255, 255, 0.9)",
  },
  dark: {
    wash: "rgba(10, 12, 26, 0.7)",
    text: "#f5f5fa",
    muted: "#aeb2c8",
    surface: "rgba(18, 20, 40, 0.55)",
    surfaceLine: "rgba(255, 255, 255, 0.16)",
  },
};

/** 各部品の位置。横向きと縦向きで置き場所だけを変える。 */
interface Layout {
  width: number;
  height: number;
  margin: number;
  nameY: number;
  nameMaxWidth: number;
  nameSize: number;
  box: { x: number; y: number; w: number; h: number };
  tagsY: number;
  icon: { x: number; y: number; size: number };
  qr: { x: number; y: number; size: number };
}

const LAYOUTS: Record<CardOrientation, Layout> = {
  landscape: {
    width: LONG,
    height: SHORT,
    margin: 96,
    nameY: 348,
    nameMaxWidth: 1130,
    nameSize: 128,
    box: { x: 96, y: 474, w: 1040, h: 268 },
    tagsY: 800,
    icon: { x: LONG - 96 - 368, y: 214, size: 368 },
    qr: { x: LONG - 96 - 324, y: 664, size: 280 },
  },
  portrait: {
    width: SHORT,
    height: LONG,
    margin: 96,
    nameY: 800,
    nameMaxWidth: SHORT - 192,
    nameSize: 120,
    box: { x: 96, y: 930, w: SHORT - 192, h: 268 },
    tagsY: 1258,
    icon: { x: 96, y: 240, size: 400 },
    qr: { x: SHORT - 96 - 280, y: 1420, size: 280 },
  },
};

export function cardSize(orientation: CardOrientation): { width: number; height: number } {
  const { width, height } = LAYOUTS[orientation];
  return { width, height };
}

/** 絵の中心を残して、枠いっぱいに切り抜いて描く。 */
function drawCover(ctx: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

/** 絵全体の平均の色から、文字に使える差し色を作る（明るい地には濃く、暗い地には明るく）。 */
function accentColor(image: ImageBitmap, theme: CardTheme): string {
  const canvas = document.createElement("canvas");
  canvas.width = 1;
  canvas.height = 1;
  const ctx = canvas.getContext("2d");
  let [r, g, b] = [90, 110, 230];
  if (ctx) {
    ctx.drawImage(image, 0, 0, 1, 1);
    const data = ctx.getImageData(0, 0, 1, 1).data;
    [r, g, b] = [data[0] ?? r, data[1] ?? g, data[2] ?? b];
  }
  // 色味を強めてから、明るさを地に合わせる。
  const mean = (r + g + b) / 3;
  const boost = (v: number) => mean + (v - mean) * 2.2;
  const target = theme === "light" ? 95 : 190;
  const scale = target / Math.max(1, mean);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(boost(v) * scale)));
  return `rgb(${c(r)}, ${c(g)}, ${c(b)})`;
}

/** 幅に収まるまで文字を小さくし、それでも収まらなければ末尾を「…」にする。 */
function fitText(ctx: CanvasRenderingContext2D, text: string, maxWidth: number, font: (size: number) => string, size: number, minSize: number): { text: string; size: number } {
  let current = size;
  const measure = (value: string) => {
    ctx.font = font(current);
    return ctx.measureText(value).width;
  };
  while (current > minSize && measure(text) > maxWidth) current -= 2;
  if (measure(text) <= maxWidth) return { text, size: current };
  const chars = [...text];
  while (chars.length > 1 && measure(`${chars.join("")}…`) > maxWidth) chars.pop();
  return { text: `${chars.join("")}…`, size: current };
}

function roundRect(ctx: CanvasRenderingContext2D, x: number, y: number, w: number, h: number, r: number): void {
  ctx.beginPath();
  ctx.roundRect(x, y, w, h, r);
}

/** 文字の間隔を空けて描く（ラベル用）。 */
function spaced(ctx: CanvasRenderingContext2D, text: string, x: number, y: number, spacing: number): void {
  ctx.letterSpacing = `${spacing}px`;
  ctx.fillText(text, x, y);
  ctx.letterSpacing = "0px";
}

function formatDate(iso: string): string {
  const date = new Date(iso);
  const pad = (n: number) => String(n).padStart(2, "0");
  return `${date.getFullYear()}-${pad(date.getMonth() + 1)}-${pad(date.getDate())}`;
}

/** ロゴ：空（丸）と、そこから伸びる地平線。 */
function drawLogo(ctx: CanvasRenderingContext2D, x: number, y: number, size: number, color: string): void {
  ctx.save();
  ctx.strokeStyle = color;
  ctx.fillStyle = color;
  ctx.lineWidth = size * 0.1;
  ctx.lineCap = "round";
  ctx.beginPath();
  ctx.arc(x + size / 2, y + size * 0.42, size * 0.26, 0, Math.PI * 2);
  ctx.fill();
  for (const [dy, half] of [
    [0.82, 0.46],
    [0.98, 0.3],
  ] as const) {
    ctx.beginPath();
    ctx.moveTo(x + size * (0.5 - half), y + size * dy);
    ctx.lineTo(x + size * (0.5 + half), y + size * dy);
    ctx.stroke();
  }
  ctx.restore();
}

/** QR コードを、白い角丸の札の上に描く。 */
function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number): void {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  const padding = Math.round(size * 0.08);
  // 画素の境目がにじまないよう、1 マスを整数の画素にする。
  const cell = Math.floor((size - padding * 2) / count);
  const offset = Math.round((size - cell * count) / 2);
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, x, y, size, size, 24);
  ctx.fill();
  ctx.fillStyle = "#0b0b12";
  for (let row = 0; row < count; row++) {
    for (let col = 0; col < count; col++) {
      if (qr.isDark(row, col)) ctx.fillRect(x + offset + col * cell, y + offset + row * cell, cell, cell);
    }
  }
}

/** 名刺を描く。キャンバスの大きさもここで決める。 */
export function drawCard(canvas: HTMLCanvasElement, content: CardContent, options: CardOptions): void {
  const layout = LAYOUTS[options.orientation];
  const palette = PALETTES[options.theme];
  const { width, height, margin } = layout;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("キャンバスを使えません");
  const accent = accentColor(content.image, options.theme);
  const sans = (weight: number) => (size: number) => `${weight} ${size}px ${SANS}`;
  const mono = (weight: number) => (size: number) => `${weight} ${size}px ${MONO}`;
  ctx.textBaseline = "alphabetic";

  // ---- 背景：作品の絵を全面に敷き、文字が読めるように色をかぶせる ----
  drawCover(ctx, content.image, 0, 0, width, height);
  ctx.fillStyle = palette.wash;
  ctx.fillRect(0, 0, width, height);

  // ---- 上：ロゴ、サービス名、通し番号 ----
  drawLogo(ctx, margin, 78, 84, accent);
  ctx.fillStyle = palette.text;
  ctx.textAlign = "left";
  ctx.font = sans(700)(58);
  spaced(ctx, "ART-SKY", margin + 112, 142, 12);
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "right";
  ctx.font = mono(500)(26);
  ctx.fillText(`NO. ${content.serial.toUpperCase()}`, width - margin, 130);
  ctx.textAlign = "left";

  // ---- 名前とハンドル名 ----
  const name = fitText(ctx, content.name, layout.nameMaxWidth, sans(700), layout.nameSize, 56);
  ctx.fillStyle = palette.text;
  ctx.font = sans(700)(name.size);
  ctx.fillText(name.text, margin, layout.nameY);
  const handle = fitText(ctx, `@${content.handle}`, layout.nameMaxWidth, mono(500), 32, 22);
  ctx.fillStyle = palette.muted;
  ctx.font = mono(500)(handle.size);
  ctx.fillText(handle.text, margin + 4, layout.nameY + 58);

  // ---- 作品の情報の枠 ----
  const { box } = layout;
  ctx.fillStyle = palette.surface;
  ctx.strokeStyle = palette.surfaceLine;
  ctx.lineWidth = 3;
  roundRect(ctx, box.x, box.y, box.w, box.h, 32);
  ctx.fill();
  ctx.stroke();
  const inner = box.x + 48;
  ctx.fillStyle = accent;
  ctx.font = sans(600)(26);
  spaced(ctx, "ARTWORK PROFILE", inner, box.y + 62, 5);
  ctx.fillStyle = palette.text;
  const big = content.number !== undefined ? `No.${content.number}` : "No.—";
  ctx.font = sans(700)(92);
  ctx.fillText(big, inner, box.y + 160);
  const stats = [
    content.works !== undefined ? `WORKS ${content.works}` : null,
    content.postsCount !== undefined ? `POSTS ${content.postsCount.toLocaleString("en-US")}` : null,
    content.animated ? "ANIMATION" : "STILL",
  ].filter((s) => s !== null);
  ctx.fillStyle = palette.text;
  ctx.font = mono(600)(28);
  ctx.fillText(stats.join("  ·  "), inner, box.y + 222);

  // ---- タグ ----
  ctx.fillStyle = accent;
  ctx.font = sans(600)(24);
  spaced(ctx, "MADE FROM", margin, layout.tagsY, 5);
  let tagX = margin;
  for (const tag of [
    { label: "Bluesky の投稿", dot: "#1185fe" },
    { label: "Generative Art", dot: accent },
  ]) {
    ctx.font = sans(600)(30);
    const w = ctx.measureText(tag.label).width + 108;
    ctx.fillStyle = palette.surface;
    ctx.strokeStyle = palette.surfaceLine;
    roundRect(ctx, tagX, layout.tagsY + 24, w, 96, 24);
    ctx.fill();
    ctx.stroke();
    ctx.fillStyle = tag.dot;
    ctx.beginPath();
    ctx.arc(tagX + 46, layout.tagsY + 72, 16, 0, Math.PI * 2);
    ctx.fill();
    ctx.fillStyle = palette.text;
    ctx.fillText(tag.label, tagX + 76, layout.tagsY + 83);
    tagX += w + 20;
  }

  // ---- アイコン：アバターがあればアバター、なければ作品の絵をそのまま見せる ----
  const { icon } = layout;
  ctx.save();
  ctx.shadowColor = "rgba(10, 12, 40, 0.22)";
  ctx.shadowBlur = 40;
  ctx.shadowOffsetY = 14;
  ctx.fillStyle = "#ffffff";
  roundRect(ctx, icon.x, icon.y, icon.size, icon.size, 40);
  ctx.fill();
  ctx.restore();
  ctx.save();
  roundRect(ctx, icon.x + 14, icon.y + 14, icon.size - 28, icon.size - 28, 28);
  ctx.clip();
  drawCover(ctx, content.avatar ?? content.image, icon.x + 14, icon.y + 14, icon.size - 28, icon.size - 28);
  ctx.restore();

  // ---- QR コード ----
  const { qr } = layout;
  drawQr(ctx, content.profileUrl, qr.x, qr.y, qr.size);
  ctx.fillStyle = palette.muted;
  ctx.textAlign = "center";
  ctx.font = mono(500)(22);
  spaced(ctx, "PROFILE", qr.x + qr.size / 2, qr.y + qr.size + 44, 3);
  ctx.textAlign = "left";

  // ---- 下：発行日 ----
  ctx.fillStyle = palette.muted;
  ctx.font = mono(500)(26);
  ctx.fillText(`ISSUED ${formatDate(content.createdAt)}  ·  art-sky`, margin, height - 72);
}

/** キャンバスを PNG にする。 */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("画像にできませんでした"))), "image/png");
  });
}

/** アバター画像を読み込む。読めなければ null（CORS で読めない画像は名刺に混ぜられない）。 */
export async function loadAvatar(url: string | undefined): Promise<ImageBitmap | null> {
  if (!url) return null;
  try {
    const res = await fetch(url, { mode: "cors", referrerPolicy: "no-referrer" });
    if (!res.ok) return null;
    return await createImageBitmap(await res.blob());
  } catch {
    return null;
  }
}
