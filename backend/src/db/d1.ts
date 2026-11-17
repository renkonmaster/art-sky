/**
 * Cloudflare D1 を Sql の形で使う（Workers 用）。D1 も SQLite なので、SQL はそのまま使える。
 * 型は @cloudflare/workers-types に頼らず、使う部分だけを書く。
 */
import type { Sql, SqlValue } from "./sql.ts";

export interface D1Like {
  prepare(sql: string): {
    bind(...values: SqlValue[]): {
      first<T>(): Promise<T | null>;
      all<T>(): Promise<{ results: T[] }>;
      run(): Promise<{ meta: { changes?: number } }>;
    };
  };
}

export function d1Sql(db: D1Like): Sql {
  return {
    async get<T>(sql: string, ...params: SqlValue[]) {
      return (await db.prepare(sql).bind(...params).first<T>()) ?? undefined;
    },
    async all<T>(sql: string, ...params: SqlValue[]) {
      return (await db.prepare(sql).bind(...params).all<T>()).results;
    },
    async run(sql: string, ...params: SqlValue[]) {
      return { changes: (await db.prepare(sql).bind(...params).run()).meta.changes ?? 0 };
    },
  };
}
