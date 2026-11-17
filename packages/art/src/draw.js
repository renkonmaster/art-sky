/**
 * art-sky の描画モジュール（renderer canvas2d バージョン 1 の作品コード）。
 *
 * この文字列がそのまま作品レコードの code に入り、ギャラリーの sandbox 内で実行される。
 * そのため import は使わず、このファイルだけで完結させる。
 *   - env.params：estimate.js が作った状態（感情の割合、投稿のペース、時刻など）に seed と style を足したもの
 *   - env.time  ：アニメーション作品の経過秒数（線の画風は静止画なので常に 0）
 * 乱数は params.seed（DID から作る）だけを使うので、同じパラメーターからは必ず同じ絵になる。
 */
// =====================================================================
// 定数
// =====================================================================
const EMOTIONS = ["joy","calm","excitement","nostalgia","sadness","anxiety","anger","neutral"];
const EMOTION_JA = { joy:"喜び", calm:"穏やか", excitement:"高揚", nostalgia:"懐かしさ", sadness:"悲しみ", anxiety:"不安", anger:"怒り", neutral:"ふつう" };

/** 感情 → 渦の形（0 は円、3 以上は多角形の辺の数） */
const SHAPE = { anger:3, anxiety:3, excitement:4, nostalgia:5, neutral:5, joy:6, calm:0, sadness:0 };
/** 感情 → 線の色 [色相, 彩度, 明度]。細い線を重ねる前提で、やや落ち着いた色 */
const COLOR = {
  joy:[40,75,48], calm:[185,55,42], excitement:[12,75,52], nostalgia:[28,45,45],
  sadness:[215,50,45], anxiety:[270,25,48], anger:[355,70,45], neutral:[30,8,40],
};
/** 感情 → 動きの激しさ（0〜1） */
const ENERGY = { anger:1, excitement:0.9, anxiety:0.75, joy:0.6, neutral:0.3, nostalgia:0.2, sadness:0.15, calm:0.1 };

const MAX_AGENTS = 1600, MAX_VORTICES = 5, MAX_STREAMS = 3;

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
  const a = s.activity / 1000, dyn = s.exclaim / 1000;
  const energy = EMOTIONS.reduce((acc, e) => acc + (s.mix[e] / 1000) * ENERGY[e], 0);
  const sky = skyOf(hourOf(s));
  return {
    mix: s.mix, sky, dark: sky[2] < 50,
    agents: Math.round(lerp(150, MAX_AGENTS, Math.pow(a, 0.9))),   // 線の本数
    steps: Math.round(lerp(120, 320, a)),                           // 線の長さ
    vortices: 1 + Math.round(dyn * (MAX_VORTICES - 1)),             // 渦の数
    vortexPull: lerp(0.7, 1.8, dyn),                                // 渦の強さ
    waviness: lerp(1.0, 3.2, dyn),                                  // 流れのうねり
    speed: lerp(1.1, 2.2, energy),                                  // 進む速さ
    jitter: lerp(0.03, 0.35, energy),                               // ふらつき
    curl: lerp(0.0, 0.32, energy),                                  // 点ごとの回転癖（輪ができる）
    follow: lerp(0.35, 0.12, energy),                               // 流れに従う強さ
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
// 流れの場：ゆるい流れ ＋ 帯（流れが集まる道） ＋ 渦（感情の形）
// 座標は短い辺を 1 とした値で計算するので、キャンバスの大きさが違っても同じ絵になる
// =====================================================================
function makeField(seed, p) {
  const r = mulberry32(seed ^ 0xa5a5a5a5);
  const base = r() * TAU;
  const waves = Array.from({ length: 3 }, () => ({ fx: lerp(0.5, 1.5, r()), fy: lerp(0.5, 1.5, r()), px: r() * TAU, py: r() * TAU, amp: lerp(0.4, 1, r()) }));

  const vortices = Array.from({ length: MAX_VORTICES }, () => ({
    x: lerp(0.15, 0.85, r()), y: lerp(0.15, 0.85, r()),
    R: lerp(0.05, 0.11, r()), spin: r() < 0.5 ? -1 : 1, rot: r() * TAU, emoR: r(),
  })).slice(0, p.vortices).map((v) => ({ ...v, emo: pickEmotion(p.mix, v.emoR) }));

  const streams = Array.from({ length: MAX_STREAMS }, () => ({
    ang: r() * Math.PI, off: lerp(-0.25, 0.25, r()), bend: lerp(-0.6, 0.6, r()), w: lerp(0.03, 0.07, r()), emoR: r(),
  })).map((s) => ({ ...s, emo: pickEmotion(p.mix, s.emoR) }));

  function vel(x, y) {
    // ゆるい流れ
    let ang = base;
    for (const w of waves) ang += w.amp * p.waviness * 0.5 * Math.sin(w.fx * x * TAU + w.px) * Math.cos(w.fy * y * TAU + w.py);
    let vx = Math.cos(ang) * 0.6, vy = Math.sin(ang) * 0.6;

    // 帯：中心線に引き寄せ、線に沿って流す
    for (const s of streams) {
      const cx = x - 0.5, cy = y - 0.5;
      const ux = Math.cos(s.ang), uy = Math.sin(s.ang);
      const along = cx * ux + cy * uy;
      const across = -cx * uy + cy * ux - s.off - s.bend * along * along;
      const wgt = Math.exp(-(across * across) / (2 * s.w * s.w * 9));
      vx += wgt * (ux * 1.4 + uy * across * 6);
      vy += wgt * (uy * 1.4 - ux * across * 6);
    }

    // 渦：多角形の軌道に沿って回す
    let cap = 0;
    for (const v of vortices) {
      const dx = x - v.x, dy = y - v.y, d = Math.hypot(dx, dy) + 1e-6;
      const th = Math.atan2(dy, dx);
      const sides = SHAPE[v.emo];
      // 法線：円なら中心から外向き、多角形ならいま近い辺の外向き
      let na = th, target = v.R;
      if (sides > 0) {
        const k = TAU / sides, phi = ((th - v.rot) % TAU + TAU) % TAU;
        na = v.rot + Math.floor(phi / k) * k + k / 2;
        target = v.R * Math.cos(Math.PI / sides);
      }
      const nx = Math.cos(na), ny = Math.sin(na);
      const dn = dx * nx + dy * ny;                    // 辺（または円）までの距離
      const wgt = p.vortexPull * Math.exp(-(d * d) / (2 * (v.R * 2.6) ** 2));
      const corr = clamp((target - dn) / v.R, -1.5, 1.5);
      if (d < v.R * 1.6) cap = Math.max(cap, 1);
      vx += wgt * (-ny * v.spin * 2.2 + nx * corr * 2.4);
      vy += wgt * (nx * v.spin * 2.2 + ny * corr * 2.4);
    }
    return [vx, vy, cap];
  }
  return { vel, vortices, streams };
}

// =====================================================================
// 描画：点を歩かせて線を引く。advance(n) で n 歩ずつ進める（過程を見せるため）
// =====================================================================
function createPainter(ctx, w, h, s, seed, density = 1) {
  const p = toDrawParams(s);
  const field = makeField(seed, p);
  const min = Math.min(w, h), ox = (w - min) / 2, oy = (h - min) / 2;

  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, hsl(p.sky, 1, p.dark ? -3 : 2));
  g.addColorStop(1, hsl(p.sky, 1, p.dark ? 4 : -3));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  // 点：近くの帯や渦の感情の色を取りやすくする（色の帯ができる）
  const n = Math.round(p.agents * density);
  const agents = [];
  for (let i = 0; i < MAX_AGENTS; i++) {
    if (i >= n) break;
    const r = subRand(seed, i);
    const x = lerp(-0.1, 1.1, r()), y = lerp(-0.1, 1.1, r());
    let emo = pickEmotion(p.mix, r());
    const local = r();
    for (const v of field.vortices) if (Math.hypot(x - v.x, y - v.y) < v.R * 3 && local < 0.75) emo = v.emo;
    const inkR = r();
    const ink = inkR < 0.07;
    const color = ink ? (p.dark ? [40, 15, 85] : [30, 10, 12]) : COLOR[emo];
    const alpha = lerp(0.12, 0.4, r()) * (density < 1 ? 1.4 : 1);
    const curl = (r() - 0.5) * 2 * p.curl * (r() < 0.6 ? 1 : 0.2);
    agents.push({
      x, y, r, curl, heading: null, trapped: 0, dead: false,
      stroke: hsl(color, alpha, p.dark && !ink ? 22 : 0), width: inkR > 0.93 ? 1.1 : 0.55,
    });
  }

  const step = (0.0042 * p.speed);
  const TRAP_LIMIT = 70;  // 渦の中を回り続けたら止める（塊にならないように）
  let done = 0;
  ctx.lineCap = "round"; ctx.lineJoin = "round";
  return {
    total: p.steps,
    advance(k) {
      const upto = Math.min(p.steps, done + k);
      const lw = Math.max(0.5, min / 600);
      for (const a of agents) {
        if (a.dead) continue;
        ctx.strokeStyle = a.stroke; ctx.lineWidth = a.width * lw;
        ctx.beginPath(); ctx.moveTo(ox + a.x * min, oy + a.y * min);
        for (let t = done; t < upto; t++) {
          const [vx, vy, cap] = field.vel(a.x, a.y);
          a.trapped = cap ? a.trapped + 1 : 0;
          if (a.trapped > TRAP_LIMIT) { a.dead = true; break; }
          const target = Math.atan2(vy, vx);
          if (a.heading === null) a.heading = target;
          // 向きに慣性を持たせ、回転癖とふらつきを足してから流れの向きへ寄せる
          a.heading += a.curl + (a.r() - 0.5) * p.jitter;
          const diff = ((target - a.heading + Math.PI * 3) % TAU) - Math.PI;
          a.heading += diff * p.follow;
          a.x += Math.cos(a.heading) * step; a.y += Math.sin(a.heading) * step;
          ctx.lineTo(ox + a.x * min, oy + a.y * min);
        }
        ctx.stroke();
      }
      done = upto;
      return done >= p.steps;
    },
  };
}

function drawLinesFull(ctx, w, h, s, seed, density) { const pt = createPainter(ctx, w, h, s, seed, density); pt.advance(pt.total); }

// =====================================================================
// 多角形バージョン：画面を多角形に分割し、各区画に入れ子の多角形を描く
//   投稿数     → 区画の数と、入れ子の重なりの数（密度）
//   感情       → 区画ごとの形（正多角形の辺の数）、色、動きの激しさ
//   「!」の割合 → ダイナミックさ（分割線の傾き、ねじれ、大きさの差）
//   DID        → シード。区画は分割の経路ごとに乱数を持つので、状態が少し変わっても構図は崩れない
// =====================================================================
const area = (pts) => Math.abs(pts.reduce((a, [x, y], i) => { const [x2, y2] = pts[(i + 1) % pts.length]; return a + x * y2 - x2 * y; }, 0)) / 2;
const centroid = (pts) => { let x = 0, y = 0; for (const p of pts) { x += p[0]; y += p[1]; } return [x / pts.length, y / pts.length]; };

/** 凸多角形を、点 (px, py) を通る角度 ang の直線で 2 つに分ける */
function splitPoly(pts, px, py, ang) {
  const nx = -Math.sin(ang), ny = Math.cos(ang);
  const side = ([x, y]) => (x - px) * nx + (y - py) * ny;
  const a = [], b = [];
  for (let i = 0; i < pts.length; i++) {
    const p = pts[i], q = pts[(i + 1) % pts.length];
    const sp = side(p), sq = side(q);
    (sp >= 0 ? a : b).push(p);
    if ((sp >= 0) !== (sq >= 0)) {
      const t = sp / (sp - sq);
      const m = [p[0] + (q[0] - p[0]) * t, p[1] + (q[1] - p[1]) * t];
      a.push(m); b.push(m);
    }
  }
  return a.length >= 3 && b.length >= 3 ? [a, b] : null;
}

/** 区画を作る。いちばん大きい区画から順に分けるので、数が 1 つ増えても既存の分け方は変わらない */
function makeCells(seed, s) {
  const dyn = s.exclaim / 1000;
  const target = Math.round(lerp(5, 48, Math.pow(s.activity / 1000, 0.85)));
  let cells = [{ pts: [[0, 0], [1, 0], [1, 1], [0, 1]], path: "r" }];
  while (cells.length < target) {
    cells.sort((x, y) => area(y.pts) - area(x.pts));
    const c = cells.shift();
    const r = mulberry32(fnv1a(c.path) ^ seed);
    const [cx, cy] = centroid(c.pts);
    const off = lerp(0.15, 0.4, dyn);
    const xs = c.pts.map((p) => p[0]), ys = c.pts.map((p) => p[1]);
    const bw = Math.max(...xs) - Math.min(...xs), bh = Math.max(...ys) - Math.min(...ys);
    const px = cx + (r() - 0.5) * bw * off * 2, py = cy + (r() - 0.5) * bh * off * 2;
    // 落ち着いた人は縦横の分割、ダイナミックな人ほど斜めの分割
    const axis = bw > bh ? Math.PI / 2 : 0;
    const ang = axis + (r() < 0.25 ? Math.PI / 2 : 0) + (r() - 0.5) * Math.PI * lerp(0.08, 0.9, dyn);
    const parts = splitPoly(c.pts, px, py, ang);
    if (!parts) { cells.push({ ...c, path: c.path + "x" }); continue; }
    cells.push({ pts: parts[0], path: c.path + "0" }, { pts: parts[1], path: c.path + "1" });
  }
  return cells;
}

function drawPolygonArt(ctx, w, h, s, seed, time = 0) {
  const p = toDrawParams(s);
  const min = Math.min(w, h), ox = (w - min) / 2, oy = (h - min) / 2;
  const X = (x) => ox + x * min, Y = (y) => oy + y * min;
  const a = s.activity / 1000, dyn = p.dyn;

  // 背景
  const g = ctx.createLinearGradient(0, 0, 0, h);
  g.addColorStop(0, hsl(p.sky, 1, p.dark ? -3 : 2));
  g.addColorStop(1, hsl(p.sky, 1, p.dark ? 4 : -3));
  ctx.fillStyle = g; ctx.fillRect(0, 0, w, h);

  const margin = 0.06;
  const cells = makeCells(seed, s);
  const lw = Math.max(0.5, min / 600);
  const ink = p.dark ? [40, 15, 85] : [30, 10, 15];
  ctx.lineJoin = "round";

  for (const c of cells) {
    const r = mulberry32(fnv1a(c.path + "/draw") ^ seed);
    const emo = pickEmotion(p.mix, r());
    const color = COLOR[emo];
    const kind = r();                   // 区画の描き方
    const quiet = r() < 0.16;           // 何も描かない区画（息継ぎ）
    const dir = r() < 0.5 ? -1 : 1;
    const phase = r() * TAU;
    const rot0 = r() * TAU;
    const fillA = lerp(0.12, 0.55, r());
    // 区画を余白の内側に収め、少し内側に縮めて隙間を作る
    const pts = c.pts.map(([x, y]) => [margin + x * (1 - margin * 2), margin + y * (1 - margin * 2)]);
    const [cx, cy] = centroid(pts);
    const gap = lerp(0.9, 0.97, r());
    const cell = pts.map(([x, y]) => [cx + (x - cx) * gap, cy + (y - cy) * gap]);

    // 動き：感情の激しさで、ねじれと伸び縮みが揺れる
    const wobble = Math.sin(time * lerp(0.2, 1.4, ENERGY[emo]) + phase) * ENERGY[emo];
    const layers = Math.max(1, Math.round(lerp(2, 12, a) * lerp(0.6, 1.2, r())));
    const twist = dir * (lerp(0.02, 0.35, dyn) + wobble * 0.12);

    ctx.save();
    ctx.beginPath(); cell.forEach(([x, y], i) => (i ? ctx.lineTo(X(x), Y(y)) : ctx.moveTo(X(x), Y(y)))); ctx.closePath();
    ctx.strokeStyle = hsl(ink, 0.35); ctx.lineWidth = 0.6 * lw; ctx.stroke();
    if (quiet) { ctx.restore(); continue; }
    ctx.clip();

    if (kind < 0.5) {
      // 区画そのものを、重心に向かって縮めながらねじって重ねる
      for (let j = 0; j < layers; j++) {
        const t = j / layers, k = (1 - t * 0.92) * (1 + wobble * 0.03), ang = twist * j;
        const c2 = Math.cos(ang), s2 = Math.sin(ang);
        ctx.beginPath();
        cell.forEach(([x, y], i) => {
          const dx = (x - cx) * k, dy = (y - cy) * k;
          const qx = cx + dx * c2 - dy * s2, qy = cy + dx * s2 + dy * c2;
          i ? ctx.lineTo(X(qx), Y(qy)) : ctx.moveTo(X(qx), Y(qy));
        });
        ctx.closePath();
        if (j === 0) { ctx.fillStyle = hsl(color, fillA * 0.6); ctx.fill(); }
        ctx.strokeStyle = hsl(color, lerp(0.85, 0.35, t), p.dark ? 18 : 0); ctx.lineWidth = lw * (j === 0 ? 1.2 : 0.8); ctx.stroke();
      }
    } else {
      // 感情の正多角形を、区画の中に入れ子で描く
      const sides = SHAPE[emo];
      const inr = Math.min(...cell.map(([x, y], i) => {
        const [x2, y2] = cell[(i + 1) % cell.length];
        return Math.abs((x2 - x) * (y - cy) - (x - cx) * (y2 - y)) / Math.hypot(x2 - x, y2 - y);
      }));
      // ダイナミックな人ほど、区画からはみ出す大きな形が出る（はみ出た分は切り取られる）
      const R = inr * lerp(0.95, lerp(1.0, 1.9, dyn), r());
      for (let j = 0; j < layers; j++) {
        const t = j / layers, rr = R * (1 - t * 0.88) * (1 + wobble * 0.04);
        const rot = rot0 + twist * j * 1.5 + time * 0.05 * dir * ENERGY[emo];
        ctx.beginPath();
        if (sides === 0) ctx.arc(X(cx), Y(cy), rr * min, 0, TAU);
        else for (let i = 0; i <= sides; i++) {
          const an = rot + (i / sides) * TAU;
          const qx = cx + Math.cos(an) * rr, qy = cy + Math.sin(an) * rr;
          i ? ctx.lineTo(X(qx), Y(qy)) : ctx.moveTo(X(qx), Y(qy));
        }
        if (j === 0 || (j === layers - 1 && r() < 0.5)) { ctx.fillStyle = hsl(color, j === 0 ? fillA : 0.8); ctx.fill(); }
        ctx.strokeStyle = hsl(color, lerp(0.9, 0.4, t), p.dark ? 18 : -8); ctx.lineWidth = lw; ctx.stroke();
      }
    }
    ctx.restore();
  }
}

// =====================================================================
// 軌道バージョン：暗い空に、半透明の多角形が渦巻きの軌道に沿って散らばる
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

  // 渦巻きの中心と形（DID で決まる）
  const cx = w * lerp(0.4, 0.6, g0()), cy = h * lerp(0.4, 0.6, g0());
  const squash = lerp(0.75, 1, g0()), tilt = g0() * TAU;
  const arms = 1 + Math.round(dyn * 2 + g0() * 0.6);
  const turns = lerp(0.9, 1.6, g0());
  const spin = g0() < 0.5 ? -1 : 1;
  const orbitSpeed = spin * lerp(0.01, 0.06, p.energy);   // 公転の速さ
  const maxR = Math.hypot(w, h) * 0.55;

  /** 渦巻き上の位置。u は中心からの進み具合（0〜1）、off は軌道からのずれ */
  const spiral = (arm, u, off) => {
    const th = (arm / arms) * TAU + u * turns * TAU + time * orbitSpeed;
    const rr = lerp(0.06, 1, u) * maxR + off * min;
    const x0 = Math.cos(th) * rr, y0 = Math.sin(th) * rr * squash;
    return [cx + x0 * Math.cos(tilt) - y0 * Math.sin(tilt), cy + x0 * Math.sin(tilt) + y0 * Math.cos(tilt), th];
  };

  // --- 背景：空の色＋中心のぼんやりした明るさ
  const sky = nightSky(hourOf(s));
  ctx.fillStyle = hsl(sky); ctx.fillRect(0, 0, w, h);
  const glow = ctx.createRadialGradient(cx, cy, 0, cx, cy, maxR);
  glow.addColorStop(0, hsl([sky[0], sky[1], sky[2] + 10], 0.9));
  glow.addColorStop(1, hsl(sky, 0));
  ctx.fillStyle = glow; ctx.fillRect(0, 0, w, h);

  // --- ガイド線：中心を通る十字の点線と、薄い格子
  ctx.save();
  ctx.strokeStyle = hsl([195, 60, 70], 0.28); ctx.lineWidth = lw;
  ctx.setLineDash([1.5 * lw, 5 * lw]);
  ctx.beginPath(); ctx.moveTo(0, cy); ctx.lineTo(w, cy); ctx.moveTo(cx, 0); ctx.lineTo(cx, h); ctx.stroke();
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
  for (let k = 0; k < 2; k++) {
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
    const emo = pickEmotion(p.mix, r());
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
    shapes.push({ x, y, size, sides, warp, rot, emo, style, alpha, glowy, u });
  }

  // --- 光の線：中心から一部の多角形へ伸びる細い線
  const nRays = Math.round(lerp(4, MAX_RAYS, a));
  ctx.save(); ctx.lineWidth = 0.7 * lw;
  for (let i = 0; i < Math.min(nRays, shapes.length); i++) {
    const sh = shapes[(i * 7919) % shapes.length];
    const ox = cx + (g0() - 0.5) * min * 0.04, oy = cy + (g0() - 0.5) * min * 0.04;
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
    ctx.fillStyle = hsl(neon(pickEmotion(p.mix, r())), lerp(0.2, 0.8, r()) * (0.6 + 0.4 * tw));
    const sz = (r() < 0.9 ? 1 : 2) * lw;
    ctx.fillRect(x, y, sz, sz);
  }

  // --- 多角形：外側（大きい u）から描いて、中心側を手前にする
  shapes.sort((p1, p2) => p2.u - p1.u);
  for (const sh of shapes) {
    const col = neon(sh.emo);
    ctx.beginPath();
    if (sh.sides === 0) ctx.arc(sh.x, sh.y, sh.size * 0.8, 0, TAU);
    else for (let k = 0; k <= sh.sides; k++) {
      const an = sh.rot + (k / sh.sides) * TAU, rr = sh.size * sh.warp[k % sh.sides % 6];
      const px = sh.x + Math.cos(an) * rr, py = sh.y + Math.sin(an) * rr;
      k ? ctx.lineTo(px, py) : ctx.moveTo(px, py);
    }
    ctx.closePath();
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
}

function drawArt(ctx, w, h, s, seed, style, density = 1, time = 0) {
  if (style === "orbit") drawOrbitArt(ctx, w, h, s, seed, time);
  else if (style === "poly") drawPolygonArt(ctx, w, h, s, seed, time);
  else drawLinesFull(ctx, w, h, s, seed, density);
}


export default function draw(ctx, env) {
  const s = env.params;
  const seed = (s.seed >>> 0) || 1;
  drawArt(ctx, env.width, env.height, s, seed, s.style || "orbit", 1, env.time || 0);
}
