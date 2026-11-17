import { describe, expect, it } from "vitest";
import { openDatabase } from "../db/database.ts";
import { createRequestLock } from "./oauth.ts";

describe("トークン更新のロック", () => {
  it("同じキーの処理は、別のインスタンスからでも 1 つずつ実行される", async () => {
    const db = openDatabase(":memory:");
    // Workers の別インスタンスに見立てて、ロック関数を 2 つ作る（同じ DB を使う）
    const a = createRequestLock(db);
    const b = createRequestLock(db);
    const log: string[] = [];
    const task = (name: string) => async () => {
      log.push(`${name}:start`);
      await new Promise((r) => setTimeout(r, 30));
      log.push(`${name}:end`);
      return name;
    };
    const results = await Promise.all([a("did:plc:x", task("a")), b("did:plc:x", task("b")), a("did:plc:y", task("y"))]);
    expect(results).toEqual(["a", "b", "y"]);
    const x = log.filter((l) => !l.startsWith("y"));
    expect(x).toEqual([`${x[0]!.split(":")[0]}:start`, `${x[0]!.split(":")[0]}:end`, `${x[2]!.split(":")[0]}:start`, `${x[2]!.split(":")[0]}:end`]);
    expect(db.raw.prepare("SELECT COUNT(*) AS n FROM kv WHERE key LIKE 'lock:%'").get()).toEqual({ n: 0 }); // 終わったら印は消える
  });

  it("期限の切れた印は無視して取れる（途中で落ちたインスタンスの印）", async () => {
    const db = openDatabase(":memory:");
    db.raw.prepare("INSERT INTO kv (key, value) VALUES ('lock:did:plc:x', ?)").run(`${Date.now() - 1}|dead`);
    expect(await createRequestLock(db)("did:plc:x", async () => "ok")).toBe("ok");
  });

  it("処理が失敗しても印は消える", async () => {
    const db = openDatabase(":memory:");
    const lock = createRequestLock(db);
    await expect(lock("k", async () => Promise.reject(new Error("x")))).rejects.toThrow("x");
    expect(await lock("k", async () => "ok")).toBe("ok");
  });
});
