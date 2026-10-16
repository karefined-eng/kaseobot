CREATE TABLE IF NOT EXISTS watched_urls (
  watch_id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  active INTEGER NOT NULL DEFAULT 1,
  created_at TEXT NOT NULL,
  last_checked_at TEXT
);

CREATE INDEX IF NOT EXISTS idx_watched_urls_user_active
  ON watched_urls (telegram_user_id, active);

CREATE INDEX IF NOT EXISTS idx_watched_urls_active
  ON watched_urls (active);
