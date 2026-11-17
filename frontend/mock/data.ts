import { readFileSync } from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";

/**
 * モック用の参加者と作品。すべて架空のデータ。
 * 作品のコードは mock/styles/*.js にあり、参加者ごとに 1 つの作風を持つ。
 * 作品の歴史は、同じコードのパラメータを少しずつ変えたものとして表す。
 */

const stylesDir = path.join(path.dirname(fileURLToPath(import.meta.url)), "styles");

export type StyleName = "flow" | "ridges" | "orbits" | "truchet" | "bloom" | "rain" | "constellation" | "strata";

export const STYLE_NAMES: readonly StyleName[] = [
  "flow",
  "ridges",
  "orbits",
  "truchet",
  "bloom",
  "rain",
  "constellation",
  "strata",
];

const ANIMATED: ReadonlySet<StyleName> = new Set(["orbits", "rain"]);

const codeCache = new Map<StyleName, string>();
export function styleCode(style: StyleName): string {
  let code = codeCache.get(style);
  if (code === undefined) {
    code = readFileSync(path.join(stylesDir, `${style}.js`), "utf8");
    codeCache.set(style, code);
  }
  return code;
}

export function isAnimated(style: StyleName): boolean {
  return ANIMATED.has(style);
}

export interface SeedPiece {
  title: string;
  /** 何分前に作られたか。 */
  minutesAgo: number;
  params: Record<string, unknown>;
}

export interface SeedAuthor {
  did: string;
  handle: string;
  displayName: string;
  style: StyleName;
  aspectRatio: { width: number; height: number };
  postsCount: number;
  /** 古い順。最初が genesis。 */
  /** Bluesky の自己紹介（名刺に使う）。 */
  bio?: string;
  pieces: SeedPiece[];
}

const HOUR = 60;
const DAY = 24 * HOUR;

export const SEED_AUTHORS: SeedAuthor[] = [
  {
    did: "did:plc:mock2aqk3mioexample0001a",
    handle: "mio.example.com",
    bio: "雨の日と古本屋が好き。\n夜はだいたい本を読んでいます。写真もときどき。",
    displayName: "澪",
    style: "rain",
    aspectRatio: { width: 4, height: 5 },
    postsCount: 2841,
    pieces: [
      { title: "川沿いの街灯", minutesAgo: 9 * DAY, params: { count: 90, glow: 5, speed: 0.8 } },
      { title: "雨の読書", minutesAgo: 5 * DAY, params: { count: 140, glow: 7, speed: 1 } },
      { title: "眠れない夜のプレイリスト", minutesAgo: 2 * DAY, params: { count: 170, glow: 9, speed: 0.9, lights: ["#fbbf24", "#f472b6", "#60a5fa", "#34d399"] } },
      { title: "初雪の前", minutesAgo: 12, params: { count: 220, glow: 11, speed: 0.6, top: "#111827", bottom: "#334155", lights: ["#e0f2fe", "#f472b6", "#60a5fa", "#fbbf24"] } },
    ],
  },
  {
    did: "did:plc:mock2aqk3souexample0002b",
    handle: "sou.example.com",
    bio: "Web エンジニア / TypeScript と自転車。週末は川沿いを走ってます 🚲",
    displayName: "颯",
    style: "flow",
    aspectRatio: { width: 1, height: 1 },
    postsCount: 15230,
    pieces: [
      { title: "風の地図", minutesAgo: 20 * DAY, params: { lines: 500, steps: 40 } },
      { title: "風の地図 II", minutesAgo: 11 * DAY, params: { lines: 800, steps: 60, swirl: 1.2 } },
      { title: "偏西風", minutesAgo: 3 * HOUR, params: { lines: 1400, steps: 80, swirl: 1.5, scale: 3, palette: ["#7dd3fc", "#a78bfa", "#f0abfc", "#fde68a", "#fb7185"] } },
    ],
  },
  {
    did: "did:plc:mock2aqk3harexample0003c",
    handle: "haru.example.com",
    displayName: "はる",
    style: "bloom",
    aspectRatio: { width: 3, height: 4 },
    postsCount: 412,
    pieces: [
      { title: "つぼみ", minutesAgo: 6 * DAY, params: { flowers: 3, petals: 8, spread: 0.8 } },
      { title: "満開", minutesAgo: 26 * HOUR, params: { flowers: 9, petals: 14, spread: 1.1 } },
    ],
  },
  {
    did: "did:plc:mock2aqk3kaiexample0004d",
    handle: "kai.example.com",
    bio: "Designer & illustrator based in Tokyo. I post sketches, coffee, and the occasional rant about kerning.",
    displayName: "Kai",
    style: "ridges",
    aspectRatio: { width: 16, height: 9 },
    postsCount: 6120,
    pieces: [
      { title: "朝の稜線", minutesAgo: 14 * DAY, params: { layers: 4, sky: ["#bae6fd", "#fed7aa"], far: "#cbd5e1", near: "#1e293b", sun: "#fff7ed", sunY: 0.5 } },
      { title: "紅葉の山", minutesAgo: 5 * DAY, params: { layers: 6, sky: ["#7c2d12", "#fdba74"], far: "#fca5a5", near: "#450a0a", sunY: 0.4 } },
      { title: "日没", minutesAgo: 30 * HOUR, params: { layers: 7, sky: ["#1e1b4b", "#f97316"], sunY: 0.46, rough: 1.3 } },
      { title: "夜の尾根", minutesAgo: 47, params: { layers: 8, sky: ["#020617", "#312e81"], far: "#6366f1", near: "#020617", sun: "#e0e7ff", sunY: 0.3, rough: 1.5 } },
    ],
  },
  {
    did: "did:plc:mock2aqk3rinexample0005e",
    handle: "rin.example.com",
    bio: "大学院で情報科学を研究中。符号理論とジェネラティブアートが好きです。ブログ更新はゆっくり。",
    displayName: "凛",
    style: "orbits",
    aspectRatio: { width: 1, height: 1 },
    postsCount: 987,
    pieces: [
      { title: "軌道", minutesAgo: 8 * DAY, params: { count: 5, speed: 0.7 } },
      { title: "軌道、増える", minutesAgo: 4 * DAY, params: { count: 8, speed: 1 } },
      { title: "惑星系", minutesAgo: 5 * HOUR, params: { count: 12, speed: 1.2, tilt: 0.4 } },
    ],
  },
  {
    did: "did:plc:mock2aqk3tomexample0006f",
    handle: "tomo.example.com",
    displayName: "tomo",
    style: "truchet",
    aspectRatio: { width: 4, height: 5 },
    postsCount: 3305,
    pieces: [
      { title: "編み目", minutesAgo: 3 * DAY, params: { cells: 6, weight: 0.3 } },
      { title: "迷路の朝", minutesAgo: 8 * HOUR, params: { cells: 11, weight: 0.2, fillRate: 0.25, palette: ["#b45309", "#0f766e", "#1e3a8a", "#be123c"] } },
    ],
  },
  {
    did: "did:plc:mock2aqk3yuiexample0007g",
    handle: "yui.example.com",
    displayName: "結",
    style: "constellation",
    aspectRatio: { width: 3, height: 2 },
    postsCount: 742,
    pieces: [
      { title: "ひとつめの星座", minutesAgo: 10 * DAY, params: { stars: 30, reach: 0.22, dust: 200 } },
      { title: "つながり", minutesAgo: 6 * DAY, params: { stars: 55, reach: 0.18, dust: 400 } },
      { title: "冬の大三角", minutesAgo: 2 * DAY, params: { stars: 80, reach: 0.16, dust: 700 } },
      { title: "銀河", minutesAgo: 20 * HOUR, params: { stars: 120, reach: 0.13, dust: 1400, accent: "#fde68a" } },
      { title: "流星群の夜", minutesAgo: 95, params: { stars: 150, reach: 0.12, dust: 2200, accent: "#fda4af", link: "#c4b5fd" } },
    ],
  },
  {
    did: "did:plc:mock2aqk3renexample0008h",
    handle: "ren.example.com",
    displayName: "蓮",
    style: "strata",
    aspectRatio: { width: 4, height: 5 },
    postsCount: 58,
    pieces: [{ title: "地層", minutesAgo: 2 * HOUR, params: { bands: 18, wobble: 0.9 } }],
  },
];

const TID_CHARS = "234567abcdefghijklmnopqrstuvwxyz";

/** 時刻から TID 風のレコードキー（13 文字、時刻順に並ぶ）を作る。 */
export function tidFromTime(ms: number): string {
  let n = BigInt(Math.floor(ms)) * 1000n * 1024n; // マイクロ秒 << 10
  let out = "";
  for (let i = 0; i < 13; i++) {
    out = TID_CHARS[Number(n % 32n)] + out;
    n /= 32n;
  }
  return out;
}

/** 文字列から決まる 32 ビットの数。モックのシードやスタイル選びに使う。 */
export function hash32(text: string): number {
  let h = 2166136261;
  for (let i = 0; i < text.length; i++) {
    h ^= text.charCodeAt(i);
    h = Math.imul(h, 16777619);
  }
  return h >>> 0;
}
