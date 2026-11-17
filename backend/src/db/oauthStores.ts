/**
 * OAuth クライアントの state と session を DB に保存する。
 * 再起動してもログインが切れないようにする（skymood ではメモリ上だった）。
 *
 * DPoP の鍵は JWK（JSON）にして保存する。形式は @atproto/oauth-client-node の
 * NodeSavedSession / NodeSavedState と同じなので、以前に保存したログイン情報もそのまま使える。
 */
import { JoseKey } from "@atproto/jwk-jose";
import type { InternalStateData, Session, SessionStore, StateStore } from "@atproto/oauth-client";
import { nowIso, type Sql } from "./database.ts";

type Saved<T extends { dpopKey: unknown }> = Omit<T, "dpopKey"> & { dpopJwk: Record<string, unknown> };

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

/** Key を持つ値と、JWK（JSON）を持つ保存形式を相互に変換する。 */
function withDpopJwk<T extends { dpopKey: { privateJwk?: unknown } }>(store: SimpleStore<Saved<T>>): SimpleStore<T> {
  return {
    async get(key) {
      const saved = await store.get(key);
      if (!saved) return undefined;
      const { dpopJwk, ...data } = saved;
      return { ...data, dpopKey: await JoseKey.fromJWK(dpopJwk) } as unknown as T;
    },
    async set(key, { dpopKey, ...data }) {
      if (!dpopKey.privateJwk) throw new Error("DPoP の秘密鍵（JWK）がありません");
      await store.set(key, { ...data, dpopJwk: dpopKey.privateJwk } as unknown as Saved<T>);
    },
    del: (key) => store.del(key),
  };
}

export function createOAuthStores(db: Sql): { stateStore: StateStore; sessionStore: SessionStore } {
  // 認可の途中で放置された state は 1 時間で消す
  void db.run("DELETE FROM oauth_states WHERE created_at < ?", new Date(Date.now() - 3_600_000).toISOString());
  return {
    stateStore: withDpopJwk<InternalStateData>(sqliteStore(db, "oauth_states", "created_at")),
    sessionStore: withDpopJwk<Session>(sqliteStore(db, "oauth_sessions", "updated_at")),
  };
}
