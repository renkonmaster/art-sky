/**
 * art-sky：投稿から作品のパラメーターを推定する（AI なし）。
 *
 * 流れ
 *   1. 投稿 1 件ごとに、感情の手がかり（単語・絵文字・顔文字・記号）を数える  … analyzePost
 *   2. 最初の作品：直近の投稿をまとめて、感情の割合と振る舞いの特徴を出す     … estimateGenesis
 *   3. 新しい投稿：前の状態を少しだけ動かす。最初の作品の値（base）にも
 *      ゆっくり引き戻すので、何件読んでも「その人らしさ」は残る              … evolveState
 *
 * 状態はそのまま AT Protocol のレコードに保存する前提なので、すべて整数にする。
 */

const EMOTIONS = ["joy", "calm", "excitement", "nostalgia", "sadness", "anxiety", "anger", "neutral"];
const DAY_MS = 86400000;

// -------------------------------------------------------------------
// 感情の手がかり。[語, 重み]。日本語は語幹で部分一致（「嬉し」は「嬉しい」「嬉しかった」に当たる）、
// 英語は単語の境界で一致させる。
// -------------------------------------------------------------------
const LEXICON = {
  joy: [
    ["fun", 1.5], ["enjoy", 1.5], ["enjoyed", 1.5], ["delicious", 1.5], ["cute", 1.5], ["congrats", 2], ["congratulations", 2], ["proud", 1.5], ["blessed", 1.5], ["lovely", 1.5], ["haha", 1], ["best day", 2],
    ["嬉し", 2], ["うれし", 2], ["楽し", 2], ["たのし", 2], ["最高", 2], ["幸せ", 2], ["しあわせ", 2],
    ["好き", 1.5], ["すき", 1], ["大好き", 2], ["ありがと", 1.5], ["感謝", 1.5], ["やった", 1.5], ["よかった", 1.5],
    ["良かった", 1.5], ["おいし", 1.5], ["美味し", 1.5], ["かわい", 1.5], ["可愛", 1.5], ["笑", 1], ["草", 1],
    ["おめでと", 2], ["素敵", 1.5], ["すてき", 1.5], ["満足", 1.5], ["ハッピー", 2],
    ["happy", 2], ["glad", 1.5], ["love", 1.5], ["great", 1.5], ["thanks", 1.5], ["thank you", 1.5], ["yay", 2], ["lol", 1],
    ["😊", 2], ["😄", 2], ["😁", 2], ["🥰", 2], ["😆", 1.5], ["😂", 1.5], ["🤣", 1.5], ["❤", 1.5], ["💕", 1.5], ["🎉", 2], ["🙌", 1.5], ["👍", 1],
  ],
  calm: [
    ["peace", 1.5], ["slow", 1], ["gentle", 1.5], ["sunday", 1], ["tea", 1], ["coffee", 1], ["sleepy", 1], ["rest", 1], ["breathe", 1.5], ["serene", 2],
    ["のんびり", 2], ["落ち着", 2], ["ゆっくり", 1.5], ["穏やか", 2], ["ほっと", 2], ["ホッと", 2], ["まったり", 2],
    ["静か", 1.5], ["癒", 2], ["ゆるゆる", 1.5], ["散歩", 1], ["お茶", 1], ["コーヒー", 1], ["珈琲", 1], ["眠", 1],
    ["おやすみ", 1], ["休日", 1], ["のどか", 1.5], ["平和", 1.5],
    ["calm", 2], ["relax", 2], ["chill", 1.5], ["cozy", 1.5], ["peaceful", 2], ["quiet", 1],
    ["☕", 1.5], ["🍵", 1.5], ["🌿", 1.5], ["😌", 2], ["🌙", 1], ["🛌", 1],
  ],
  excitement: [
    ["finally", 1.5], ["incredible", 2], ["insane", 1.5], ["epic", 1.5], ["lets go", 2], ["let's go", 2], ["thrilled", 2], ["pumped", 2], ["announce", 1], ["launch", 1],
    ["ワクワク", 2], ["わくわく", 2], ["楽しみ", 2], ["すごい", 1.5], ["すげ", 1.5], ["凄", 1.5], ["ヤバ", 1.5], ["やば", 1.5],
    ["興奮", 2], ["テンション", 1.5], ["熱い", 1.5], ["アツい", 1.5], ["神", 1], ["エモ", 1], ["推し", 1.5],
    ["ついに", 1.5], ["きた", 1], ["キタ", 1.5], ["発表", 1], ["ライブ", 1],
    ["excited", 2], ["amazing", 2], ["awesome", 2], ["wow", 1.5], ["omg", 1.5], ["hype", 2], ["can't wait", 2],
    ["🔥", 2], ["✨", 1.5], ["🚀", 2], ["‼", 1.5], ["🤩", 2], ["😍", 1.5], ["💥", 1.5],
  ],
  nostalgia: [
    ["childhood", 2], ["used to", 1.5], ["throwback", 2], ["old days", 2], ["miss those", 2], ["back in", 1],
    ["懐かし", 2.5], ["なつかし", 2.5], ["昔", 1.5], ["思い出", 2], ["あの頃", 2.5], ["久しぶり", 1.5], ["当時", 1.5],
    ["子供の頃", 2], ["学生時代", 2], ["振り返", 1.5], ["何年前", 2], ["年前", 1], ["また会", 1], ["実家", 1],
    ["nostalgia", 2.5], ["nostalgic", 2.5], ["remember", 1.5], ["memories", 2], ["back then", 2], ["years ago", 1.5],
    ["📷", 1], ["📸", 1], ["🌅", 1], ["🎞", 1.5],
  ],
  sadness: [
    ["heartbroken", 2.5], ["exhausted", 1.5], ["unfortunately", 1.5], ["sorry", 1], ["grief", 2.5], ["hurts", 1.5], ["alone", 1.5], ["upset", 1.5],
    ["悲し", 2], ["かなし", 2], ["寂し", 2], ["さみし", 2], ["さびし", 2], ["つら", 1.5], ["辛い", 1.5], ["泣", 2],
    ["しんど", 2], ["疲れ", 1.5], ["つかれ", 1.5], ["落ち込", 2], ["残念", 1.5], ["切な", 2], ["虚し", 2], ["ぴえん", 1.5],
    ["だめだ", 1.5], ["もう無理", 2], ["凹", 1.5], ["しょんぼり", 2],
    ["sad", 2], ["lonely", 2], ["tired", 1.5], ["miss", 1], ["cry", 2], ["depressed", 2.5], ["sigh", 1.5],
    ["😢", 2], ["😭", 2], ["💧", 1], ["😞", 2], ["😔", 2], ["🥲", 1.5], ["💔", 2],
  ],
  anxiety: [
    ["worry", 2], ["panic", 2], ["overwhelmed", 2], ["uneasy", 2], ["what if", 1.5], ["can't sleep", 2], ["terrified", 2.5],
    ["不安", 2.5], ["心配", 2], ["怖", 2], ["こわ", 1.5], ["緊張", 2], ["焦", 2], ["大丈夫かな", 2], ["どうしよう", 2],
    ["ドキドキ", 1], ["やばいかも", 2], ["間に合", 1.5], ["締め切り", 1.5], ["〆切", 1.5], ["眠れな", 2], ["憂鬱", 2],
    ["worried", 2], ["anxious", 2.5], ["nervous", 2], ["scared", 2], ["afraid", 2], ["stress", 2], ["deadline", 1.5],
    ["😰", 2], ["😨", 2], ["😥", 1.5], ["😓", 1.5], ["😬", 1.5],
  ],
  anger: [
    ["pissed", 2.5], ["ridiculous", 1.5], ["disgusting", 2], ["sick of", 2], ["fed up", 2], ["stupid", 1.5], ["outrageous", 2],
    ["ムカ", 2], ["むか", 2], ["イライラ", 2.5], ["いらいら", 2.5], ["腹立", 2.5], ["許せな", 2.5], ["最悪", 2], ["クソ", 2],
    ["くそ", 1.5], ["うざ", 2], ["ウザ", 2], ["キレ", 2], ["ふざけ", 2], ["なんで", 1], ["意味わから", 1.5], ["怒", 2],
    ["angry", 2.5], ["mad", 1.5], ["annoying", 2], ["hate", 2], ["wtf", 2], ["ugh", 1.5], ["furious", 2.5],
    ["😡", 2.5], ["💢", 2.5], ["🤬", 2.5], ["😤", 1.5], ["👊", 1],
  ],
};

/** 否定されたときに、その重みを移す先（「嬉しくない」は悲しみ寄り、など）。 */
const NEGATED_TO = { joy: "sadness", calm: "anxiety", excitement: "neutral", nostalgia: "neutral", sadness: "neutral", anxiety: "calm", anger: "neutral" };
const INTENSIFIERS = {
  ja: ["めっちゃ", "めちゃ", "超", "本当に", "ほんとに", "マジで", "まじで", "すごく", "とても", "かなり"],
  en: ["very ", "so ", "really ", "super ", "extremely ", "totally "],
};
const SUPPORTED = ["ja", "en"];

/**
 * 投稿の言語を決める。投稿レコードの langs（例：["ja"]）を優先し、なければ文字から推定する。
 * 日本語と英語以外の投稿は空になり、絵文字・顔文字・記号だけで読む。
 */
function detectLangs(text, langs) {
  const hasKana = /[\u3040-\u30ff]/.test(text);
  const latinWords = (text.match(/\b[a-z]{2,}\b/gi) || []).length;
  const fromRecord = (langs || []).map((l) => l.toLowerCase().split("-")[0]).filter((l) => SUPPORTED.includes(l));
  if (fromRecord.length) {
    // 言語設定が日本語のまま英語で書く人もいるので、かながなく英単語だけの投稿は英語としても読む
    if (!fromRecord.includes("en") && !hasKana && latinWords > 0) fromRecord.push("en");
    return fromRecord;
  }
  if (langs && langs.length) return [];                       // 他の言語と明記されている
  const out = [];
  if (hasKana) out.push("ja");
  if (latinWords >= (hasKana ? 3 : 1)) out.push("en");        // 日本語の中の英単語 1 つ 2 つでは英語扱いしない
  return out;
}
const KAOMOJI = [
  [/\(\s*[\^＾]\s*[\^＾_ー▽ω]*\s*\)|\(\s*´\s*[∀ω▽]\s*`\s*\)/g, "joy", 1.5],
  [/\(\s*[TＴ;；]\s*[_＿.]?\s*[TＴ;；]\s*\)|orz/gi, "sadness", 1.5],
  [/\(\s*[`｀]\s*[Д皿]\s*[´′]\s*\)/g, "anger", 2],
  [/[;；]\s*[\^＾]|\(\s*[;；]\s*[´′]/g, "anxiety", 1],
];

const isAscii = (w) => /^[\x00-\x7f]+$/.test(w);
const isJapanese = (w) => /[\u3040-\u30ff\u3400-\u9fff]/.test(w);
/** 手がかりの言語。ja / en / any（絵文字など、言語に関係なく使える） */
const langOfWord = (w) => (isJapanese(w) ? "ja" : isAscii(w) ? "en" : "any");
const escapeRe = (w) => w.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
// 英語の語は前もって正規表現にしておく
const MATCHERS = Object.entries(LEXICON).flatMap(([emo, words]) =>
  words.map(([word, weight]) => ({ emo, word, weight, lang: langOfWord(word), re: isAscii(word) ? new RegExp(`\\b${escapeRe(word)}\\b`, "gi") : null })),
);

function normalizeText(text) {
  return text
    .normalize("NFKC")
    .replace(/https?:\/\/\S+/g, " ")        // URL
    .replace(/@[\w.-]+/g, " ")              // メンション
    .replace(/ｗ/g, "w");
}

/** 語の直後（日本語）または直前（英語）に否定があるか。 */
function isNegated(text, index, word) {
  if (isAscii(word)) return /\b(not|never|no|don't|didn't|isn't|wasn't|can't)\s+(\w+\s+)?$/i.test(text.slice(Math.max(0, index - 16), index));
  return /^[^\s。、!！?？]{0,3}?(ない|なかっ|なく|ません|じゃな|ず[、。\s]|ずに)/.test(text.slice(index + word.length, index + word.length + 8));
}

/**
 * 投稿 1 件を読む。
 * @returns {{ scores: Record<string, number>, evidence: number, exclaim: boolean, emoji: boolean, words: string[] }}
 *   scores は感情ごとの手がかりの重みの合計、evidence はその総量（0 なら手がかりなし）。
 */
function analyzePost(rawText, langs) {
  const text = normalizeText(rawText || "");
  const lower = text.toLowerCase();
  const use = detectLangs(text, langs);
  const scores = Object.fromEntries(EMOTIONS.map((e) => [e, 0]));
  const words = [];

  for (const m of MATCHERS) {
    if (m.lang !== "any" && !use.includes(m.lang)) continue;
    const hits = [];
    if (m.re) { m.re.lastIndex = 0; let r; while ((r = m.re.exec(lower))) hits.push(r.index); }
    else { let i = -1; while ((i = text.indexOf(m.word, i + 1)) !== -1) hits.push(i); }
    for (const i of hits) {
      if (isNegated(m.re ? lower : text, i, m.word)) { scores[NEGATED_TO[m.emo]] += m.weight * 0.5; words.push(`${m.word}(否定)`); }
      else { scores[m.emo] += m.weight; words.push(m.word); }
    }
  }
  for (const [re, emo, weight] of KAOMOJI) { const n = (text.match(re) || []).length; if (n) { scores[emo] += weight * n; words.push("顔文字"); } }

  // 記号：「www」は笑い、「…」は沈んだ／落ち着いた調子、連続した「!」は気持ちの高ぶり
  if (use.includes("ja") && /w{2,}/.test(lower)) { scores.joy += 1; words.push("www"); }
  if (/…|\.{3,}|。{2,}/.test(text)) { scores.sadness += 0.4; scores.calm += 0.3; }
  const bangs = (text.match(/!/g) || []).length;
  if (bangs >= 2) {
    const negative = scores.anger + scores.anxiety + scores.sadness;
    const positive = scores.joy + scores.excitement;
    if (negative > positive) scores.anger += 0.8; else scores.excitement += 0.8;
  }
  if (/\?{2,}/.test(text)) scores.anxiety += 0.5;

  // 強調語があれば全体を強める
  if (use.some((l) => INTENSIFIERS[l].some((w) => lower.includes(w)))) for (const e of EMOTIONS) scores[e] *= 1.3;

  const evidence = EMOTIONS.reduce((a, e) => a + scores[e], 0);
  return { scores, evidence, exclaim: bangs > 0, emoji: /\p{Extended_Pictographic}/u.test(text), words, langs: use };
}

// -------------------------------------------------------------------
// 数値の小道具
// -------------------------------------------------------------------
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const lerp = (a, b, t) => a + (b - a) * t;

function toMix(vec) {
  const sum = EMOTIONS.reduce((a, e) => a + Math.max(0, vec[e] || 0), 0);
  if (sum <= 0) return Object.fromEntries(EMOTIONS.map((e) => [e, e === "neutral" ? 1000 : 0]));
  const mix = Object.fromEntries(EMOTIONS.map((e) => [e, Math.round((Math.max(0, vec[e] || 0) / sum) * 1000)]));
  const top = EMOTIONS.reduce((a, b) => (mix[b] > mix[a] ? b : a));
  mix[top] += 1000 - EMOTIONS.reduce((a, e) => a + mix[e], 0);   // 丸め誤差を吸収して合計 1000 に
  return mix;
}

/** タイムゾーンごとの書式。作るのが重いので使い回す（Cloudflare Workers の CPU 時間の制限に収めるため）。 */
const minuteFormats = new Map();

/** その日の何分目か（0〜1439）。 */
function minuteOfDay(iso, timeZone) {
  let fmt = minuteFormats.get(timeZone);
  if (!fmt) {
    fmt = new Intl.DateTimeFormat("en-GB", { timeZone, hour: "2-digit", minute: "2-digit", hourCycle: "h23" });
    minuteFormats.set(timeZone, fmt);
  }
  const parts = fmt.formatToParts(new Date(iso));
  const get = (t) => Number(parts.find((p) => p.type === t).value);
  return get("hour") * 60 + get("minute");
}

/** 円周上の重み付き平均（23 時と 1 時の平均は 0 時）。ばらつき（0〜1000）も返す。 */
function circularMean(items) {
  let x = 0, y = 0, wsum = 0;
  for (const [minute, w] of items) { const a = (minute / 1440) * Math.PI * 2; x += Math.cos(a) * w; y += Math.sin(a) * w; wsum += w; }
  if (wsum === 0) return { minute: 720, spread: 1000 };
  const angle = Math.atan2(y, x);
  return { minute: Math.round(((angle / (Math.PI * 2)) * 1440 + 1440) % 1440), spread: Math.round((1 - Math.hypot(x, y) / wsum) * 1000) };
}

function lerpMinute(a, b, t) {
  const d = ((b - a + 720 * 3) % 1440) - 720;
  return Math.round((a + d * t + 1440) % 1440);
}

/** 1 日あたりの投稿数 → 0〜1000（1 日 0 件で 0、50 件でおよそ 1000 の対数スケール）。 */
const activityOf = (perDay) => Math.round(clamp(Math.log10(1 + perDay) / Math.log10(51), 0, 1) * 1000);

/** 感情の手がかりの量 → 確からしさ（0〜1）。手がかりが 3 以上あれば 1。 */
const confidenceOf = (evidence) => clamp(evidence / 3, 0, 1);

// -------------------------------------------------------------------
// 投稿の「跡」：直近の投稿 1 件ずつを、絵に足す要素として小さな整数で残す
// -------------------------------------------------------------------
/** 残す投稿の数。 */
const RECENT_MAX = 30;

function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}

/**
 * 投稿 1 件 → 整数（24 ビット）。描画モジュール（draw.js の decodeRecent）が読む。
 *   0〜2 ビット：いちばん強い感情（EMOTIONS の番号。手がかりがなければ neutral）
 *   3〜4 ビット：感情の確からしさ（0〜3）
 *   5 ビット   ：「!」を含むか
 *   6〜7 ビット：長さ（0：〜19 字、1：〜59 字、2：〜139 字、3：それ以上）
 *   8〜23 ビット：本文と日時のハッシュ（絵の中の位置を決める）
 */
function traceOf(post, a) {
  const emo = a.evidence > 0 ? EMOTIONS.indexOf(EMOTIONS.reduce((x, y) => (a.scores[y] > a.scores[x] ? y : x))) : EMOTIONS.indexOf("neutral");
  const conf = Math.round(confidenceOf(a.evidence) * 3);
  const chars = [...normalizeText(post.text)].length;
  const len = chars < 20 ? 0 : chars < 60 ? 1 : chars < 140 ? 2 : 3;
  const hash = fnv1a(`${post.text}|${post.createdAt}`) & 0xffff;
  return emo | (conf << 3) | ((a.exclaim ? 1 : 0) << 5) | (len << 6) | (hash << 8);
}

// -------------------------------------------------------------------
// 最初の作品：直近の投稿（新しい順）をまとめる
// -------------------------------------------------------------------
/**
 * @param {{ text: string, createdAt: string }[]} posts 新しい順
 * @param {{ timeZone?: string }} [opts]
 */
function estimateGenesis(posts, opts = {}) {
  const timeZone = opts.timeZone || "Asia/Tokyo";
  const vec = Object.fromEntries(EMOTIONS.map((e) => [e, 0]));
  const evidenceWords = {};
  const minutes = [];
  const recent = [];
  let exclaim = 0, emoji = 0, length = 0;

  posts.forEach((post, i) => {
    const a = analyzePost(post.text, post.langs);
    if (i < RECENT_MAX) recent.push(traceOf(post, a));
    // 新しい投稿ほど重く（40 件ごとに半分）、手がかりが多い投稿ほど重く
    const recency = Math.pow(0.5, i / 40);
    const conf = confidenceOf(a.evidence);
    if (a.evidence > 0) for (const e of EMOTIONS) vec[e] += (a.scores[e] / a.evidence) * recency * conf;
    // 手がかりのない投稿は「ふつう」に少しだけ足す（ふつうばかりの絵にならないよう控えめに）
    vec.neutral += recency * (1 - conf) * 0.35;
    for (const w of a.words) evidenceWords[w] = (evidenceWords[w] || 0) + 1;
    minutes.push([minuteOfDay(post.createdAt, timeZone), recency]);
    if (a.exclaim) exclaim++;
    if (a.emoji) emoji++;
    length += [...normalizeText(post.text)].length;
  });

  const n = posts.length;
  const times = posts.map((p) => Date.parse(p.createdAt)).filter(Number.isFinite);
  const spanDays = times.length > 1 ? Math.max(1, (Math.max(...times) - Math.min(...times)) / DAY_MS) : 1;
  const hour = circularMean(minutes);

  const state = {
    v: 1,
    mix: toMix(vec),
    activity: n ? activityOf(n / spanDays) : 0,
    minute: hour.minute,                                   // 背景の時刻（その日の何分目か）
    spread: hour.spread,                                   // 投稿時刻のばらつき（‰）
    exclaim: n ? Math.round((exclaim / n) * 1000) : 0,     // 「!」を含む投稿の割合（‰）
    emoji: n ? Math.round((emoji / n) * 1000) : 0,         // 絵文字を含む投稿の割合（‰）
    length: n ? Math.round(length / n) : 0,                // 本文の平均の長さ（文字）
    lastPostAt: times.length ? new Date(Math.max(...times)).toISOString() : null,
    posts: 0,                                              // genesis 以降に読んだ投稿の数
    recent,                                                // 直近の投稿の跡（新しい順、traceOf）
  };
  state.style = chooseStyle(state);
  state.styleRule = STYLE_RULE;
  state.base = baseOf(state);
  const topWords = Object.entries(evidenceWords).sort((a, b) => b[1] - a[1]).slice(0, 12);
  return { state, topWords };
}

/** 感情 → 動きの激しさ（0〜1）。描画側と同じ表。 */
const ENERGY = { anger: 1, excitement: 0.9, anxiety: 0.75, joy: 0.6, neutral: 0.3, nostalgia: 0.2, sadness: 0.15, calm: 0.1 };

/**
 * 画風の決め方の版。決め方を変えたら上げる。版が古い作品は、次の投稿で画風を決め直す（1 回だけ）。
 *   1：lines は感情の動きがとても激しい人だけ
 *   2：lines（流れの線）を、ふつうの人にも出るようにした
 *   3：poly（区画の多角形）をやめ、lines か orbit の 2 つにした
 */
const STYLE_RULE = 3;

/**
 * 画風を決める（最初の作品のとき。以後は STYLE_RULE が変わったときだけ決め直す）。
 *   lines（流れの線と渦）：感情に動きがある人、または「!」を含む投稿が 6% 以上の人（多くの人がここに入る）
 *   orbit（軌道の多角形）：それ以外の、落ち着いて淡々と投稿する人
 */
function chooseStyle(s) {
  const energy = EMOTIONS.reduce((a, e) => a + (s.mix[e] / 1000) * ENERGY[e], 0);
  if (energy >= 0.4 || s.exclaim >= 60) return "lines";
  return "orbit";
}

/** 引き戻し先として保存する、最初の作品の値。 */
function baseOf(s) {
  return { mix: { ...s.mix }, activity: s.activity, minute: s.minute, exclaim: s.exclaim, emoji: s.emoji, length: s.length };
}

// -------------------------------------------------------------------
// 新しい投稿：前の状態から少しだけ動かす
// -------------------------------------------------------------------
/**
 * @param {object} prev 前の状態
 * @param {{ text: string, createdAt: string }} post
 * @param {{ timeZone?: string, rate?: number, anchor?: number }} [opts]
 *   rate：1 投稿で動く最大の割合（既定 0.1）、anchor：base に引き戻す割合（既定 0.03）
 */
function evolveState(prev, post, opts = {}) {
  const timeZone = opts.timeZone || "Asia/Tokyo";
  const rate = opts.rate ?? 0.1, anchor = opts.anchor ?? 0.03;
  const a = analyzePost(post.text, post.langs);
  const conf = confidenceOf(a.evidence);
  // 手がかりの多い投稿ほど大きく動かす。手がかりがなければ、少しだけ「ふつう」に寄る
  const k = rate * lerp(0.3, 1, conf);
  const target = a.evidence > 0 ? toMix(a.scores) : toMix({ neutral: 1 });
  const base = prev.base || baseOf(prev);

  const mixVec = {};
  for (const e of EMOTIONS) mixVec[e] = lerp(lerp(prev.mix[e], target[e], k), base.mix[e], anchor);

  // 投稿の間隔から、いまの投稿ペースを推定してなじませる
  const t = Date.parse(post.createdAt), last = prev.lastPostAt ? Date.parse(prev.lastPostAt) : NaN;
  let activity = prev.activity;
  if (Number.isFinite(t) && Number.isFinite(last) && t > last) {
    const perDay = DAY_MS / Math.max(t - last, 60000);
    activity = lerp(lerp(activity, activityOf(perDay), 0.08), base.activity, anchor);
  }

  const minute = Number.isFinite(t) ? lerpMinute(lerpMinute(prev.minute, minuteOfDay(post.createdAt, timeZone), k * 0.6), base.minute, anchor) : prev.minute;
  const pull = (key, value) => Math.round(lerp(lerp(prev[key], value, k), base[key], anchor));

  return {
    v: 1,
    mix: toMix(mixVec),
    activity: Math.round(activity),
    minute,
    spread: prev.spread,
    exclaim: pull("exclaim", a.exclaim ? 1000 : 0),
    emoji: pull("emoji", a.emoji ? 1000 : 0),
    length: pull("length", [...normalizeText(post.text)].length),
    lastPostAt: Number.isFinite(t) && (!Number.isFinite(last) || t > last) ? new Date(t).toISOString() : prev.lastPostAt,
    posts: (prev.posts || 0) + 1,
    recent: [traceOf(post, a), ...(prev.recent || [])].slice(0, RECENT_MAX),
    // 画風は最初の作品で決めたまま。決め方の版が古いときだけ、最初の作品の値（base）で決め直す
    style: prev.styleRule === STYLE_RULE ? prev.style : chooseStyle(base),
    styleRule: STYLE_RULE,
    base,
  };
}

export { STYLE_RULE, RECENT_MAX, traceOf, EMOTIONS, LEXICON, analyzePost, estimateGenesis, evolveState, chooseStyle, detectLangs, toMix, minuteOfDay };
