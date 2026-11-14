/**
 * サービス側の DB（Plan.md 7.2）。Node.js 標準の node:sqlite を使う。
 * 作品の正本は本人の PDS にあり、ここには参加者・ジョブ・認証の維持に必要な情報だけを置く。
 */
import { DatabaseSync } from "node:sqlite";

const SCHEMA = `
CREATE TABLE IF NOT EXISTS users (
  did                TEXT PRIMARY KEY,
  handle             TEXT NOT NULL,
  -- 外部 AI への送信と、推定結果の公開に同意した日時。NULL なら未登録
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

export type Database = DatabaseSync;

/** path に ":memory:" を渡すとメモリ上の DB になる（テスト用）。 */
export function openDatabase(path: string): Database {
  const db = new DatabaseSync(path);
  db.exec("PRAGMA journal_mode = WAL; PRAGMA foreign_keys = ON; PRAGMA busy_timeout = 5000;");
  db.exec(SCHEMA);
  return db;
}

export const nowIso = (): string => new Date().toISOString();
