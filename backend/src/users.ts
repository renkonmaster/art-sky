/** 参加者と設定（Plan.md 7.2、docs/api.md の /api/me と /api/settings）。 */
import { nowIso, type Sql } from "./db/database.ts";

export interface User {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
  /** 推定結果の公開に同意した日時。null なら未登録。 */
  consentedAt: string | null;
  generationEnabled: boolean;
  listed: boolean;
}

export interface Settings {
  generationEnabled: boolean;
  listed: boolean;
}

/** ログイン時に公開プロフィールから取る表示用の情報。 */
export interface ProfileInfo {
  handle: string;
  displayName?: string | undefined;
  avatar?: string | undefined;
}

interface UserRow {
  did: string;
  handle: string;
  display_name: string | null;
  avatar: string | null;
  consented_at: string | null;
  generation_enabled: number;
  listed: number;
}

const toUser = (r: UserRow): User => ({
  did: r.did,
  handle: r.handle,
  displayName: r.display_name,
  avatar: r.avatar,
  consentedAt: r.consented_at,
  generationEnabled: r.generation_enabled === 1,
  listed: r.listed === 1,
});

export function createUserRepository(db: Sql) {
  return {
    async get(did: string): Promise<User | undefined> {
      const row = await db.get<UserRow>("SELECT * FROM users WHERE did = ?", did);
      return row ? toUser(row) : undefined;
    },
    /** DID かハンドル名で探す。 */
    async find(actor: string): Promise<User | undefined> {
      if (actor.startsWith("did:")) return this.get(actor);
      const row = await db.get<UserRow>("SELECT * FROM users WHERE handle = ? COLLATE NOCASE", actor.replace(/^@/, ""));
      return row ? toUser(row) : undefined;
    },
    /** ログインのたびに呼ぶ。ハンドル名や表示名が変わっていれば更新する（識別は DID）。 */
    async touch(did: string, profile: ProfileInfo): Promise<User> {
      const now = nowIso();
      await db.run(
        `INSERT INTO users (did, handle, display_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
         ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
           avatar = excluded.avatar, updated_at = excluded.updated_at`,
        did,
        profile.handle,
        profile.displayName ?? null,
        profile.avatar ?? null,
        now,
        now,
      );
      return (await this.get(did))!;
    },
    async consent(did: string): Promise<User> {
      const now = nowIso();
      await db.run("UPDATE users SET consented_at = COALESCE(consented_at, ?), updated_at = ? WHERE did = ?", now, now, did);
      return (await this.get(did))!;
    },
    async updateSettings(did: string, s: Settings): Promise<User> {
      await db.run(
        "UPDATE users SET generation_enabled = ?, listed = ?, updated_at = ? WHERE did = ?",
        s.generationEnabled ? 1 : 0,
        s.listed ? 1 : 0,
        nowIso(),
        did,
      );
      return (await this.get(did))!;
    },
    /** 初回登録を済ませた人すべて。投稿の監視の対象になる。 */
    async listRegistered(): Promise<User[]> {
      return (await db.all<UserRow>("SELECT * FROM users WHERE consented_at IS NOT NULL ORDER BY did")).map(toUser);
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
