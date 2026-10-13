import type { D1DatabaseLike } from "../jobs";
import type { KaseobotAuditResult } from "./types";

export async function saveAuditResult(db: D1DatabaseLike, audit: KaseobotAuditResult): Promise<boolean> {
  const expiresAt = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000).toISOString();
  const normalizedWithoutRaw = { ...audit, raw: undefined };
  const result = await db.prepare(`INSERT INTO audits (
      audit_id, job_id, telegram_user_id, url, type, overall_score,
      normalized_result, raw_result, created_at, expires_at
    ) SELECT ?, ?, ?, ?, ?, ?, ?, ?, ?, ?
      WHERE EXISTS (
        SELECT 1 FROM jobs
        WHERE job_id = ? AND telegram_user_id = ? AND status = 'running'
      )
    ON CONFLICT(audit_id) DO UPDATE SET
      normalized_result = excluded.normalized_result,
      raw_result = excluded.raw_result,
      overall_score = excluded.overall_score,
      created_at = excluded.created_at,
      expires_at = excluded.expires_at`)
    .bind(
      audit.auditId,
      audit.jobId,
      audit.requestedBy,
      audit.url,
      audit.type,
      audit.overallScore,
      JSON.stringify(normalizedWithoutRaw),
      JSON.stringify(audit.raw),
      audit.completedAt ?? new Date().toISOString(),
      expiresAt,
      audit.jobId,
      audit.requestedBy,
    )
    .run();
  assertDatabaseSuccess(result);
  return (result.meta?.changes ?? 0) > 0;
}

export async function getAuditResult(db: D1DatabaseLike, auditId: string): Promise<KaseobotAuditResult | null> {
  const row = await db.prepare(`SELECT normalized_result, raw_result
      FROM audits WHERE audit_id = ?`)
    .bind(auditId)
    .first<{ normalized_result: string; raw_result: string | null }>();
  if (!row) return null;

  const normalized: unknown = JSON.parse(row.normalized_result);
  if (!isRecord(normalized)) throw new Error("Stored normalized audit result is invalid.");
  const raw = row.raw_result === null ? null : JSON.parse(row.raw_result);
  return { ...normalized, raw } as unknown as KaseobotAuditResult;
}

function assertDatabaseSuccess(result: { success?: boolean; error?: string }): void {
  if (result.success === false) throw new Error(result.error ?? "D1 audit result operation failed.");
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
