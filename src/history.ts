import type { D1DatabaseLike, D1ResultLike, JobType, JobStatus } from "./jobs";

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;
// When history is off, terminal records that slip past the immediate
// post-delivery purge (for example a failed enqueue) are removed by the daily
// cleanup after this grace period. It also lets a user retry a failed audit
// once before the record disappears.
const OPTED_OUT_GRACE_MS = 24 * 60 * 60 * 1000;

export interface UserHistoryItem {
  job_id: string;
  url: string;
  type: JobType;
  status: JobStatus;
  created_at: string;
  overall_score: number | null;
}

function assertBatch(results: D1ResultLike[]): void {
  for (const result of results) {
    if (result.success === false) throw new Error(result.error ?? "D1 history operation failed.");
  }
}

function changeCount(result: D1ResultLike | undefined): number {
  if (!result) return 0;
  if (result.success === false) throw new Error(result.error ?? "D1 history operation failed.");
  return result.meta?.changes ?? 0;
}

// History preference: true means the default 30-day retention, false means the
// user opted out of retention. A missing row counts as enabled so new users
// get the standard behavior.
export async function getHistoryPreference(
  db: D1DatabaseLike,
  telegramUserId: string,
): Promise<boolean> {
  const row = await db.prepare(`SELECT history_enabled FROM users WHERE telegram_user_id = ?`)
    .bind(telegramUserId)
    .first<{ history_enabled: number }>();
  return row === null || row.history_enabled !== 0;
}

export async function setHistoryPreference(
  db: D1DatabaseLike,
  telegramUserId: string,
  enabled: boolean,
): Promise<void> {
  const result = await db.prepare(`INSERT INTO users (telegram_user_id, created_at, history_enabled)
    VALUES (?, ?, ?)
    ON CONFLICT(telegram_user_id) DO UPDATE SET history_enabled = excluded.history_enabled`)
    .bind(telegramUserId, new Date().toISOString(), enabled ? 1 : 0)
    .run();
  if (result.success === false) {
    throw new Error(result.error ?? "Could not save the history preference.");
  }
}

export async function ensureUser(
  db: D1DatabaseLike,
  telegramUserId: string,
): Promise<void> {
  const result = await db.prepare(
    `INSERT OR IGNORE INTO users (telegram_user_id, created_at, history_enabled)
     VALUES (?, ?, 1)`,
  )
    .bind(telegramUserId, new Date().toISOString())
    .run();
  if (result.success === false) {
    throw new Error(result.error ?? "Could not ensure user record.");
  }
}

export async function getUserHistory(
  db: D1DatabaseLike,
  telegramUserId: string,
  now = Date.now(),
): Promise<UserHistoryItem[]> {
  const cutoff = new Date(now - HISTORY_RETENTION_MS).toISOString();
  const nowIso = new Date(now).toISOString();
  const result = await db.prepare(`SELECT
      j.job_id, j.url, j.type, j.status, j.created_at, a.overall_score
    FROM jobs j
    LEFT JOIN audits a ON a.job_id = j.job_id
    WHERE j.telegram_user_id = ?
      AND j.status IN ('completed', 'failed', 'canceled')
      AND j.created_at >= ?
      AND (a.audit_id IS NULL OR a.expires_at > ?)
    ORDER BY j.created_at DESC
    LIMIT ?`)
    .bind(telegramUserId, cutoff, nowIso, HISTORY_LIMIT)
    .all<UserHistoryItem>();
  if (result.success === false) throw new Error(result.error ?? "Could not load audit history.");
  return result.results ?? [];
}

export async function forgetUserHistory(db: D1DatabaseLike, telegramUserId: string): Promise<void> {
  // A disabled history preference is sticky: /forget must not silently
  // re-enroll an opted-out user into 30-day retention.
  const historyEnabled = await getHistoryPreference(db, telegramUserId);
  const results = await db.batch([
    db.prepare("DELETE FROM audits WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM jobs WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare(`DELETE FROM users
      WHERE telegram_user_id = ?`).bind(telegramUserId),
  ]);
  assertBatch(results);
  if (!historyEnabled) {
    await setHistoryPreference(db, telegramUserId, false);
  }
}

export async function cleanupExpiredHistory(
  db: D1DatabaseLike,
  now = Date.now(),
): Promise<{ deletedJobs: number; deletedAudits: number; deletedUsers: number }> {
  const nowIso = new Date(now).toISOString();
  const cutoff = new Date(now - HISTORY_RETENTION_MS).toISOString();
  const optedOutCutoff = new Date(now - OPTED_OUT_GRACE_MS).toISOString();
  const results = await db.batch([
    db.prepare(`DELETE FROM jobs
      WHERE status IN ('completed', 'failed', 'canceled')
        AND (
          EXISTS (
            SELECT 1 FROM audits a
            WHERE a.job_id = jobs.job_id AND a.expires_at <= ?
          )
          OR (
            NOT EXISTS (SELECT 1 FROM audits a WHERE a.job_id = jobs.job_id)
            AND jobs.created_at <= ?
          )
        )`).bind(nowIso, cutoff),
    db.prepare("DELETE FROM audits WHERE expires_at <= ?").bind(nowIso),
    // Preference rows with retention off survive cleanup so an opt-out is
    // never silently reverted after 30 idle days.
    db.prepare(`DELETE FROM users
      WHERE created_at <= ?
        AND history_enabled = 1
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.telegram_user_id = users.telegram_user_id)
        AND NOT EXISTS (SELECT 1 FROM audits WHERE audits.telegram_user_id = users.telegram_user_id)`)
      .bind(cutoff),
    // Backstop for opted-out users: records that escaped the immediate
    // post-delivery purge disappear within 24 hours. Snapshots are audit
    // records too and are counted under deletedAudits.
    db.prepare(`DELETE FROM jobs
      WHERE telegram_user_id IN (SELECT telegram_user_id FROM users WHERE history_enabled = 0)
        AND status IN ('completed', 'failed', 'canceled')
        AND COALESCE(completed_at, created_at) <= ?`).bind(optedOutCutoff),
    db.prepare(`DELETE FROM audits
      WHERE telegram_user_id IN (SELECT telegram_user_id FROM users WHERE history_enabled = 0)
        AND created_at <= ?`).bind(optedOutCutoff),
    db.prepare(`DELETE FROM audit_snapshots
      WHERE telegram_user_id IN (SELECT telegram_user_id FROM users WHERE history_enabled = 0)
        AND created_at <= ?`).bind(optedOutCutoff),
  ]);
  assertBatch(results);
  return {
    deletedJobs: changeCount(results[0]) + changeCount(results[3]),
    deletedAudits: changeCount(results[1]) + changeCount(results[4]) + changeCount(results[5]),
    deletedUsers: changeCount(results[2]),
  };
}
