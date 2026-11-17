import assert from "node:assert/strict";
import { readFileSync } from "node:fs";
import { test } from "node:test";
import source from "./draw-source.js";

test("draw-source.js は draw.js と同じ内容", () => {
  assert.equal(source, readFileSync(new URL("./draw.js", import.meta.url), "utf8"));
});
