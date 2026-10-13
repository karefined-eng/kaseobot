CREATE TABLE IF NOT EXISTS audits (
  audit_id TEXT PRIMARY KEY,
  job_id TEXT NOT NULL UNIQUE,
  telegram_user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('seo_audit', 'geo_audit')),
  overall_score INTEGER,
  normalized_result TEXT NOT NULL,
  raw_result TEXT NOT NULL,
  created_at TEXT NOT NULL,
  expires_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audits_user_created
  ON audits (telegram_user_id, created_at DESC);

CREATE INDEX IF NOT EXISTS idx_audits_expires_at
  ON audits (expires_at);
