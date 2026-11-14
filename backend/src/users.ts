/** 参加者と設定（Plan.md 7.2、docs/roles.md の /api/me と /api/settings）。 */
import { nowIso, type Database } from "./db/database.ts";

export interface User {
  did: string;
  handle: string;
  consentedAt: string | null;
  generationEnabled: boolean;
  listed: boolean;
}

export interface Settings {
  generationEnabled: boolean;
  listed: boolean;
}

interface UserRow {
  did: string;
  handle: string;
  consented_at: string | null;
  generation_enabled: number;
  listed: number;
}

const toUser = (r: UserRow): User => ({
  did: r.did,
  handle: r.handle,
  consentedAt: r.consented_at,
  generationEnabled: r.generation_enabled === 1,
  listed: r.listed === 1,
});

export function createUserRepository(db: Database) {
  const get = db.prepare("SELECT * FROM users WHERE did = ?");
  const upsert = db.prepare(
    `INSERT INTO users (did, handle, created_at, updated_at) VALUES (?, ?, ?, ?)
     ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, updated_at = excluded.updated_at`,
  );
  const consent = db.prepare("UPDATE users SET consented_at = COALESCE(consented_at, ?), updated_at = ? WHERE did = ?");
  const settings = db.prepare("UPDATE users SET generation_enabled = ?, listed = ?, updated_at = ? WHERE did = ?");

  return {
    get(did: string): User | undefined {
      const row = get.get(did) as UserRow | undefined;
      return row ? toUser(row) : undefined;
    },
    /** ログインのたびに呼ぶ。ハンドル名が変わっていれば更新する（識別は DID）。 */
    touch(did: string, handle: string): User {
      const now = nowIso();
      upsert.run(did, handle, now, now);
      return this.get(did)!;
    },
    consent(did: string): User {
      const now = nowIso();
      consent.run(now, now, did);
      return this.get(did)!;
    },
    updateSettings(did: string, s: Settings): User {
      settings.run(s.generationEnabled ? 1 : 0, s.listed ? 1 : 0, nowIso(), did);
      return this.get(did)!;
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
