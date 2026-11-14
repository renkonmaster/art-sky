/**
 * 投稿の量・時間帯・文体など、本文を読まなくても観測できる特徴を数値にする。
 * skymood の stats.js を移植したもの。
 *
 * 結果は作品レコードの state にそのまま入れるので、すべて整数にする
 * （AT Protocol のデータモデルは小数を扱えない）。0〜1 の割合は 1000 倍した値（‰）。
 */

/** 特徴の計算に使う投稿。fetchRecentPosts() が返す形。 */
export interface FeaturePost {
  text: string;
  createdAt: string;
  likeCount?: number;
  hasMedia?: boolean;
  hasLink?: boolean;
  langs?: string[];
}

export interface PostingFeatures {
  /** 計算に使った投稿の件数 */
  postsAnalyzed: number;
  /** 最も古い投稿から最も新しい投稿までの日数（切り上げ、最小 1） */
  spanDays: number;
  /** 1 日あたりの投稿数 × 100 */
  postsPerDayX100: number;
  /** 投稿の多さ（‰）。1 日 0 件で 0、1 日 50 件でおよそ 1000 の対数スケール */
  activity: number;
  /** よく投稿する時刻（0〜1439 の、その日の何分目か）。円周平均なので 23 時と 1 時の平均は 0 時になる */
  peakMinute: number;
  /** 時間帯（0〜23 時）ごとの投稿数 */
  hourHistogram: number[];
  /** 投稿時刻のばらつき（‰）。0 なら毎回同じ時間帯、1000 なら全時間帯に均等 */
  hourSpread: number;
  /** 本文の平均の長さ（書記素ではなくコードポイント数、四捨五入） */
  avgLength: number;
  /** 「!」を含む投稿の割合（‰） */
  exclaim: number;
  /** 「?」を含む投稿の割合（‰） */
  question: number;
  /** 絵文字を含む投稿の割合（‰） */
  emoji: number;
  /** 画像などを添付した投稿の割合（‰） */
  media: number;
  /** リンクを含む投稿の割合（‰） */
  link: number;
  /** 1 投稿あたりのいいね数 × 100 */
  avgLikesX100: number;
  maxLikes: number;
  /** 使われた言語の数 */
  langCount: number;
  /** 語彙の多様さ（‰）。文字の 2-gram の異なり数 ÷ 延べ数 */
  vocabDiversity: number;
}

const EMOJI_RE = /\p{Extended_Pictographic}/u;
const formatters = new Map<string, Intl.DateTimeFormat>();

function minuteOfDay(date: Date, timeZone: string): number {
  let fmt = formatters.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-US", { hour: "numeric", minute: "numeric", hourCycle: "h23", timeZone });
    formatters.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(date);
  const hour = Number(parts.find((p) => p.type === "hour")?.value ?? 0) % 24;
  const minute = Number(parts.find((p) => p.type === "minute")?.value ?? 0);
  return hour * 60 + minute;
}

const permille = (x: number): number => Math.round(Math.min(1, Math.max(0, x)) * 1000);

export function computeFeatures(posts: FeaturePost[], { timeZone = "Asia/Tokyo" } = {}): PostingFeatures {
  const n = posts.length;
  const hourHistogram = new Array<number>(24).fill(0);
  let sin = 0;
  let cos = 0;
  let totalLen = 0;
  let exclaim = 0;
  let question = 0;
  let emoji = 0;
  let media = 0;
  let links = 0;
  let likes = 0;
  let maxLikes = 0;
  const langs = new Set<string>();
  const bigrams = new Set<string>();
  let bigramTotal = 0;
  const times: number[] = [];

  for (const p of posts) {
    const d = new Date(p.createdAt);
    if (!Number.isNaN(d.getTime())) {
      const m = minuteOfDay(d, timeZone);
      hourHistogram[Math.floor(m / 60)]! += 1;
      const a = (m / 1440) * Math.PI * 2;
      sin += Math.sin(a);
      cos += Math.cos(a);
      times.push(d.getTime());
    }
    const t = p.text;
    totalLen += [...t].length;
    if (/[!！]/.test(t)) exclaim++;
    if (/[?？]/.test(t)) question++;
    if (EMOJI_RE.test(t)) emoji++;
    if (p.hasMedia) media++;
    if (p.hasLink ?? /https?:\/\//.test(t)) links++;
    const likeCount = p.likeCount ?? 0;
    likes += likeCount;
    maxLikes = Math.max(maxLikes, likeCount);
    for (const l of p.langs ?? []) langs.add(l);
    const chars = [...t.replace(/https?:\/\/\S+/g, "").replace(/\s+/g, "")];
    for (let i = 0; i < chars.length - 1; i++) {
      bigrams.add(chars[i]! + chars[i + 1]!);
      bigramTotal++;
    }
  }

  let peakMinute = 720;
  if (times.length > 0 && (sin !== 0 || cos !== 0)) {
    const angle = Math.atan2(sin, cos);
    peakMinute = Math.round(((angle / (Math.PI * 2)) * 1440 + 1440) % 1440) % 1440;
  }

  let entropy = 0;
  for (const c of hourHistogram) {
    if (c > 0) {
      const q = c / times.length;
      entropy -= q * Math.log(q);
    }
  }
  const hourSpread = times.length > 0 ? entropy / Math.log(24) : 0.5;

  times.sort((a, b) => a - b);
  const spanDays = times.length > 1 ? Math.max(1, (times.at(-1)! - times[0]!) / 86_400_000) : 1;
  const postsPerDay = n / spanDays;
  const ratio = (x: number) => (n > 0 ? x / n : 0);

  return {
    postsAnalyzed: n,
    spanDays: Math.ceil(spanDays),
    postsPerDayX100: Math.round(postsPerDay * 100),
    activity: permille(Math.log10(postsPerDay + 1) / Math.log10(51)),
    peakMinute,
    hourHistogram,
    hourSpread: permille(hourSpread),
    avgLength: n > 0 ? Math.round(totalLen / n) : 0,
    exclaim: permille(ratio(exclaim)),
    question: permille(ratio(question)),
    emoji: permille(ratio(emoji)),
    media: permille(ratio(media)),
    link: permille(ratio(links)),
    avgLikesX100: n > 0 ? Math.round((likes / n) * 100) : 0,
    maxLikes,
    langCount: langs.size,
    vocabDiversity: permille(bigramTotal > 0 ? bigrams.size / bigramTotal : 0),
  };
}
