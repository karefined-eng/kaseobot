CREATE TABLE IF NOT EXISTS users (
  telegram_user_id TEXT PRIMARY KEY,
  created_at TEXT NOT NULL,
  history_enabled INTEGER NOT NULL DEFAULT 1
);

CREATE TABLE IF NOT EXISTS jobs (
  job_id TEXT PRIMARY KEY,
  audit_id TEXT NOT NULL,
  telegram_user_id TEXT NOT NULL,
  chat_id TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('seo_audit', 'geo_audit')),
  url TEXT NOT NULL,
  status TEXT NOT NULL CHECK (
    status IN ('queued', 'running', 'completed', 'failed', 'canceled', 'cancel_requested')
  ),
  created_at TEXT NOT NULL,
  started_at TEXT,
  completed_at TEXT,
  error TEXT,
  result_summary_message_id TEXT,
  source_update_id TEXT UNIQUE
);

CREATE INDEX IF NOT EXISTS idx_jobs_user_status
  ON jobs (telegram_user_id, status);

CREATE INDEX IF NOT EXISTS idx_jobs_user_created
  ON jobs (telegram_user_id, created_at DESC);
