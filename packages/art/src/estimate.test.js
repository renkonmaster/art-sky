import assert from "node:assert/strict";
import { test } from "node:test";
import { RECENT_MAX, STYLE_RULE, analyzePost, chooseStyle, estimateGenesis, evolveState } from "./estimate.js";

const hasFloat = (v) => JSON.stringify(v, (_k, x) => (typeof x === "number" && !Number.isInteger(x) ? "FLOAT" : x)).includes("FLOAT");

test("日本語：否定は反対側に数える", () => {
  assert.ok(analyzePost("最高だった").scores.joy > 0);
  const neg = analyzePost("全然嬉しくない");
  assert.equal(neg.scores.joy, 0);
  assert.ok(neg.scores.sadness > 0);
});

test("英語：言語を判定して英語の辞書で読む", () => {
  const a = analyzePost("I am not happy about this");
  assert.deepEqual(a.langs, ["en"]);
  assert.ok(a.scores.sadness > 0 && a.scores.joy === 0);
});

test("他の言語は絵文字だけで読む", () => {
  const a = analyzePost("Me encanta este día 😊", ["es"]);
  assert.deepEqual(a.langs, []);
  assert.ok(a.scores.joy > 0);
});

test("genesis と evolution の状態は整数だけで、画風は変わらない", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const posts = Array.from({ length: 30 }, (_, i) => ({ text: i % 2 ? "のんびり☕" : "懐かしい", createdAt: new Date(now - i * 3600e3 * 6).toISOString() }));
  const { state } = estimateGenesis(posts);
  assert.equal(hasFloat(state), false);
  assert.equal(Object.values(state.mix).reduce((a, b) => a + b, 0), 1000);
  const next = evolveState(state, { text: "最高！！🎉", createdAt: new Date(now + 3600e3).toISOString() });
  assert.equal(hasFloat(next), false);
  assert.equal(next.style, state.style);
  assert.ok(next.mix.joy > state.mix.joy);
});

test("画風の決め方が古い作品は、次の投稿で 1 回だけ決め直す", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const posts = Array.from({ length: 30 }, (_, i) => ({ text: i % 3 ? "ラーメン食べた！" : "仕事おわり", createdAt: new Date(now - i * 3600e3 * 12).toISOString() }));
  const { state } = estimateGenesis(posts);
  assert.equal(state.styleRule, STYLE_RULE);
  // 以前の決め方で orbit になった作品（styleRule がない）
  const old = { ...state, style: "orbit" };
  delete old.styleRule;
  const post = { text: "散歩してきた", createdAt: new Date(now + 3600e3).toISOString() };
  const next = evolveState(old, post);
  assert.equal(next.style, chooseStyle(state.base));
  assert.equal(next.styleRule, STYLE_RULE);
  // 決め直したあとは変わらない
  assert.equal(evolveState({ ...next, style: "orbit" }, post).style, "orbit");
});

test("「!」を含む投稿が 6% 以上なら、感情の言葉が少なくても線の画風になる", () => {
  const mix = { joy: 100, calm: 50, excitement: 50, nostalgia: 0, sadness: 50, anxiety: 50, anger: 0, neutral: 650 };
  assert.equal(chooseStyle({ mix, activity: 250, exclaim: 60 }), "lines");
  assert.equal(chooseStyle({ mix, activity: 250, exclaim: 59 }), "orbit");
});

test("投稿の跡は新しい順に最大 30 件残り、感情と「!」が読める", () => {
  const now = Date.parse("2026-11-17T12:00:00Z");
  const posts = Array.from({ length: 40 }, (_, i) => ({ text: `散歩${i}`, createdAt: new Date(now - i * 3600e3).toISOString() }));
  const { state } = estimateGenesis(posts);
  assert.equal(state.recent.length, RECENT_MAX);
  const next = evolveState(state, { text: "最高！！🎉", createdAt: new Date(now + 3600e3).toISOString() });
  assert.equal(next.recent.length, RECENT_MAX);
  assert.equal(next.recent[1], state.recent[0]);
  const t = next.recent[0];
  assert.equal(t & 7, 0); // joy
  assert.equal((t >> 5) & 1, 1); // 「!」あり
  assert.ok(Number.isInteger(t) && t >= 0 && t < 2 ** 24);
  // 跡のない古い作品からでも続けられる
  const old = { ...state };
  delete old.recent;
  assert.equal(evolveState(old, { text: "雨", createdAt: new Date(now + 7200e3).toISOString() }).recent.length, 1);
});

test("区画（poly）の画風は選ばれない。古い poly の作品は次の投稿で決め直す", () => {
  const calm = { joy: 0, calm: 600, excitement: 0, nostalgia: 0, sadness: 100, anxiety: 0, anger: 0, neutral: 300 };
  assert.equal(chooseStyle({ mix: calm, activity: 100, exclaim: 0 }), "orbit");
  const now = Date.parse("2026-11-17T12:00:00Z");
  const { state } = estimateGenesis([{ text: "のんびり", createdAt: new Date(now).toISOString() }]);
  const next = evolveState({ ...state, style: "poly", styleRule: 2 }, { text: "雨", createdAt: new Date(now + 3600e3).toISOString() });
  assert.notEqual(next.style, "poly");
});
