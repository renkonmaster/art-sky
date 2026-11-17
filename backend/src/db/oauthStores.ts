/**
 * OAuth クライアントの state と session を SQLite に保存する。
 * 再起動してもログインが切れないようにする（skymood ではメモリ上だった）。
 */
import type { NodeSavedSession, NodeSavedState } from "@atproto/oauth-client-node";
import { nowIso, type Sql } from "./database.ts";

interface SimpleStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  del(key: string): Promise<void>;
}

function sqliteStore<V>(db: Sql, table: "oauth_states" | "oauth_sessions", timeColumn: string): SimpleStore<V> {
  return {
    async get(key) {
      const row = await db.get<{ value: string }>(`SELECT value FROM ${table} WHERE key = ?`, key);
      return row ? (JSON.parse(row.value) as V) : undefined;
    },
    async set(key, value) {
      await db.run(
        `INSERT INTO ${table} (key, value, ${timeColumn}) VALUES (?, ?, ?)
         ON CONFLICT (key) DO UPDATE SET value = excluded.value, ${timeColumn} = excluded.${timeColumn}`,
        key,
        JSON.stringify(value),
        nowIso(),
      );
    },
    async del(key) {
      await db.run(`DELETE FROM ${table} WHERE key = ?`, key);
    },
  };
}

export function createOAuthStores(db: Sql) {
  // 認可の途中で放置された state は 1 時間で消す
  void db.run("DELETE FROM oauth_states WHERE created_at < ?", new Date(Date.now() - 3_600_000).toISOString());
  return {
    stateStore: sqliteStore<NodeSavedState>(db, "oauth_states", "created_at"),
    sessionStore: sqliteStore<NodeSavedSession>(db, "oauth_sessions", "updated_at"),
  };
}
