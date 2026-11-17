import { readFileSync } from "node:fs";
import { DatabaseSync } from "node:sqlite";
import { describe, expect, it } from "vitest";
import { createGalleryIndex } from "../gallery/index.ts";
import { createJobRepository } from "../jobs/repository.ts";
import { createUserRepository } from "../users.ts";
import { type D1Like, d1Sql } from "./d1.ts";
import { schemaSql, type SqlValue } from "./database.ts";

/** D1 と同じ API の偽物（中身は node:sqlite）。 */
function fakeD1(): D1Like {
  const db = new DatabaseSync(":memory:");
  db.exec(schemaSql());
  return {
    prepare(sql) {
      return {
        bind(...values: SqlValue[]) {
          const st = db.prepare(sql);
          return {
            async first<T>() {
              return (st.get(...values) as T | undefined) ?? null;
            },
            async all<T>() {
              return { results: st.all(...values) as T[] };
            },
            async run() {
              return { meta: { changes: Number(st.run(...values).changes) } };
            },
          };
        },
      };
    },
  };
}

describe("DB", () => {
  it("D1 のマイグレーションは schemaSql() と同じ内容", () => {
    const migration = readFileSync(new URL("../../migrations/0001_init.sql", import.meta.url), "utf8");
    expect(migration.slice(migration.indexOf("\n") + 1)).toBe(schemaSql());
  });

  it("D1 でも同じリポジトリが動く", async () => {
    const sql = d1Sql(fakeD1());
    const users = createUserRepository(sql);
    const jobs = createJobRepository(sql);
    const gallery = createGalleryIndex(sql);
    await users.touch("did:plc:a", { handle: "a.test" });
    await users.consent("did:plc:a");
    expect((await users.listRegistered()).map((u) => u.did)).toEqual(["did:plc:a"]);

    const job = await jobs.enqueueGenesis("did:plc:a", "3a");
    expect((await jobs.claimNext())?.id).toBe(job.id);
    expect(await jobs.claimNext()).toBeUndefined();
    expect(await jobs.retry(job.id)).toBe(false); // failed ではないので戻せない（changes を正しく返す）
    expect(await gallery.get("at://nothing")).toBeUndefined();
  });
});
