/**
 * サービス側の DB（Plan.md 7.2）。作品の正本は本人の PDS にあり、
 * ここには参加者・ジョブ・認証の維持に必要な情報だけを置く。
 *
 * リポジトリは Sql（非同期の get / all / run）だけを使う。
 *   - Node.js：node:sqlite を包んだもの（openDatabase）
 *   - Cloudflare Workers：D1 を包んだもの（d1.ts）
 * どちらも SQLite なので、SQL は同じものを使う。
 */
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  did                TEXT PRIMARY KEY,
  handle             TEXT NOT NULL,
  -- 推定結果の公開に同意した日時。NULL なら未登録
  consented_at       TEXT,
  generation_enabled INTEGER NOT NULL DEFAULT 1,
  listed             INTEGER NOT NULL DEFAULT 1,
  created_at         TEXT NOT NULL,
  updated_at         TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS jobs (
  id          INTEGER PRIMARY KEY AUTOINCREMENT,
  did         TEXT NOT NULL,
  kind        TEXT NOT NULL CHECK (kind IN ('genesis', 'evolution')),
  -- 同じきっかけのジョブを 1 つにする。evolution は元投稿の URI、genesis は 'genesis:<did>'
  dedupe_key  TEXT NOT NULL UNIQUE,
  trigger_uri TEXT,
  -- 作品のレコードキー。evolution は元投稿と同じ、genesis は登録時に発行した TID
  rkey        TEXT NOT NULL,
  status      TEXT NOT NULL CHECK (status IN ('queued', 'generating', 'validating', 'saving', 'done', 'failed')),
  attempts    INTEGER NOT NULL DEFAULT 0,
  error       TEXT,
  artwork_uri TEXT,
  artwork_cid TEXT,
  created_at  TEXT NOT NULL,
  updated_at  TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS jobs_did ON jobs (did, id);
CREATE INDEX IF NOT EXISTS jobs_status ON jobs (status, id);

-- ギャラリー用の索引。作品の正本は本人の PDS にあり、ここはその写し（PDS から作り直せる）。
CREATE TABLE IF NOT EXISTS artworks (
  uri        TEXT PRIMARY KEY,
  did        TEXT NOT NULL,
  rkey       TEXT NOT NULL,
  cid        TEXT NOT NULL,
  -- com.example.artsky.artwork のレコード（JSON）
  record     TEXT NOT NULL,
  created_at TEXT NOT NULL,
  indexed_at TEXT NOT NULL
);
CREATE INDEX IF NOT EXISTS artworks_did ON artworks (did, rkey);

-- 小さな設定値の置き場（Jetstream のカーソルなど）
CREATE TABLE IF NOT EXISTS kv (
  key   TEXT PRIMARY KEY,
  value TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_states (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE TABLE IF NOT EXISTS oauth_sessions (
  key        TEXT PRIMARY KEY,
  value      TEXT NOT NULL,
  updated_at TEXT NOT NULL
);
`;

/** 後から足した列。既存の DB にも追加する。 */
const ADDED_COLUMNS: ReadonlyArray<[table: string, column: string, definition: string]> = [
  ["users", "display_name", "TEXT"],
  ["users", "avatar", "TEXT"],
  // evolution のきっかけになった投稿の CID
  ["jobs", "trigger_cid", "TEXT"],
  // 失敗の種類（docs/api.md の JobErrorCode）
  ["jobs", "error_code", "TEXT"],
];

/** SQL の実行。D1 の API に合わせて非同期にしている。 */
export interface Sql {
  get<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T | undefined>;
  all<T = Record<string, unknown>>(sql: string, ...params: SqlValue[]): Promise<T[]>;
  run(sql: string, ...params: SqlValue[]): Promise<{ changes: number }>;
}
export type SqlValue = string | number | null;

/** Node.js の SQLite。Sql に加えて、同期で直接触れる raw と close を持つ（テストやスクリプト用）。 */
export interface Database extends Sql {
  raw: DatabaseSync;
  close(): void;
}

/** 全体のスキーマ。D1 のマイグレーション（migrations/）はこれと同じ内容にする。 */
export function schemaSql(): string {
  const added = ADDED_COLUMNS.map(([table, column, definition]) => `ALTER TABLE ${table} ADD COLUMN ${column} ${definition};`);
  return `${SCHEMA.trim()}\n\n${added.join("\n")}\n`;
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

export const nowIso = (): string => new Date().toISOString();

/** Jetstream のカーソル（最後に処理したイベントの時刻）の保存先。kv テーブルに置く。 */
export function cursorStore(db: Sql) {
  return {
    async loadCursor(): Promise<number | undefined> {
      const row = await db.get<{ value: string }>("SELECT value FROM kv WHERE key = 'jetstream_cursor'");
      return row ? Number(row.value) : undefined;
    },
    async saveCursor(cursor: number): Promise<void> {
      await db.run(
        "INSERT INTO kv (key, value) VALUES ('jetstream_cursor', ?) ON CONFLICT (key) DO UPDATE SET value = excluded.value",
        String(cursor),
      );
    },
  };
}
