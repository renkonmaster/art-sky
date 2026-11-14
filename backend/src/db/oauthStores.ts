/**
 * OAuth クライアントの state と session を SQLite に保存する。
 * 再起動してもログインが切れないようにする（skymood ではメモリ上だった）。
 */
import type { NodeSavedSession, NodeSavedState } from "@atproto/oauth-client-node";
import { nowIso, type Database } from "./database.ts";

interface SimpleStore<V> {
  get(key: string): Promise<V | undefined>;
  set(key: string, value: V): Promise<void>;
  del(key: string): Promise<void>;
}

function sqliteStore<V>(db: Database, table: "oauth_states" | "oauth_sessions", timeColumn: string): SimpleStore<V> {
  const get = db.prepare(`SELECT value FROM ${table} WHERE key = ?`);
  const set = db.prepare(
    `INSERT INTO ${table} (key, value, ${timeColumn}) VALUES (?, ?, ?)
     ON CONFLICT (key) DO UPDATE SET value = excluded.value, ${timeColumn} = excluded.${timeColumn}`,
  );
  const del = db.prepare(`DELETE FROM ${table} WHERE key = ?`);
  return {
    async get(key) {
      const row = get.get(key) as { value: string } | undefined;
      return row ? (JSON.parse(row.value) as V) : undefined;
    },
    async set(key, value) {
      set.run(key, JSON.stringify(value), nowIso());
    },
    async del(key) {
      del.run(key);
    },
  };
}

export function createOAuthStores(db: Database) {
  // 認可の途中で放置された state は 1 時間で消す
  db.prepare("DELETE FROM oauth_states WHERE created_at < ?").run(new Date(Date.now() - 3_600_000).toISOString());
  return {
    stateStore: sqliteStore<NodeSavedState>(db, "oauth_states", "created_at"),
    sessionStore: sqliteStore<NodeSavedSession>(db, "oauth_sessions", "updated_at"),
  };
}
