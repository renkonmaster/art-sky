/**
 * art-sky の描画モジュール（renderer canvas2d バージョン 1 の作品コード）。
 *
 * この文字列がそのまま作品レコードの code に入り、ギャラリーの sandbox 内で実行される。
 * そのため import は使わず、このファイルだけで完結させる。
 *   - env.params：estimate.js が作った状態（感情の割合、投稿のペース、時刻など）に seed と style を足したもの
 *   - env.time  ：アニメーション作品の経過秒数（線の画風は静止画なので使わない）
 * 乱数は params.seed（DID から作る）だけを使うので、同じパラメーターからは必ず同じ絵になる。
 */
// =====================================================================
// 定数
// =====================================================================
const EMOTIONS = ["joy","calm","excitement","nostalgia","sadness","anxiety","anger","neutral"];
const EMOTION_JA = { joy:"喜び", calm:"穏やか", excitement:"高揚", nostalgia:"懐かしさ", sadness:"悲しみ", anxiety:"不安", anger:"怒り", neutral:"ふつう" };

/** 感情 → 渦の形（0 は円、3 以上は多角形の辺の数） */
const SHAPE = { anger:3, anxiety:3, excitement:4, nostalgia:5, neutral:5, joy:6, calm:0, sadness:0 };
/** 感情 → 動きの激しさ（0〜1） */
const ENERGY = { anger:1, excitement:0.9, anxiety:0.75, joy:0.6, neutral:0.3, nostalgia:0.2, sadness:0.15, calm:0.1 };

// =====================================================================
// 乱数とハッシュ
// =====================================================================
function mulberry32(a) {
  return function () {
    a |= 0; a = (a + 0x6d2b79f5) | 0;
    let t = Math.imul(a ^ (a >>> 15), 1 | a);
    t = (t + Math.imul(t ^ (t >>> 7), 61 | t)) ^ t;
    return ((t ^ (t >>> 14)) >>> 0) / 4294967296;
  };
}
function fnv1a(str) {
  let h = 0x811c9dc5;
  for (let i = 0; i < str.length; i++) { h ^= str.charCodeAt(i); h = Math.imul(h, 0x01000193); }
  return h >>> 0;
}
const seedFromDid = (did) => fnv1a(did);
/** シードと番号から、点ごとの独立した乱数列を作る（本数が変わっても他の点に影響しない） */
const subRand = (seed, i) => mulberry32(Math.imul(seed ^ 0x9e3779b9, 0x85ebca6b) ^ Math.imul(i + 1, 0xc2b2ae35));
const lerp = (a, b, t) => a + (b - a) * t;
const clamp = (v, lo, hi) => Math.min(hi, Math.max(lo, v));
const TAU = Math.PI * 2;

// =====================================================================
// 状態の時刻
// =====================================================================
/** 状態の minute（その日の何分目か）→ 時（小数） */
const hourOf = (s) => s.minute / 60;

// =====================================================================
// 投稿の跡：estimate.js の traceOf が作った整数を読む（新しい順）
// =====================================================================
const RECENT_MAX = 30;
const decodeRecent = (s) => (Array.isArray(s.recent) ? s.recent : []).slice(0, RECENT_MAX).map((v, age) => ({
  emo: EMOTIONS[v & 7] || "neutral", conf: (v >> 3) & 3, ex: (v >> 5) & 1, len: (v >> 6) & 3, hash: (v >>> 8) & 0xffff,
  age, fade: 1 - age / RECENT_MAX,
}));

// =====================================================================
// モチーフ：1 つの作品で繰り返し使う、ただ 1 つの形。スーパーフォーミュラ（Gielis）で作る
//   r(θ) = (|cos(mθ/4)|^n2 + |sin(mθ/4)|^n3)^(-1/n1)
//   m は対称の数、n1〜n3 で星・花・角の丸い多角形・とげ・ふくらみなどに変わる。値は人ごとに違うので、形は人の数だけある
// =====================================================================
const MOTIF_POINTS = 96;
function makeMotif(seed) {
  const g = mulberry32(seed ^ 0x2545f491);
  let best = null;
  // 丸に近すぎる形（いちばん細い所といちばん太い所の差が小さい）はやめて、作り直す
  for (let tries = 0; tries < 8; tries++) {
    const m = 3 + Math.floor(g() * 6);                            // 3〜8 回対称
    const n1 = lerp(0.25, 4, Math.pow(g(), 1.6));                 // 小さいほど、とがった星
    const n2 = lerp(0.4, 6, g());
    const n3 = g() < 0.5 ? n2 : lerp(0.4, 6, g());                 // n2 と違うと、花びらが非対称になる
    const pts = [];
    for (let i = 0; i < MOTIF_POINTS; i++) {
      const th = (i / MOTIF_POINTS) * TAU;
      const r = Math.pow(Math.pow(Math.abs(Math.cos((m * th) / 4)), n2) + Math.pow(Math.abs(Math.sin((m * th) / 4)), n3), -1 / n1);
      pts.push([Math.cos(th) * r, Math.sin(th) * r]);
    }
    const radii = pts.map(([x, y]) => Math.hypot(x, y)).filter(Number.isFinite);
    const max = Math.max(...radii) || 1, round = Math.min(...radii) / max;
    const motif = { m, round, pts: pts.map(([x, y]) => [x / max, y / max]) };
    if (!best || round < best.round) best = motif;
    if (round < 0.72) return motif;
  }
  return best;
}
/** モチーフの輪郭をパスにする（中心 x, y、半径 size、回転 rot） */
function motifPath(ctx, motif, x, y, size, rot) {
  const c = Math.cos(rot), sn = Math.sin(rot);
  ctx.beginPath();
  motif.pts.forEach(([px, py], i) => {
    const qx = x + (px * c - py * sn) * size, qy = y + (px * sn + py * c) * size;
    i ? ctx.lineTo(qx, qy) : ctx.moveTo(qx, qy);
  });
  ctx.closePath();
}

/** 跡の図形。モチーフがあればモチーフ、なければ感情の形。新しい跡ほど明るく、いちばん新しい跡には光の輪をつける */
function drawTraceMark(ctx, x, y, size, t, col, lw, motif) {
  const sides = SHAPE[t.emo];
  const rot = (t.hash / 0xffff) * TAU;
  const path = (k) => {
    if (motif) return motifPath(ctx, motif, x, y, size * k, rot);
    ctx.beginPath();
    if (sides === 0) ctx.arc(x, y, size * k, 0, TAU);
    else for (let i = 0; i <= sides; i++) { const an = rot + (i / sides) * TAU; i ? ctx.lineTo(x + Math.cos(an) * size * k, y + Math.sin(an) * size * k) : ctx.moveTo(x + Math.cos(an) * size * k, y + Math.sin(an) * size * k); }
    ctx.closePath();
  };
  ctx.save();
  ctx.shadowColor = hsl(col, 0.9); ctx.shadowBlur = lerp(6, 22, t.fade) * lw;
  path(1); ctx.fillStyle = hsl(col, lerp(0.15, 0.75, t.fade), 6); ctx.fill();
  ctx.shadowBlur = 0;
  ctx.strokeStyle = hsl(col, lerp(0.3, 1, t.fade), 18); ctx.lineWidth = lerp(0.8, 1.8, t.fade) * lw; ctx.stroke();
  // 入れ子：感情が強い投稿ほど多い
  for (let k = 1; k <= t.conf; k++) { path(1 - k * 0.24); ctx.lineWidth = 0.8 * lw; ctx.stroke(); }
  // 「!」のある投稿は光の筋を放つ
  if (t.ex) {
    ctx.strokeStyle = hsl(col, lerp(0.25, 0.8, t.fade), 20); ctx.lineWidth = 0.8 * lw;
    ctx.beginPath();
    for (let i = 0; i < 8; i++) { const an = rot + (i / 8) * TAU; ctx.moveTo(x + Math.cos(an) * size * 1.25, y + Math.sin(an) * size * 1.25); ctx.lineTo(x + Math.cos(an) * size * 2, y + Math.sin(an) * size * 2); }
    ctx.stroke();
  }
  if (t.age === 0) {
    for (let k = 1; k <= 3; k++) {
      ctx.strokeStyle = hsl(col, 0.55 / k, 25); ctx.lineWidth = lw;
      ctx.beginPath(); ctx.arc(x, y, size * (1.5 + k * 0.7), 0, TAU); ctx.stroke();
    }
  }
  ctx.restore();
}

// =====================================================================
// 状態 → 描画パラメーター
// =====================================================================
function skyOf(hour) {
  // 朝：生成り、昼：白に近い水色、夕：淡い桃、夜：深い藍
  const keys = [
    { h:0, c:[228, 30, 14] }, { h:4.5, c:[235, 25, 18] }, { h:6, c:[30, 40, 90] }, { h:8, c:[45, 45, 95] },
    { h:12, c:[195, 30, 96] }, { h:16.5, c:[25, 45, 94] }, { h:18.5, c:[12, 40, 89] }, { h:20, c:[245, 25, 22] }, { h:24, c:[228, 30, 14] },
  ];
  let i = 0; while (keys[i + 1].h <= hour) i++;
  const a = keys[i], b = keys[i + 1], t = (hour - a.h) / (b.h - a.h);
  const d = ((b.c[0] - a.c[0] + 540) % 360) - 180;
  return [(a.c[0] + d * t + 360) % 360, lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
}

function toDrawParams(s) {
  const dyn = s.exclaim / 1000;
  const energy = EMOTIONS.reduce((acc, e) => acc + (s.mix[e] / 1000) * ENERGY[e], 0);
  const sky = skyOf(hourOf(s));
  return {
    mix: s.mix, sky, dark: sky[2] < 50,
    energy, dyn,
    sat: lerp(0.6, 1.15, (s.emoji ?? 200) / 1000),                 // 絵文字が多いほど鮮やか
    sizeK: lerp(0.8, 1.35, clamp((s.length ?? 40) / 120, 0, 1)),     // 長文の人ほど図形が大きい
    spreadK: lerp(0.7, 1.4, (s.spread ?? 500) / 1000),              // 投稿時刻がばらつく人ほど散らばる
  };
}

function pickEmotion(mix, r) {
  let acc = 0;
  for (const e of EMOTIONS) { acc += mix[e] / 1000; if (r < acc) return e; }
  return "neutral";
}
function hsl([h, s, l], alpha = 1, dl = 0) { return `hsl(${h} ${s}% ${clamp(l + dl, 0, 100)}% / ${alpha})`; }

/** 多角形の渦の、角度 θ での半径（外接円を 1 とする）。円なら常に 1 */
function polyRadius(sides, theta) {
  if (sides === 0) return 1;
  const k = TAU / sides;
  const t = ((theta % k) + k) % k - k / 2;
  return Math.cos(Math.PI / sides) / Math.cos(t);
}

// =====================================================================
// 線バージョン：流れの場に沿って、細い線を何百本も重ねる
//   投稿数     → 線の本数（密度）
//   感情       → 線の色（多い感情ほど多く使う）、渦の形
//   「!」の割合 → 流れのねじれ、渦の数
//   時間帯     → 背景の色
//   投稿時刻のばらつき → 模様の細かさ
//   投稿の数   → 流れが少しずつずれる（投稿のたびに絵が動く）
//   DID        → 人ごとに大きく違う「型」を選ぶ：流れの場の種類、線の質感、線の出どころ、
//                背景の明暗と色味、色のずらし方
// =====================================================================
const MAX_LINES = 1500;
const FLOW_FIELDS = ["waves", "warp", "spiral", "cells", "ridges"];
const FLOW_STROKES = {
  // 本数の倍率、長さ（歩数）、太さの倍率、透明度
  hair:   { n: 1.7, steps: [18, 34],   width: 0.7, alpha: [0.35, 0.75] },
  silk:   { n: 1.0, steps: [45, 90],   width: 1.0, alpha: [0.4, 0.8] },
  ribbon: { n: 0.38, steps: [140, 230], width: 1.6, alpha: [0.22, 0.5] },
};

function drawFlowLines(ctx, w, h, s, seed) {
  const p = toDrawParams(s);
  // ふつうの投稿ペース（1 日数件）でも十分に描き込めるよう、密度は平方根でなだらかにする
  const a = Math.sqrt(s.activity / 1000), dyn = p.dyn;
  const min = Math.min(w, h), lw = Math.max(0.5, min / 700);
  const g = mulberry32(seed ^ 0x1f83d9ab);

  // ---- 人ごとの型（DID で決まり、投稿しても変わらない）
  const field = FLOW_FIELDS[Math.floor(g() * FLOW_FIELDS.length)];
  const strokeR = g();
  const stroke = FLOW_STROKES[strokeR < 0.3 ? "hair" : strokeR < 0.72 ? "silk" : "ribbon"];
  const light = g() < 0.28;                        // 明るい紙の背景
  const hueShift = (g() - 0.5) * 180;               // 背景の色味のずらし（時間帯の色から最大 ±90°）
  const paletteR = g();                             // 色の使い方：感情の色 / 1 つの色相の濃淡 / 補色の 2 色
  const palette = paletteR < 0.55 ? "emotion" : paletteR < 0.8 ? "analog" : "complement";
  const emitR = g();                                // 線の出どころ：全体 / 数か所から / 縁から
  const emit = emitR < 0.6 ? "scatter" : emitR < 0.82 ? "burst" : "edge";
  const center = [lerp(0.3, 0.7, g()), lerp(0.3, 0.7, g())];
  const spin = g() < 0.5 ? -1 : 1;

  // ---- 背景
  const sky = light ? skyOf(hourOf(s)) : nightSky(hourOf(s));
  const bg = [(sky[0] + hueShift + 360) % 360, light ? Math.min(sky[1], 35) : clamp(sky[1] + 10, 0, 70), light ? Math.max(sky[2], 92) : sky[2] + 2];
  ctx.fillStyle = hsl(bg); ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(center[0] * w, center[1] * h, 0, center[0] * w, center[1] * h, Math.hypot(w, h) * 0.6);
  glow.addColorStop(0, hsl([bg[0], bg[1], bg[2] + (light ? 4 : 7)], 0.8));
  glow.addColorStop(1, hsl(bg, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

  // ---- 色：感情の割合で選ぶ。「ふつう」は灰色になるので、半分ほどを次に多い感情の色に回す
  const ranked = EMOTIONS.filter((e) => e !== "neutral").sort((x, y) => s.mix[y] - s.mix[x]);
  const lead = NEON[ranked[0]][0];                  // いちばん多い感情の色相
  const colorOf = (r) => {
    let emo = pickEmotion(p.mix, r());
    if (emo === "neutral" && r() < 0.6) emo = ranked[Math.floor(r() * 3)];
    const c = NEON[emo];
    let hue = c[0], sat = c[1], lit = c[2];
    if (palette === "analog") { hue = lead + (r() - 0.5) * 70; sat = lerp(70, 100, r()); lit = lerp(50, 80, r()); }
    else if (palette === "complement") { hue = lead + (r() < 0.62 ? 0 : 180) + (r() - 0.5) * 24; sat = lerp(75, 100, r()); lit = lerp(52, 78, r()); }
    hue = (hue + (r() - 0.5) * 14 + 720) % 360;
    // 明るい背景では、同じ色味を濃くして使う
    return [hue, clamp(sat * p.sat, 0, 100), light ? lit - 22 : lit];
  };

  // ---- 流れの場
  const scale = lerp(1.4, 3.6, (s.spread ?? 500) / 1000) * lerp(0.8, 1.3, g());
  const swirl = lerp(0.6, 1.3, clamp(dyn * 0.7 + p.energy * 0.6, 0, 1));
  const drift = (s.posts ?? 0) * 0.035;            // 投稿のたびに少しずれる
  const ph = [g() * 10 + drift, g() * 10 - drift * 0.7, g() * 10 + drift * 0.5, g() * 10];
  const fx = [lerp(1.2, 2.0, g()), lerp(1.0, 1.6, g()), lerp(0.7, 1.1, g())];
  const baseAng = g() * TAU;
  const warpK = lerp(0.15, 0.4, g());
  const base = (x, y) => {
    const nx = x * scale, ny = y * scale;
    switch (field) {
      case "warp": {
        // 座標そのものをゆがめてから波を重ねる（大理石のような模様）
        const wx = nx + Math.sin(ny * 1.7 + ph[3]) * warpK * scale, wy = ny + Math.cos(nx * 1.3 + ph[2]) * warpK * scale;
        return (Math.sin(wx * fx[0] + ph[0]) + Math.cos(wy * fx[1] + ph[1])) * Math.PI * swirl;
      }
      case "spiral": {
        // 中心のまわりを回りながら外へ広がる（銀河のような渦）
        const dx = x - center[0], dy = y - center[1], d = Math.hypot(dx, dy);
        return Math.atan2(dy, dx) + spin * (Math.PI / 2 + lerp(0.15, 0.6, dyn)) + Math.sin(d * scale * 4 + ph[0]) * 0.5 * swirl;
      }
      case "cells":
        // 小さな渦が市松模様に並ぶ
        return (Math.sin(nx * fx[0] * 1.4 + ph[0]) * Math.cos(ny * fx[1] * 1.4 + ph[1])) * Math.PI * 1.6 * swirl + baseAng;
      case "ridges":
        // ある向きに流れながら、うねる帯になる（等高線のような模様）
        return baseAng + Math.sin(ny * fx[0] * 2 + Math.sin(nx * fx[1] + ph[0]) * 1.5 + ph[1]) * lerp(0.5, 1.2, swirl);
      default:
        return (Math.sin(nx * fx[0] + ph[0]) + Math.cos(ny * fx[1] + ph[1]) + Math.sin((nx + ny) * fx[2] + ph[2])) * Math.PI * swirl;
    }
  };
  // 渦：感情の形（円・多角形）に沿って回す場所を置く
  const vortices = Array.from({ length: Math.round(lerp(0, 4, dyn) + g() * 1.5) }, () => {
    const emo = pickEmotion(p.mix, g());
    return { x: lerp(0.12, 0.88, g()), y: lerp(0.12, 0.88, g()), R: lerp(0.06, 0.17, g()) * p.sizeK, spin: g() < 0.5 ? -1 : 1, sides: SHAPE[emo], rot: g() * TAU };
  });
  // 投稿の跡：新しい 6 件は渦になる（新しいほど強い）
  const recent = decodeRecent(s);
  const tracePos = (t) => { const r = mulberry32(t.hash ^ seed); return [lerp(0.1, 0.9, r()), lerp(0.1, 0.9, r())]; };
  for (const t of recent.slice(0, 6)) {
    const [x, y] = tracePos(t);
    vortices.push({ x, y, R: lerp(0.05, 0.12, (t.len + t.conf) / 6) * p.sizeK, spin: t.hash & 1 ? 1 : -1, sides: SHAPE[t.emo], rot: (t.hash / 0xffff) * TAU, k: lerp(0.4, 1, t.fade) });
  }
  const angle = (x, y) => {
    let t = base(x, y);
    for (const v of vortices) {
      const dx = x - v.x, dy = y - v.y, d = Math.hypot(dx, dy);
      const R = v.R * polyRadius(v.sides, Math.atan2(dy, dx) - v.rot);
      const k = Math.exp(-((d - R) ** 2) / (2 * (v.R * 0.5) ** 2));
      // 渦の縁では、接線の向きに寄せる
      const tangent = Math.atan2(dy, dx) + (Math.PI / 2) * v.spin;
      const diff = ((tangent - t + Math.PI * 3) % TAU) - Math.PI;
      t += diff * k * 0.85 * (v.k ?? 1);
    }
    return t;
  };

  // ---- 線の出どころ
  const sources = Array.from({ length: 2 + Math.floor(g() * 4) }, () => [lerp(0.15, 0.85, g()), lerp(0.15, 0.85, g()), lerp(0.05, 0.2, g())]);
  const startOf = (r) => {
    if (emit === "burst" && r() < 0.75) {
      const [sx, sy, sr] = sources[Math.floor(r() * sources.length)];
      const an = r() * TAU, rr = sr * Math.sqrt(r());
      return [sx + Math.cos(an) * rr, sy + Math.sin(an) * rr];
    }
    if (emit === "edge" && r() < 0.7) {
      const t = r(), side = Math.floor(r() * 4);
      return side === 0 ? [t, -0.02] : side === 1 ? [1.02, t] : side === 2 ? [t, 1.02] : [-0.02, t];
    }
    return [lerp(-0.05, 1.05, r()), lerp(-0.05, 1.05, r())];
  };

  const n = Math.round(lerp(420, MAX_LINES, a) * stroke.n);
  const step = 0.006;
  ctx.lineCap = "round";
  for (let i = 0; i < n; i++) {
    const r = subRand(seed ^ 0x5be0cd19, i);
    let [x, y] = startOf(r);
    const steps = Math.round(lerp(stroke.steps[0], stroke.steps[1], r()) * lerp(0.85, 1.1, a));
    ctx.strokeStyle = hsl(colorOf(r), Math.min(1, lerp(stroke.alpha[0], stroke.alpha[1], r()) + (light ? 0.12 : 0)));
    ctx.lineWidth = lerp(0.4, 1.8, r() * r()) * lw * stroke.width * lerp(0.9, 1.2, (s.length ?? 40) / 120);
    ctx.beginPath(); ctx.moveTo(x * w, y * h);
    for (let k = 0; k < steps; k++) {
      const t = angle(x, y);
      x += Math.cos(t) * step * (min / w); y += Math.sin(t) * step * (min / h);
      ctx.lineTo(x * w, y * h);
    }
    ctx.stroke();
  }

  // ---- 投稿の跡：1 件ごとに、その場所から流れに沿って光る線を数本引く
  for (const t of recent.slice().reverse()) {
    const [sx, sy] = tracePos(t);
    const c = [NEON[t.emo][0], NEON[t.emo][1], light ? NEON[t.emo][2] - 25 : NEON[t.emo][2] + 8];
    ctx.save();
    ctx.shadowColor = hsl(c, 0.9); ctx.shadowBlur = lerp(2, 14, t.fade) * lw;
    ctx.strokeStyle = hsl(c, lerp(0.25, 0.95, t.fade)); ctx.lineWidth = lerp(1, 2.6, t.fade) * lw * (t.ex ? 1.3 : 1);
    for (let j = 0; j < 2 + t.conf; j++) {
      const r = mulberry32(t.hash * 31 + j);
      let x = sx + (r() - 0.5) * 0.04, y = sy + (r() - 0.5) * 0.04;
      ctx.beginPath(); ctx.moveTo(x * w, y * h);
      for (let k = 0; k < 70 + t.len * 25; k++) {
        const th = angle(x, y);
        x += Math.cos(th) * 0.006 * (min / w); y += Math.sin(th) * 0.006 * (min / h);
        ctx.lineTo(x * w, y * h);
      }
      ctx.stroke();
    }
    ctx.restore();
    if (t.age === 0) drawTraceMark(ctx, sx * w, sy * h, min * 0.018, t, c, lw);
  }
}

// =====================================================================
// 軌道バージョン：暗い空に、半透明の多角形が軌道に沿って散らばる
//   配置の型（DID で決まる）：渦巻き / 同心の輪 / いくつかの星団 / 波の帯 / 結び目（リサージュ曲線） /
//   周転円（円運動を重ねた曲線。周波数と大きさが人ごとに違うので、形は人の数だけある）。
//   さらに 2 つの型を人ごとの割合で混ぜるので、配置は連続的に無数にある。
//   投稿数     → 多角形・線・光の粒の数（密度）
//   感情       → 多角形の形と色、回転と公転の速さ（動きの激しさ）
//   「!」の割合 → ダイナミックさ（腕の数、大きさの差、形のゆがみ、軌道からのはみ出し）
//   時間帯     → 背景の色（どの時間帯も暗めの空にして、多角形を光らせる）
//   DID        → シード
// =====================================================================
const NEON = {
  joy:[52,100,62], calm:[186,95,58], excitement:[28,100,60], nostalgia:[18,85,74],
  sadness:[212,90,64], anxiety:[272,75,68], anger:[335,95,62], neutral:[200,20,82],
};
const MAX_SHAPES = 260, MAX_SPARKS = 700, MAX_RAYS = 48;
const ORBIT_LAYOUTS = ["spiral", "rings", "clusters", "waves", "knot", "epicycle"];

function nightSky(hour) {
  // 朝：深い青緑、昼：深い青、夕：深い紫、夜：ほぼ黒の藍
  const keys = [
    { h:0, c:[228, 45, 7] }, { h:5, c:[235, 40, 9] }, { h:7, c:[192, 45, 13] },
    { h:12, c:[214, 50, 16] }, { h:17, c:[282, 40, 14] }, { h:20, c:[245, 45, 9] }, { h:24, c:[228, 45, 7] },
  ];
  let i = 0; while (keys[i + 1].h <= hour) i++;
  const a = keys[i], b = keys[i + 1], t = (hour - a.h) / (b.h - a.h);
  const d = ((b.c[0] - a.c[0] + 540) % 360) - 180;
  return [(a.c[0] + d * t + 360) % 360, lerp(a.c[1], b.c[1], t), lerp(a.c[2], b.c[2], t)];
}

function drawOrbitArt(ctx, w, h, s, seed, time = 0) {
  const p = toDrawParams(s);
  const a = s.activity / 1000, dyn = p.dyn;
  const neon = (emo) => { const c = NEON[emo]; return [c[0], clamp(c[1] * p.sat, 0, 100), c[2]]; };
  const min = Math.min(w, h), lw = Math.max(0.6, min / 600);
  const g0 = mulberry32(seed ^ 0x6a09e667);
  // 「ふつう」は灰色になるので、6 割ほどを次に多い感情に回す
  const ranked = EMOTIONS.filter((e) => e !== "neutral").sort((x, y) => s.mix[y] - s.mix[x]);
  const pickColorful = (r) => { const e = pickEmotion(p.mix, r()); return e === "neutral" && r() < 0.6 ? ranked[Math.floor(r() * 3)] : e; };
  // この作品のモチーフ（すべての図形がこの形）。対称の数の分だけ回すと同じ形なので、向きはその範囲で変える
  const motif = makeMotif(seed);

  // 配置の型と形（DID で決まる）
  const layout = ORBIT_LAYOUTS[Math.floor(g0() * ORBIT_LAYOUTS.length)];
  // 2 つ目の型と混ぜる割合（3 割ほどの人は混ぜない）
  const layout2 = ORBIT_LAYOUTS[Math.floor(g0() * ORBIT_LAYOUTS.length)];
  const blend = g0() < 0.3 ? 0 : lerp(0.2, 0.6, g0());
  const cx = w * lerp(0.4, 0.6, g0()), cy = h * lerp(0.4, 0.6, g0());
  const posts = s.posts ?? 0;
  const squash = lerp(0.75, 1, g0()) * (1 - 0.12 * Math.sin(posts * 0.21)), tilt = g0() * TAU + posts * 0.025;
  const arms = layout === "rings" ? 3 + Math.floor(g0() * 3) : layout === "clusters" || layout === "waves" ? 2 + Math.floor(g0() * 3) : 1 + Math.round(dyn * 2 + g0() * 0.6);
  const turns = lerp(0.9, 1.6, g0());
  const spin = g0() < 0.5 ? -1 : 1;
  const orbitSpeed = spin * lerp(0.01, 0.06, p.energy);   // 公転の速さ
  const maxR = Math.hypot(w, h) * (layout === "rings" ? 0.42 : 0.55);
  const hueShift = (g0() - 0.5) * 160;                    // 背景の色味のずらし
  // 型ごとの値
  const clusters = Array.from({ length: arms }, (_, i) => ({ x: lerp(0.18, 0.82, g0()), y: lerp(0.18, 0.82, g0()), R: min * lerp(0.1, 0.24, g0()), ph: g0() * TAU, i }));
  const bands = Array.from({ length: arms }, (_, i) => ({ y: lerp(0.15, 0.85, (i + 0.5) / arms) + (g0() - 0.5) * 0.08, amp: lerp(0.03, 0.12, g0()), freq: lerp(0.8, 2.4, g0()), ph: g0() * TAU }));
  const liss = { A: 1 + Math.floor(g0() * 3), B: 2 + Math.floor(g0() * 3), d: g0() * TAU };
  // 周転円：整数の周波数（閉じた曲線になる）と、だんだん小さくなる半径
  const epi = Array.from({ length: 3 }, (_, k) => ({ f: (1 + Math.floor(g0() * 4)) * (g0() < 0.5 ? -1 : 1) * (k + 1), r: lerp(0.5, 1, g0()) / (k + 1), ph: g0() * TAU }));
  const epiNorm = epi.reduce((acc, e) => acc + e.r, 0);
  const rotate = (x0, y0) => [cx + x0 * Math.cos(tilt) - y0 * Math.sin(tilt), cy + x0 * Math.sin(tilt) + y0 * Math.cos(tilt)];
  const drift = spin * posts * 0.09;                      // 投稿のたびに公転が進む

  /** 軌道上の位置。arm は軌道の番号、u は軌道上の進み具合（0〜1）、off は軌道からのずれ。2 つの型を混ぜる */
  const spiral = (arm, u, off) => {
    const A = placeIn(layout, arm, u, off);
    if (!blend || layout2 === layout) return A;
    const B = placeIn(layout2, arm, u, off);
    return [lerp(A[0], B[0], blend), lerp(A[1], B[1], blend), A[2]];
  };
  function placeIn(kind, arm, u, off) {
    const t = time * orbitSpeed;
    switch (kind) {
      case "rings": {
        // 同心の輪。輪ごとに逆向き・違う速さで回る
        const dir = arm % 2 ? -1 : 1;
        const th = u * TAU + arm * 1.3 + (t + drift) * dir * (1 + arm * 0.35);
        const rr = maxR * lerp(0.18, 1, (arm + 0.5) / arms) + off * min;
        return [...rotate(Math.cos(th) * rr, Math.sin(th) * rr * squash), th];
      }
      case "clusters": {
        // 星団：中心のまわりに小さな渦。中心も投稿のたびに少しずつ動く
        const c = clusters[arm];
        const ccx = (c.x + Math.cos(posts * 0.13 + c.ph) * 0.04) * w, ccy = (c.y + Math.sin(posts * 0.11 + c.ph) * 0.04) * h;
        const th = u * TAU * 1.6 + c.ph + t + drift;
        const rr = Math.sqrt(u) * c.R + off * min * 0.6;
        return [ccx + Math.cos(th) * rr, ccy + Math.sin(th) * rr * squash, th];
      }
      case "waves": {
        // 波の帯：画面を横切るうねり。投稿のたびに波が進む
        const b = bands[arm];
        const x = lerp(-0.08, 1.08, u), y = b.y + Math.sin(u * b.freq * TAU + b.ph + drift * 1.3 + t) * b.amp;
        const [rx, ry] = rotate((x - 0.5) * w * 1.1, (y - 0.5) * h + off * min);
        return [rx - cx + w / 2, ry - cy + h / 2, u * TAU];
      }
      case "knot": {
        // 結び目：リサージュ曲線
        const th = u * TAU + (arm / arms) * 0.6 + (t + drift) * 0.5;
        const x = Math.sin(liss.A * th + liss.d), y = Math.sin(liss.B * th);
        const k = 1 + off * 2.2;
        return [...rotate(x * w * 0.42 * k, y * h * 0.42 * k * squash), th];
      }
      case "epicycle": {
        // 周転円：円運動を 3 つ重ねる。軌道ごとに少しずつ位相をずらす
        const th = u * TAU + (arm / arms) * 0.5 + (t + drift) * 0.4;
        let x = 0, y = 0;
        for (const e of epi) { x += Math.cos(e.f * th + e.ph) * e.r; y += Math.sin(e.f * th + e.ph) * e.r; }
        const k = (0.44 / epiNorm) * (1 + off * 2.2);
        return [...rotate(x * w * k, y * h * k * squash), th];
      }
      default: {
        // 渦巻き
        const th = (arm / arms) * TAU + u * turns * TAU + t + drift;
        const rr = lerp(0.06, 1, u) * maxR + off * min;
        return [...rotate(Math.cos(th) * rr, Math.sin(th) * rr * squash), th];
      }
    }
  }
  /** 光の線の出どころ（星団ならその中心） */
  const hubIn = (kind, arm) => {
    if (kind !== "clusters") return [cx, cy];
    const c = clusters[arm];
    return [(c.x + Math.cos(posts * 0.13 + c.ph) * 0.04) * w, (c.y + Math.sin(posts * 0.11 + c.ph) * 0.04) * h];
  };
  const hubOf = (arm) => { const A = hubIn(layout, arm), B = hubIn(layout2, arm); return [lerp(A[0], B[0], blend), lerp(A[1], B[1], blend)]; };

  // --- 背景：空の色＋中心のぼんやりした明るさ
  const sky0 = nightSky(hourOf(s));
  const sky = [(sky0[0] + hueShift + 360) % 360, clamp(sky0[1] + 8, 0, 70), sky0[2]];
  ctx.fillStyle = hsl(sky); ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, Math.hypot(w, h) * 0.55);
  glow.addColorStop(0, hsl([sky[0], sky[1], sky[2] + 10], 0.9));
  glow.addColorStop(1, hsl(sky, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

  // --- ガイド線：中心を通る十字の点線と、薄い格子
  ctx.save();
  ctx.strokeStyle = hsl([195, 60, 70], 0.28); ctx.lineWidth = lw;
  ctx.setLineDash([1.5 * lw, 5 * lw]);
  if (layout === "spiral" || layout === "rings") { ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke(); }
  ctx.strokeStyle = hsl([200, 40, 60], 0.12); ctx.setLineDash([]);
  const gridN = 2 + Math.round(a * 4);
  ctx.beginPath();
  for (let i = 0; i < gridN; i++) {
    const gx = w * g0(), gy = h * g0();
    ctx.moveTo(gx, 0); ctx.lineTo(gx, h); ctx.moveTo(0, gy); ctx.lineTo(w, gy);
  }
  ctx.stroke();

  // --- 軌道：破線の楕円と渦巻き
  for (let arm = 0; arm < arms; arm++) {
    const emo = pickEmotion(p.mix, g0());
    ctx.strokeStyle = hsl(neon(emo), 0.4); ctx.lineWidth = lw;
    ctx.setLineDash([4 * lw, 7 * lw]);
    ctx.beginPath();
    for (let k = 0; k <= 160; k++) { const [x, y] = spiral(arm, k / 160, 0); k ? ctx.lineTo(x, y) : ctx.moveTo(x, y); }
    ctx.stroke();
  }
  for (let k = 0; k < (layout === "spiral" ? 2 : 0); k++) {
    ctx.strokeStyle = hsl(neon(pickEmotion(p.mix, g0())), 0.25);
    ctx.setLineDash([2 * lw, 9 * lw]);
    ctx.beginPath(); ctx.ellipse(cx, cy, maxR * lerp(0.35, 0.8, g0()), maxR * lerp(0.35, 0.8, g0()) * squash, tilt, 0, TAU); ctx.stroke();
  }
  ctx.restore();

  // --- 多角形の配置を先に決める（光の線を多角形に向けて引くため）
  const nShapes = Math.round(lerp(28, MAX_SHAPES, Math.pow(a, 0.9)));
  const shapes = [];
  for (let i = 0; i < nShapes; i++) {
    const r = subRand(seed ^ 0x3c6ef372, i);
    const emo = pickColorful(r);
    const arm = Math.floor(r() * arms);
    const u = Math.pow(r(), 0.8);
    const spread = (r() - 0.5) * lerp(0.08, 0.3, dyn) * p.spreadK * (r() < 0.15 ? 3 : 1);
    const [x, y, th] = spiral(arm, u, spread);
    const size = p.sizeK * min * lerp(0.018, lerp(0.05, 0.1, dyn), Math.pow(r(), lerp(2.2, 1.2, dyn)));
    const sides = SHAPE[emo] || 0;
    const warp = Array.from({ length: 6 }, () => 1 + (r() - 0.5) * lerp(0.1, 0.8, dyn));
    const rotSpeed = (r() - 0.5) * ENERGY[emo] * 1.6;
    const rot = th + r() * TAU + time * rotSpeed;
    const style = r();     // 塗り＋線 / 線だけ / 塗りだけ
    const alpha = lerp(0.35, 0.85, r());
    const glowy = r() < 0.14;
    shapes.push({ x, y, size, sides, warp, rot, emo, style, alpha, glowy, u, arm });
  }

  // --- 光の線：中心から一部の多角形へ伸びる細い線
  const nRays = Math.round(lerp(4, MAX_RAYS, a) * (layout === "waves" || layout === "knot" ? 0.3 : 1));
  ctx.save(); ctx.lineWidth = 0.7 * lw;
  for (let i = 0; i < Math.min(nRays, shapes.length); i++) {
    const sh = shapes[(i * 7919) % shapes.length];
    const [hx, hy] = hubOf(sh.arm);
    const ox = hx + (g0() - 0.5) * min * 0.04, oy = hy + (g0() - 0.5) * min * 0.04;
    ctx.strokeStyle = hsl(neon(sh.emo), lerp(0.25, 0.6, g0()));
    ctx.beginPath(); ctx.moveTo(ox, oy); ctx.lineTo(sh.x, sh.y); ctx.stroke();
  }
  ctx.restore();

  // --- 光の粒：渦巻きに沿ってまく
  const nSparks = Math.round(lerp(60, MAX_SPARKS, a));
  for (let i = 0; i < nSparks; i++) {
    const r = subRand(seed ^ 0xbb67ae85, i);
    const [x, y] = spiral(Math.floor(r() * arms), r(), (r() - 0.5) * 0.35);
    const tw = 0.5 + 0.5 * Math.sin(time * 2 + i);
    ctx.fillStyle = hsl(neon(pickColorful(r)), lerp(0.2, 0.8, r()) * (0.6 + 0.4 * tw));
    const sz = (r() < 0.9 ? 1 : 2) * lw;
    ctx.fillRect(x, y, sz, sz);
  }

  // --- 多角形：外側（大きい u）から描いて、中心側を手前にする
  shapes.sort((p1, p2) => p2.u - p1.u);
  for (const sh of shapes) {
    const col = neon(sh.emo);
    motifPath(ctx, motif, sh.x, sh.y, sh.size, sh.rot);
    if (sh.glowy) { ctx.shadowColor = hsl(col, 0.9); ctx.shadowBlur = 14 * lw; }
    if (sh.style < 0.75) {
      // 半透明のグラデーション。片側が明るく、反対側が透ける
      const gr = ctx.createLinearGradient(sh.x - sh.size, sh.y - sh.size, sh.x + sh.size, sh.y + sh.size);
      gr.addColorStop(0, hsl(col, sh.alpha, 12));
      gr.addColorStop(1, hsl(col, sh.alpha * 0.25, -12));
      ctx.fillStyle = gr; ctx.fill();
    }
    ctx.shadowBlur = 0;
    if (sh.style > 0.45) { ctx.strokeStyle = hsl(col, 0.9, 8); ctx.lineWidth = 1.1 * lw; ctx.stroke(); }
  }

  // --- 投稿の跡：1 件ごとに渦巻き上へ光る図形を置き、古い順に細い線でつなぐ
  const traces = decodeRecent(s).map((t) => {
    const r = mulberry32(t.hash ^ seed);
    const [x, y] = spiral(Math.floor(r() * arms), lerp(0.1, 0.95, r()), (r() - 0.5) * 0.12);
    return { ...t, x, y, size: p.sizeK * min * lerp(0.022, 0.06, (t.len + t.conf) / 6) * (t.ex ? 1.2 : 1) };
  }).reverse();
  ctx.save(); ctx.setLineDash([3 * lw, 5 * lw]); ctx.lineWidth = 0.8 * lw;
  for (let i = 1; i < traces.length; i++) {
    ctx.strokeStyle = hsl(neon(traces[i].emo), 0.35 * traces[i].fade);
    ctx.beginPath(); ctx.moveTo(traces[i - 1].x, traces[i - 1].y); ctx.lineTo(traces[i].x, traces[i].y); ctx.stroke();
  }
  ctx.restore();
  for (const t of traces) drawTraceMark(ctx, t.x, t.y, t.size, t, neon(t.emo), lw, motif);
}

function drawArt(ctx, w, h, s, seed, style, time = 0) {
  // 以前の「区画（poly）」の画風は廃止した。古い状態のまま描くときは軌道で描く
  if (style === "orbit" || style === "poly") drawOrbitArt(ctx, w, h, s, seed, time);
  else drawFlowLines(ctx, w, h, s, seed);
}


export default function draw(ctx, env) {
  const s = env.params;
  const seed = (s.seed >>> 0) || 1;
  drawArt(ctx, env.width, env.height, s, seed, s.style || "orbit", env.time || 0);
}
