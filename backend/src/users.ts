/** 参加者と設定（Plan.md 7.2、docs/api.md の /api/me と /api/settings）。 */
import { nowIso, type Database } from "./db/database.ts";

export interface User {
  did: string;
  handle: string;
  displayName: string | null;
  avatar: string | null;
  /** 外部 AI への送信と推定結果の公開に同意した日時。null なら未登録。 */
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

export function createUserRepository(db: Database) {
  const get = db.prepare("SELECT * FROM users WHERE did = ?");
  const byHandle = db.prepare("SELECT * FROM users WHERE handle = ? COLLATE NOCASE");
  const upsert = db.prepare(
    `INSERT INTO users (did, handle, display_name, avatar, created_at, updated_at) VALUES (?, ?, ?, ?, ?, ?)
     ON CONFLICT (did) DO UPDATE SET handle = excluded.handle, display_name = excluded.display_name,
       avatar = excluded.avatar, updated_at = excluded.updated_at`,
  );
  const consent = db.prepare("UPDATE users SET consented_at = COALESCE(consented_at, ?), updated_at = ? WHERE did = ?");
  const settings = db.prepare("UPDATE users SET generation_enabled = ?, listed = ?, updated_at = ? WHERE did = ?");
  const registered = db.prepare("SELECT * FROM users WHERE consented_at IS NOT NULL ORDER BY did");

  return {
    get(did: string): User | undefined {
      const row = get.get(did) as UserRow | undefined;
      return row ? toUser(row) : undefined;
    },
    /** DID かハンドル名で探す。 */
    find(actor: string): User | undefined {
      if (actor.startsWith("did:")) return this.get(actor);
      const row = byHandle.get(actor.replace(/^@/, "")) as UserRow | undefined;
      return row ? toUser(row) : undefined;
    },
    /** ログインのたびに呼ぶ。ハンドル名や表示名が変わっていれば更新する（識別は DID）。 */
    touch(did: string, profile: ProfileInfo): User {
      const now = nowIso();
      upsert.run(did, profile.handle, profile.displayName ?? null, profile.avatar ?? null, now, now);
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
    /** 初回登録を済ませた人すべて。投稿の監視の対象になる。 */
    listRegistered(): User[] {
      return (registered.all() as unknown as UserRow[]).map(toUser);
    },
  };
}

export type UserRepository = ReturnType<typeof createUserRepository>;
