/**
 * サービス側の DB（Plan.md 7.2）。作品の正本は本人の PDS にあり、
 * ここには参加者・ジョブ・認証の維持に必要な情報だけを置く。
 *
 * リポジトリは Sql（非同期の get / all / run、sql.ts）だけを使う。
 *   - Node.js：node:sqlite を包んだもの（このファイルの openDatabase）
 *   - Cloudflare Workers：D1 を包んだもの（d1.ts）
 * どちらも SQLite なので、SQL は同じものを使う。
 */
import { DatabaseSync } from "node:sqlite";
import { ADDED_COLUMNS, SCHEMA, type Sql, type SqlValue } from "./sql.ts";

export { cursorStore, nowIso, schemaSql, type Sql, type SqlValue } from "./sql.ts";

/** Node.js の SQLite。Sql に加えて、同期で直接触れる raw と close を持つ（テストやスクリプト用）。 */
export interface Database extends Sql {
  raw: DatabaseSync;
  close(): void;
}

/** path に ":memory:" を渡すとメモリ上の DB になる（テスト用）。 */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  for (const [table, column, definition] of ADDED_COLUMNS) {
    const columns = db.prepare(`PRAGMA table_info(${table})`).all() as Array<{ name: string }>;
    if (!columns.some((c) => c.name === column)) db.exec(`ALTER TABLE ${table} ADD COLUMN ${column} ${definition}`);
  }
  const cache = new Map<string, ReturnType<DatabaseSync["prepare"]>>();
  const stmt = (sql: string) => {
    let st = cache.get(sql);
    if (!st) cache.set(sql, (st = db.prepare(sql)));
    return st;
  };
  return {
    raw: db,
    close: () => db.close(),
    async get<T>(sql: string, ...params: SqlValue[]) {
      return stmt(sql).get(...params) as T | undefined;
    },
    async all<T>(sql: string, ...params: SqlValue[]) {
      return stmt(sql).all(...params) as T[];
    },
    async run(sql: string, ...params: SqlValue[]) {
      return { changes: Number(stmt(sql).run(...params).changes) };
    },
  };
}
