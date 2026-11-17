import assert from "node:assert/strict";
import { test } from "node:test";
import { analyzePost, estimateGenesis, evolveState } from "./estimate.js";

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
