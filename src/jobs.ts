export type JobType = "seo_audit" | "geo_audit";
export type JobStatus = "queued" | "running" | "completed" | "failed" | "canceled" | "cancel_requested";

export interface AuditJobMessage {
  jobId: string;
  auditId: string;
  telegramUserId: string;
  chatId: string;
  type: JobType;
  url: string;
  attempt: number;
}

export interface JobRow {
  job_id: string;
  audit_id: string;
  telegram_user_id: string;
  chat_id: string;
  type: JobType;
  url: string;
  status: JobStatus;
  created_at: string;
  started_at: string | null;
  completed_at: string | null;
  error: string | null;
  result_summary_message_id: string | null;
  source_update_id: string | null;
}

export interface D1ResultLike<T = unknown> {
  success?: boolean;
  error?: string;
  meta?: { changes?: number };
  results?: T[];
}

export interface D1PreparedStatementLike {
  bind(...values: unknown[]): D1PreparedStatementLike;
  first<T = unknown>(): Promise<T | null>;
  run<T = unknown>(): Promise<D1ResultLike<T>>;
  all<T = unknown>(): Promise<D1ResultLike<T>>;
}

export interface D1DatabaseLike {
  prepare(query: string): D1PreparedStatementLike;
  batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]>;
}

export interface AuditQueueLike {
  send(message: AuditJobMessage): Promise<void>;
}

export interface JobEnvironment {
  DB?: D1DatabaseLike;
  AUDIT_QUEUE?: AuditQueueLike;
  MAX_AUDITS_PER_USER_PER_HOUR?: string;
  MAX_CONCURRENT_AUDITS_PER_USER?: string;
}

export class UserFacingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "UserFacingError";
  }
}

const JOB_SELECT = `SELECT
  job_id, audit_id, telegram_user_id, chat_id, type, url, status,
  created_at, started_at, completed_at, error, result_summary_message_id,
  source_update_id
FROM jobs`;

function assertDatabaseSuccess<T>(result: D1ResultLike<T>): void {
  if (result.success === false) throw new Error(result.error ?? "D1 operation failed");
}

function changes<T>(result: D1ResultLike<T>): number {
  assertDatabaseSuccess(result);
  return result.meta?.changes ?? 0;
}

function positiveInteger(value: string | undefined, fallback: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? parsed : fallback;
}

async function countForUser(db: D1DatabaseLike, sql: string, userId: string, bindValue?: string): Promise<number> {
  const statement = db.prepare(sql);
  const row = bindValue === undefined
    ? await statement.bind(userId).first<{ count: number | string }>()
    : await statement.bind(userId, bindValue).first<{ count: number | string }>();
  return Number(row?.count ?? 0);
}

export async function getJobById(db: D1DatabaseLike, jobId: string): Promise<JobRow | null> {
  return db.prepare(`${JOB_SELECT} WHERE job_id = ?`).bind(jobId).first<JobRow>();
}

export async function getJobForUser(db: D1DatabaseLike, jobId: string, userId: string): Promise<JobRow | null> {
  return db.prepare(`${JOB_SELECT} WHERE job_id = ? AND telegram_user_id = ?`)
    .bind(jobId, userId)
    .first<JobRow>();
}

async function getJobForUpdate(db: D1DatabaseLike, updateId: string, userId: string): Promise<JobRow | null> {
  return db.prepare(`${JOB_SELECT} WHERE source_update_id = ? AND telegram_user_id = ?`)
    .bind(updateId, userId)
    .first<JobRow>();
}

export async function getJobsForUser(
  db: D1DatabaseLike,
  userId: string,
  statuses: JobStatus[],
): Promise<JobRow[]> {
  if (statuses.length === 0) return [];
  const placeholders = statuses.map(() => '?').join(',');
  return db.prepare(`${JOB_SELECT} WHERE telegram_user_id = ? AND status IN (${placeholders}) ORDER BY created_at DESC`)
    .bind(userId, ...statuses)
    .all<JobRow>()
    .then((result) => result.results ?? []);
}

function toQueueMessage(job: JobRow): AuditJobMessage {
  return {
    jobId: job.job_id,
    auditId: job.audit_id,
    telegramUserId: job.telegram_user_id,
    chatId: job.chat_id,
    type: job.type,
    url: job.url,
    attempt: 1,
  };
}

async function markEnqueueFailed(db: D1DatabaseLike, jobId: string): Promise<void> {
  const result = await db.prepare(`UPDATE jobs
    SET status = 'failed', completed_at = ?, error = ?
    WHERE job_id = ? AND status = 'queued'`)
    .bind(new Date().toISOString(), "The audit queue could not accept this job. Please try again.", jobId)
    .run();
  assertDatabaseSuccess(result);
}

async function enqueueIfQueued(
  db: D1DatabaseLike,
  queue: AuditQueueLike,
  job: JobRow,
): Promise<{ enqueued: boolean; job: JobRow }> {
  if (job.status !== "queued") return { enqueued: false, job };
  try {
    await queue.send(toQueueMessage(job));
    return { enqueued: true, job };
  } catch {
    await markEnqueueFailed(db, job.job_id);
    return {
      enqueued: false,
      job: {
        ...job,
        status: "failed",
        completed_at: new Date().toISOString(),
        error: "The audit queue could not accept this job. Please try again.",
      },
    };
  }
}

export async function createAuditJob(
  env: JobEnvironment,
  input: {
    telegramUserId: number;
    chatId: number;
    url: string;
    updateId: number | null;
    type?: JobType;
  },
): Promise<{ job: JobRow; enqueued: boolean; duplicate: boolean }> {
  if (!env.DB || !env.AUDIT_QUEUE) throw new Error("Audit storage or queue is not configured.");
  const userId = String(input.telegramUserId);
  const db = env.DB;

  if (input.updateId !== null) {
    const existing = await getJobForUpdate(db, String(input.updateId), userId);
    if (existing) {
      const delivery = await enqueueIfQueued(db, env.AUDIT_QUEUE, existing);
      return { ...delivery, duplicate: true };
    }
  }

  const createdAt = new Date().toISOString();
  const hourAgo = new Date(Date.now() - 60 * 60 * 1000).toISOString();
  const hourlyLimit = positiveInteger(env.MAX_AUDITS_PER_USER_PER_HOUR, 10);
  const activeLimit = positiveInteger(env.MAX_CONCURRENT_AUDITS_PER_USER, 2);
  const jobId = crypto.randomUUID();
  const auditId = crypto.randomUUID();
  const type = input.type ?? "seo_audit";
  const sourceUpdateId = input.updateId === null ? null : String(input.updateId);
  const inserted = await db.prepare(`INSERT OR IGNORE INTO jobs (
      job_id, audit_id, telegram_user_id, chat_id, type, url, status,
      created_at, source_update_id
    ) SELECT ?, ?, ?, ?, ?, ?, 'queued', ?, ?
      WHERE (SELECT COUNT(*) FROM jobs WHERE telegram_user_id = ? AND created_at >= ?) < ?
        AND (SELECT COUNT(*) FROM jobs WHERE telegram_user_id = ? AND status IN ('queued', 'running', 'cancel_requested')) < ?`)
    .bind(
      jobId,
      auditId,
      userId,
      String(input.chatId),
      type,
      input.url,
      createdAt,
      sourceUpdateId,
      userId,
      hourAgo,
      hourlyLimit,
      userId,
      activeLimit,
    )
    .run();

  const insertedRows = changes(inserted);
  if (insertedRows === 0 && sourceUpdateId !== null) {
    const existing = await getJobForUpdate(db, sourceUpdateId, userId);
    if (existing) {
      const delivery = await enqueueIfQueued(db, env.AUDIT_QUEUE, existing);
      return { ...delivery, duplicate: true };
    }
  }
  if (insertedRows === 0) {
    const hourlyCount = await countForUser(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE telegram_user_id = ? AND created_at >= ?",
      userId,
      hourAgo,
    );
    if (hourlyCount >= hourlyLimit) {
      throw new UserFacingError("You've reached the audit limit for this hour. Try again later.");
    }
    const activeCount = await countForUser(
      db,
      "SELECT COUNT(*) AS count FROM jobs WHERE telegram_user_id = ? AND status IN ('queued', 'running', 'cancel_requested')",
      userId,
    );
    if (activeCount >= activeLimit) {
      throw new UserFacingError(`You already have the maximum number (${activeLimit}) of active audits. Please wait for one to finish.`);
    }
    throw new Error("D1 did not create the audit job.");
  }

  const job: JobRow = {
    job_id: jobId,
    audit_id: auditId,
    telegram_user_id: userId,
    chat_id: String(input.chatId),
    type,
    url: input.url,
    status: "queued",
    created_at: createdAt,
    started_at: null,
    completed_at: null,
    error: null,
    result_summary_message_id: null,
    source_update_id: sourceUpdateId,
  };
  // Ensure the user row exists (history_enabled defaults to 1 in schema)
  await db.prepare(`INSERT OR IGNORE INTO users (telegram_user_id, created_at) VALUES (?, ?)`)
    .bind(userId, createdAt)
    .run();
  const delivery = await enqueueIfQueued(db, env.AUDIT_QUEUE, job);
  return { ...delivery, duplicate: false };
}

export async function getJobStatusMessage(
  db: D1DatabaseLike | undefined,
  jobId: string | undefined,
  userId: number,
  now = Date.now(),
): Promise<string> {
  if (!jobId || /\s/.test(jobId)) return "Usage: /status <job_id>";
  if (!db) throw new Error("Audit storage is not configured.");
  const job = await getJobForUser(db, jobId, String(userId));
  if (!job) return "I couldn't find that job.";

  const createdMs = Date.parse(job.created_at);
  const elapsed = Number.isFinite(createdMs) ? formatElapsed(Math.max(0, now - createdMs)) : "unknown";
  const lines = [
    "Job status",
    `Job ID: ${job.job_id}`,
    `Website: ${job.url}`,
    `Status: ${job.status}`,
    `Elapsed: ${elapsed}`,
  ];
  if (job.error) lines.push(`Error: ${job.error.slice(0, 300)}`);
  if (job.status === "queued") lines.push(`Next: check /status ${job.job_id} or /cancel ${job.job_id}.`);
  else if (job.status === "running") lines.push(`Next: check /status ${job.job_id} again; use /cancel ${job.job_id} to request cancellation.`);
  else if (job.status === "failed") lines.push("Next: tap Retry audit on the failure message, or start a fresh /audit or /geo command.");
  else if (job.status === "completed") lines.push("Your report was delivered. Use /history to see recent audits.");
  else if (job.status === "canceled") lines.push("This audit will not continue. Start a new /audit or /geo command when ready.");
  return lines.join("\n");
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

export async function cancelAuditJob(
  db: D1DatabaseLike | undefined,
  jobId: string | undefined,
  userId: number,
): Promise<string> {
  if (!jobId || /\s/.test(jobId)) return "Usage: /cancel <job_id>";
  if (!db) throw new Error("Audit storage is not configured.");

  const telegramUserId = String(userId);
  const job = await getJobForUser(db, jobId, telegramUserId);
  if (!job) return "I couldn't find that job.";
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") {
    return `This job is already ${job.status}; it cannot be canceled.`;
  }
  if (job.status === "cancel_requested") {
    return "Cancellation has already been requested.";
  }

  const nextStatus: JobStatus = job.status === "running" ? "cancel_requested" : "canceled";
  const completedAt = new Date().toISOString();
  const result = await db.prepare(`UPDATE jobs
      SET status = ?,
          completed_at = CASE WHEN ? = 'canceled' THEN ? ELSE completed_at END
      WHERE job_id = ? AND telegram_user_id = ? AND status = ?`)
    .bind(nextStatus, nextStatus, completedAt, jobId, telegramUserId, job.status)
    .run();
  if (changes(result) > 0) {
    return nextStatus === "canceled"
      ? "Job canceled."
      : "Cancellation requested. The worker will stop at its next safe checkpoint.";
  }

  const latest = await getJobForUser(db, jobId, telegramUserId);
  if (!latest) return "I couldn't find that job.";
  if (latest.status === "completed" || latest.status === "failed" || latest.status === "canceled") {
    return `This job is already ${latest.status}; it cannot be canceled.`;
  }
  return "Cancellation has already been requested.";
}
