-- D1 の初期スキーマ。src/db/database.ts の schemaSql() から作る（database.test.ts で一致を確かめる）。
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

ALTER TABLE users ADD COLUMN display_name TEXT;
ALTER TABLE users ADD COLUMN avatar TEXT;
ALTER TABLE jobs ADD COLUMN trigger_cid TEXT;
ALTER TABLE jobs ADD COLUMN error_code TEXT;
