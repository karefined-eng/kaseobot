CREATE TABLE IF NOT EXISTS audit_snapshots (
  snapshot_id TEXT PRIMARY KEY,
  telegram_user_id TEXT NOT NULL,
  url TEXT NOT NULL,
  type TEXT NOT NULL CHECK (type IN ('seo_audit', 'geo_audit')),
  overall_score INTEGER,
  normalized_result TEXT NOT NULL,
  created_at TEXT NOT NULL
);

CREATE INDEX IF NOT EXISTS idx_audit_snapshots_url_created
  ON audit_snapshots (telegram_user_id, url, created_at DESC);
