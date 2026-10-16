CREATE TABLE IF NOT EXISTS user_state (
  telegram_user_id TEXT PRIMARY KEY,
  state TEXT NOT NULL,
  updated_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_user_state_updated
  ON user_state (updated_at);
