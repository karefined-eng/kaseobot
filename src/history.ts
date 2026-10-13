import type { D1DatabaseLike, D1ResultLike, JobType, JobStatus } from "./jobs";

const HISTORY_RETENTION_MS = 30 * 24 * 60 * 60 * 1000;
const HISTORY_LIMIT = 10;

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
  const results = await db.batch([
    db.prepare("DELETE FROM audits WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare("DELETE FROM jobs WHERE telegram_user_id = ?").bind(telegramUserId),
    db.prepare(`DELETE FROM users
      WHERE telegram_user_id = ?`).bind(telegramUserId),
  ]);
  assertBatch(results);
}

export async function cleanupExpiredHistory(
  db: D1DatabaseLike,
  now = Date.now(),
): Promise<{ deletedJobs: number; deletedAudits: number; deletedUsers: number }> {
  const nowIso = new Date(now).toISOString();
  const cutoff = new Date(now - HISTORY_RETENTION_MS).toISOString();
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
    db.prepare(`DELETE FROM users
      WHERE created_at <= ?
        AND NOT EXISTS (SELECT 1 FROM jobs WHERE jobs.telegram_user_id = users.telegram_user_id)
        AND NOT EXISTS (SELECT 1 FROM audits WHERE audits.telegram_user_id = users.telegram_user_id)`)
      .bind(cutoff),
  ]);
  assertBatch(results);
  return {
    deletedJobs: changeCount(results[0]),
    deletedAudits: changeCount(results[1]),
    deletedUsers: changeCount(results[2]),
  };
}
