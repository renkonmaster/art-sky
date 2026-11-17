import qrcode from "qrcode-generator";

/**
 * 名刺をキャンバスに描く。
 *
 * 大きさは日本の名刺（91mm × 55mm）と同じ縦横比で、1 mm を 20 画素として描く
 * （横向きで 1820 × 1100 画素。約 508dpi なので、そのまま印刷にも使える）。
 *
 * 主役は本人の情報（Bluesky の表示名、ハンドル名、自己紹介、ID）。作品の絵の置き方は 2 通り。
 * - full（既定）：全面に敷き、文字の側だけ紙の色をなだらかに薄く重ねて読みやすくする（板の縁は作らない）。
 * - side：片側（縦向きでは上）に飾りとして置く。
 * art-sky の名前は絵の隅に小さく入れるだけにする。
 */

export type CardOrientation = "landscape" | "portrait";
export type CardTheme = "light" | "dark";
export type CardStyle = "side" | "full";

export interface CardContent {
  /** 作品のスナップショット。 */
  image: ImageBitmap;
  /** アバター画像。なければ作品の絵をアイコンに使う。 */
  avatar: ImageBitmap | null;
  /** 表示名（なければハンドル名）。 */
  name: string;
  handle: string;
  /** Bluesky の自己紹介。なければ空。 */
  bio: string;
  did: string;
  /** QR コードにする URL（Bluesky のプロフィール）。 */
  profileUrl: string;
}

export interface CardOptions {
  orientation: CardOrientation;
  theme: CardTheme;
  style: CardStyle;
}

const LONG = 1820;
const SHORT = 1100;
const SANS = '"Hiragino Sans", "Noto Sans JP", "Yu Gothic UI", system-ui, sans-serif';
const MONO = 'ui-monospace, "SF Mono", Menlo, Consolas, "Noto Sans Mono", monospace';

interface Palette {
  paper: string;
  text: string;
  muted: string;
  faint: string;
}

const PALETTES: Record<CardTheme, Palette> = {
  light: { paper: "#fbfaf7", text: "#16171d", muted: "#5d6070", faint: "#9a9caa" },
  dark: { paper: "#131419", text: "#f3f3f6", muted: "#a9acbb", faint: "#6d7080" },
};

type Box = { x: number; y: number; w: number; h: number };

/** 各部品の位置。横向きと縦向きで置き場所だけを変える。 */
interface Layout {
  width: number;
  height: number;
  /** 作品の絵を置く範囲。 */
  art: Box;
  /** 紙面（文字を置く範囲）。 */
  text: Box;
  /** 絵を全面に敷くときに、紙の色を重ね始める位置と、濃さが上限に届く位置（横向きは x、縦向きは y）。 */
  fade: { from: number; to: number };
  avatar: { x: number; y: number; size: number };
  nameY: number;
  nameSize: number;
  bio: { y: number; maxLines: number; width: number };
  qr: { x: number; y: number; size: number };
  /** プロフィールの URL と ID を置く位置（下から）。 */
  footY: number;
  footWidth: number;
}

const LAYOUTS: Record<CardOrientation, Layout> = {
  landscape: {
    width: LONG,
    height: SHORT,
    art: { x: 0, y: 0, w: 620, h: SHORT },
    text: { x: 730, y: 110, w: LONG - 730 - 110, h: SHORT - 220 },
    fade: { from: 420, to: 1000 },
    avatar: { x: 730, y: 110, size: 150 },
    nameY: 382,
    nameSize: 100,
    bio: { y: 548, maxLines: 4, width: LONG - 730 - 110 },
    qr: { x: LONG - 110 - 210, y: SHORT - 110 - 210, size: 210 },
    footY: SHORT - 110,
    footWidth: LONG - 730 - 110 - 210 - 60,
  },
  portrait: {
    width: SHORT,
    height: LONG,
    art: { x: 0, y: 0, w: SHORT, h: 690 },
    text: { x: 110, y: 690, w: SHORT - 220, h: LONG - 690 - 110 },
    fade: { from: 420, to: 1000 },
    avatar: { x: 110, y: 600, size: 180 },
    nameY: 940,
    nameSize: 96,
    bio: { y: 1104, maxLines: 6, width: SHORT - 220 },
    qr: { x: SHORT - 110 - 210, y: LONG - 110 - 210, size: 210 },
    footY: LONG - 110,
    footWidth: SHORT - 220 - 210 - 50,
  },
};

export function cardSize(orientation: CardOrientation): { width: number; height: number } {
  const { width, height } = LAYOUTS[orientation];
  return { width, height };
}

/** "#rrggbb" に透明度をつける。 */
function withAlpha(hex: string, alpha: number): string {
  const n = Number.parseInt(hex.slice(1), 16);
  return `rgba(${(n >> 16) & 255}, ${(n >> 8) & 255}, ${n & 255}, ${alpha})`;
}

/** 絵の中心を残して、枠いっぱいに切り抜いて描く。 */
function drawCover(ctx: CanvasRenderingContext2D, image: ImageBitmap, x: number, y: number, w: number, h: number): void {
  const scale = Math.max(w / image.width, h / image.height);
  const sw = w / scale;
  const sh = h / scale;
  ctx.drawImage(image, (image.width - sw) / 2, (image.height - sh) / 2, sw, sh, x, y, w, h);
}

/** 絵全体の平均の色から、差し色を作る（明るい地には濃く、暗い地には明るく）。 */
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
  const mean = (r + g + b) / 3;
  const boost = (v: number) => mean + (v - mean) * 2.4;
  const target = theme === "light" ? 100 : 185;
  const scale = target / Math.max(1, mean);
  const c = (v: number) => Math.max(0, Math.min(255, Math.round(boost(v) * scale)));
  // 暗い地では、色味を残したまま白に寄せて読みやすくする
  const lift = (v: number) => (theme === "dark" ? Math.round(c(v) + (255 - c(v)) * 0.4) : c(v));
  return `rgb(${lift(r)}, ${lift(g)}, ${lift(b)})`;
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

/**
 * 自己紹介を幅に合わせて折り返す。日本語は 1 文字ずつ、英語は単語の区切りで折る。
 * 改行はそのまま残し、maxLines を超える分は最後の行を「…」にする。
 */
export function wrapText(measure: (text: string) => number, text: string, maxWidth: number, maxLines: number): string[] {
  const lines: string[] = [];
  const tokenize = (s: string) => s.match(/[\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]|[^\s\u3000-\u30ff\u3400-\u9fff\uff00-\uffef]+|\s+/gu) ?? [];
  let truncated = false;
  for (const paragraph of text.replace(/\r/g, "").split("\n")) {
    let line = "";
    for (const token of tokenize(paragraph)) {
      if (measure(line + token) <= maxWidth || line === "") {
        // 1 単語だけで幅を超えるときは、文字単位で切る
        if (line === "" && measure(token) > maxWidth) {
          for (const ch of token) {
            if (measure(line + ch) > maxWidth && line) {
              lines.push(line);
              line = "";
            }
            line += ch;
          }
        } else {
          line += token;
        }
      } else {
        lines.push(line.trimEnd());
        line = /^\s+$/.test(token) ? "" : token;
      }
    }
    lines.push(line.trimEnd());
  }
  while (lines.length > 0 && lines.at(-1) === "") lines.pop();
  if (lines.length > maxLines) {
    lines.length = maxLines;
    truncated = true;
  }
  if (truncated) {
    let last = lines[maxLines - 1] ?? "";
    while (last && measure(`${last}…`) > maxWidth) last = [...last].slice(0, -1).join("");
    lines[maxLines - 1] = `${last}…`;
  }
  return lines;
}

/** QR コードを描く（地の色の上に、文字と同じ色で）。 */
function drawQr(ctx: CanvasRenderingContext2D, url: string, x: number, y: number, size: number, dark: string, light: string): void {
  const qr = qrcode(0, "M");
  qr.addData(url);
  qr.make();
  const count = qr.getModuleCount();
  // 周りの余白（クワイエットゾーン）を 2 マスぶん取る。画素の境目がにじまないよう 1 マスを整数にする。
  const cell = Math.floor(size / (count + 4));
  const offset = Math.round((size - cell * count) / 2);
  ctx.fillStyle = light;
  ctx.beginPath();
  ctx.roundRect(x, y, size, size, 16);
  ctx.fill();
  ctx.fillStyle = dark;
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
  const { width, height, text } = layout;
  canvas.width = width;
  canvas.height = height;
  const ctx = canvas.getContext("2d");
  if (!ctx) throw new Error("キャンバスを使えません");
  const accent = accentColor(content.image, options.theme);
  const sans = (weight: number) => (size: number) => `${weight} ${size}px ${SANS}`;
  const mono = (weight: number) => (size: number) => `${weight} ${size}px ${MONO}`;
  ctx.textBaseline = "alphabetic";
  ctx.textAlign = "left";

  // ---- 紙面と、作品の絵 ----
  const { art } = layout;
  if (options.style === "full") {
    drawCover(ctx, content.image, 0, 0, width, height);
    // 文字の側に向かって、絵をなだらかにぼかし、紙の色を薄く重ねる。板の縁は作らない。
    const { fade } = layout;
    const horizontal = options.orientation === "landscape";
    const ramp = (c: CanvasRenderingContext2D) => (horizontal ? c.createLinearGradient(fade.from, 0, fade.to, 0) : c.createLinearGradient(0, fade.from, 0, fade.to));
    const blurred = document.createElement("canvas");
    blurred.width = width;
    blurred.height = height;
    const bctx = blurred.getContext("2d");
    if (bctx) {
      bctx.filter = "blur(14px)";
      drawCover(bctx, content.image, -40, -40, width + 80, height + 80);
      bctx.filter = "none";
      const mask = ramp(bctx);
      mask.addColorStop(0, "rgba(0, 0, 0, 0)");
      mask.addColorStop(1, "rgba(0, 0, 0, 1)");
      bctx.globalCompositeOperation = "destination-in";
      bctx.fillStyle = mask;
      bctx.fillRect(0, 0, width, height);
      ctx.drawImage(blurred, 0, 0);
    }
    const gradient = ramp(ctx);
    const max = options.theme === "light" ? 0.8 : 0.62;
    gradient.addColorStop(0, withAlpha(palette.paper, 0));
    gradient.addColorStop(0.5, withAlpha(palette.paper, max * 0.7));
    gradient.addColorStop(1, withAlpha(palette.paper, max));
    ctx.fillStyle = gradient;
    ctx.fillRect(0, 0, width, height);
  } else {
    ctx.fillStyle = palette.paper;
    ctx.fillRect(0, 0, width, height);
    drawCover(ctx, content.image, art.x, art.y, art.w, art.h);
  }
  // 絵の隅に、小さく作品の出どころ
  ctx.save();
  ctx.font = sans(500)(22);
  ctx.fillStyle = "rgba(255, 255, 255, 0.78)";
  ctx.shadowColor = "rgba(0, 0, 0, 0.45)";
  ctx.shadowBlur = 8;
  ctx.letterSpacing = "2px";
  // 縦向きではアイコンが左下にかぶるので、右下に置く
  if (options.orientation === "portrait") {
    ctx.textAlign = "right";
    ctx.fillText("generative art · art-sky", art.x + art.w - 40, art.y + art.h - 40);
  } else {
    ctx.fillText("generative art · art-sky", art.x + 40, art.y + art.h - 40);
  }
  ctx.restore();

  // ---- アイコン（縦向きでは絵と紙面の境目にかぶせる） ----
  const { avatar } = layout;
  const r = avatar.size / 2;
  ctx.save();
  ctx.fillStyle = palette.paper;
  ctx.beginPath();
  ctx.arc(avatar.x + r, avatar.y + r, r + 10, 0, Math.PI * 2);
  ctx.fill();
  ctx.beginPath();
  ctx.arc(avatar.x + r, avatar.y + r, r, 0, Math.PI * 2);
  ctx.clip();
  drawCover(ctx, content.avatar ?? content.image, avatar.x, avatar.y, avatar.size, avatar.size);
  ctx.restore();

  // ---- 表示名とハンドル名 ----
  // 絵の上に直接書くときは、文字の周りに紙の色をぼんやり敷いて読みやすくする
  if (options.style === "full") {
    ctx.shadowColor = withAlpha(palette.paper, 0.9);
    ctx.shadowBlur = 24;
  }
  const name = fitText(ctx, content.name, text.w, sans(700), layout.nameSize, 48);
  ctx.fillStyle = palette.text;
  ctx.font = sans(700)(name.size);
  ctx.fillText(name.text, text.x, layout.nameY);
  const handle = fitText(ctx, `@${content.handle}`, text.w, sans(500), 40, 24);
  ctx.fillStyle = accent;
  ctx.font = sans(500)(handle.size);
  ctx.fillText(handle.text, text.x + 2, layout.nameY + 66);

  // ---- 区切りの線 ----
  ctx.fillStyle = accent;
  ctx.fillRect(text.x + 2, layout.nameY + 106, 96, 6);

  // ---- 自己紹介 ----
  if (content.bio.trim()) {
    ctx.fillStyle = palette.muted;
    ctx.font = sans(400)(36);
    const lines = wrapText((s) => ctx.measureText(s).width, content.bio.trim(), layout.bio.width, layout.bio.maxLines);
    lines.forEach((line, i) => ctx.fillText(line, text.x, layout.bio.y + i * 58));
  }

  // ---- 下：プロフィールの URL と ID、QR コード ----
  const url = fitText(ctx, content.profileUrl.replace(/^https:\/\//, ""), layout.footWidth, sans(500), 30, 20);
  ctx.fillStyle = palette.text;
  ctx.font = sans(500)(url.size);
  ctx.fillText(url.text, text.x, layout.footY - 46);
  const did = fitText(ctx, content.did, layout.footWidth, mono(400), 22, 14);
  ctx.fillStyle = options.style === "full" ? palette.muted : palette.faint;
  ctx.font = mono(400)(did.size);
  ctx.fillText(did.text, text.x, layout.footY);

  ctx.shadowColor = "transparent";
  ctx.shadowBlur = 0;
  const { qr } = layout;
  // 白地に黒で描く（白黒が反転した QR コードは読めないアプリがある）
  drawQr(ctx, content.profileUrl, qr.x, qr.y, qr.size, PALETTES.light.text, PALETTES.light.paper);
}

/** キャンバスを PNG にする。 */
export function canvasToPng(canvas: HTMLCanvasElement): Promise<Blob> {
  return new Promise((resolve, reject) => {
    canvas.toBlob((blob) => (blob ? resolve(blob) : reject(new Error("画像にできませんでした"))), "image/png");
  });
}

/** アバター画像を読み込む（同じオリジンの /api/avatar から）。読めなければ null。 */
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

/** 名刺に載せる Bluesky のプロフィール。 */
export interface BlueskyProfile {
  displayName?: string;
  description?: string;
  avatar?: string;
}

/**
 * Bluesky の最新のプロフィール（自己紹介など）を、公開 AppView から読む。読めなければ null。
 * モックで動かすときは、モックが同じ URL で架空のプロフィールを返す。
 */
export async function fetchBlueskyProfile(actor: string, signal?: AbortSignal): Promise<BlueskyProfile | null> {
  const base = __MOCK__ ? "" : "https://public.api.bsky.app";
  try {
    const res = await fetch(`${base}/xrpc/app.bsky.actor.getProfile?actor=${encodeURIComponent(actor)}`, signal ? { signal } : {});
    if (!res.ok) return null;
    const data = (await res.json()) as BlueskyProfile;
    return { ...(data.displayName ? { displayName: data.displayName } : {}), ...(data.description ? { description: data.description } : {}), ...(data.avatar ? { avatar: data.avatar } : {}) };
  } catch {
    return null;
  }
}
