import { getJobById, type AuditJobMessage, type D1DatabaseLike, type JobEnvironment } from "./jobs";
import { generateAuditReport, type GeneratedAuditReport, type KimiEnvironment } from "./ai/report";
import { createAuditEngine } from "./audits/engine";
import { CachedStaticHtmlFetcher, runGeoAudit } from "./audits/geo";
import { clampGeoPageLimit } from "./audits/geo-links";
import { normalizeAuditResult } from "./audits/normalizer";
import { getAuditResult, saveAuditResult } from "./audits/storage";
import { AuditEngineError, type AuditEngine, type KaseobotAuditResult } from "./audits/types";
import { toTelegramMarkdownV2 } from "./ai/markdown";

export interface QueueMessageLike<T> {
  body: T;
  attempts?: number;
  ack(): void;
  retry(options?: { delaySeconds?: number }): void;
}

export interface MessageBatchLike<T> {
  queue: string;
  messages: QueueMessageLike<T>[];
}

const DEAD_LETTER_QUEUE = "kaseobot-audit-dead-letter";
const RETRIES_EXHAUSTED = "The audit worker could not process this job after several retries.";
const MAX_INLINE_REPORT_LENGTH = 3_500;

type QueueEnvironment = JobEnvironment & KimiEnvironment & {
  TELEGRAM_BOT_TOKEN?: string;
  AUDIT_TIMEOUT_MS?: string;
  GEO_MAX_PAGES?: string;
};

type AuditReportGenerator = (audit: KaseobotAuditResult, env: QueueEnvironment) => Promise<GeneratedAuditReport>;

function isAuditJobMessage(value: unknown): value is AuditJobMessage {
  if (typeof value !== "object" || value === null || Array.isArray(value)) return false;
  const candidate = value as Record<string, unknown>;
  return (
    typeof candidate.jobId === "string" && candidate.jobId.length > 0 &&
    typeof candidate.auditId === "string" && candidate.auditId.length > 0 &&
    typeof candidate.telegramUserId === "string" && candidate.telegramUserId.length > 0 &&
    typeof candidate.chatId === "string" && candidate.chatId.length > 0 &&
    (candidate.type === "seo_audit" || candidate.type === "geo_audit") &&
    typeof candidate.url === "string" && candidate.url.length > 0 &&
    typeof candidate.attempt === "number" && Number.isSafeInteger(candidate.attempt) && candidate.attempt >= 1
  );
}

function retryDelay(attempts: number | undefined): number {
  const exponent = Math.max(1, Math.min(attempts ?? 1, 6));
  return Math.min(60, 2 ** exponent);
}

function changesOrThrow(result: { success?: boolean; error?: string; meta?: { changes?: number } }): number {
  if (result.success === false) throw new Error(result.error ?? "D1 operation failed");
  return result.meta?.changes ?? 0;
}

async function setCanceled(db: D1DatabaseLike, jobId: string): Promise<void> {
  const result = await db.prepare(`UPDATE jobs
      SET status = 'canceled', completed_at = ?
      WHERE job_id = ? AND status = 'cancel_requested'`)
    .bind(new Date().toISOString(), jobId)
    .run();
  changesOrThrow(result);
}

async function claimJob(db: D1DatabaseLike, job: Awaited<ReturnType<typeof getJobById>>): Promise<boolean> {
  if (!job) return false;
  if (job.status === "running") return true;
  if (job.status !== "queued") return false;
  const result = await db.prepare(`UPDATE jobs
      SET status = 'running', started_at = COALESCE(started_at, ?), error = NULL
      WHERE job_id = ? AND status = 'queued'`)
    .bind(new Date().toISOString(), job.job_id)
    .run();
  const claimed = changesOrThrow(result) > 0;
  if (claimed) return true;

  const latest = await getJobById(db, job.job_id);
  if (latest?.status === "cancel_requested") await setCanceled(db, latest.job_id);
  return false;
}

async function runJob(
  db: D1DatabaseLike,
  env: QueueEnvironment,
  body: AuditJobMessage,
  engine: AuditEngine,
  geoFetcher: CachedStaticHtmlFetcher,
  deliveryAttempt: number,
  reportGenerator: AuditReportGenerator,
): Promise<void> {
  const job = await getJobById(db, body.jobId);
  if (!job) return; // Permanent orphan.
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return;
  if (job.status === "cancel_requested") {
    await setCanceled(db, job.job_id);
    return;
  }
  // Distinct first-delivery messages can race for the same job. Only a
  // redelivery of the owning queue message (attempt > 1) may resume a running job.
  if (job.status === "running" && deliveryAttempt <= 1) return;
  if (!await claimJob(db, job)) return;

  // A retry after successful audit storage reuses the same normalized result;
  // this avoids repeating the site fetch if Telegram delivery was transiently down.
  let audit: KaseobotAuditResult | null = await getAuditResult(db, job.audit_id);
  if (!audit) {
    const timeout = positiveInteger(env.AUDIT_TIMEOUT_MS, 20_000, 60_000);
    const engineResult = job.type === "geo_audit"
      ? await runGeoAudit({
          url: job.url,
          maxPages: clampGeoPageLimit(env.GEO_MAX_PAGES),
          timeoutMs: timeout,
        }, { engine, fetcher: geoFetcher })
      : await engine.auditPage({
          url: job.url,
          timeoutMs: timeout,
          includeJavaScriptRendering: false,
          includeCoreWebVitals: false,
        });

    const latest = await getJobById(db, job.job_id);
    if (!latest || latest.status === "canceled") return;
    if (latest.status === "cancel_requested") {
      await setCanceled(db, job.job_id);
      return;
    }

    try {
      audit = normalizeAuditResult({
        jobId: job.job_id,
        auditId: job.audit_id,
        type: job.type,
        url: job.url,
        requestedBy: job.telegram_user_id,
        startedAt: latest.started_at ?? job.created_at,
        engineResult,
      });
    } catch {
      throw new AuditEngineError("The audit engine returned an unsupported result.", false);
    }
    if (!await saveAuditResult(db, audit)) return; // /forget may have deleted the running job.
  }

  const latest = await getJobById(db, job.job_id);
  if (!latest || latest.status === "canceled") return;
  if (latest.status === "cancel_requested") {
    await setCanceled(db, job.job_id);
    return;
  }

  let reportMarkdownV2 = typeof audit.ai?.reportMarkdownV2 === "string" && audit.ai.reportMarkdownV2.length > 0
    ? audit.ai.reportMarkdownV2
    : null;
  let reportMarkdown = typeof audit.ai?.reportMarkdown === "string" && audit.ai.reportMarkdown.length > 0
    ? audit.ai.reportMarkdown
    : null;
  if (!reportMarkdownV2) {
    const generated = await reportGenerator(audit, env);
    audit.ai = generated.ai;
    reportMarkdownV2 = generated.markdownV2;
    reportMarkdown = generated.markdown;
    if (!await saveAuditResult(db, audit)) return;
  }

  // Older saved rows have only MarkdownV2; reuse it rather than calling Kimi again.
  reportMarkdown ??= reportMarkdownV2;
  const beforeDelivery = await getJobById(db, job.job_id);
  if (!beforeDelivery || beforeDelivery.status !== "running") return;
  const messageId = await sendAuditReport(env.TELEGRAM_BOT_TOKEN, Number(job.chat_id), audit, reportMarkdown, reportMarkdownV2);
  const completedAt = new Date().toISOString();
  const updated = await db.prepare(`UPDATE jobs
      SET status = 'completed', completed_at = ?, error = NULL, result_summary_message_id = ?
      WHERE job_id = ? AND status = 'running'`)
    .bind(completedAt, messageId === null ? null : String(messageId), job.job_id)
    .run();
  if (changesOrThrow(updated) === 0) {
    const finalJob = await getJobById(db, job.job_id);
    if (finalJob?.status === "cancel_requested") await setCanceled(db, job.job_id);
  }
}

async function sendAuditReport(token: string | undefined, chatId: number, audit: KaseobotAuditResult, markdown: string, markdownV2: string): Promise<number | null> {
  if (!token || !Number.isSafeInteger(chatId)) throw new Error("Telegram report delivery is not configured.");
  const longReport = markdown.length > MAX_INLINE_REPORT_LENGTH || markdownV2.length > MAX_INLINE_REPORT_LENGTH;
  const response = longReport
    ? await sendMarkdownDocument(token, chatId, audit, markdown)
    : await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ chat_id: chatId, text: markdownV2, parse_mode: "MarkdownV2" }),
      });
  let payload: unknown;
  try {
    payload = await response.json();
  } catch {
    throw new Error("Telegram report delivery returned an unreadable response.");
  }
  if (!response.ok || !isRecord(payload) || payload.ok !== true) {
    throw new Error("Telegram did not accept the audit report.");
  }
  const result = isRecord(payload.result) ? payload.result : null;
  return typeof result?.message_id === "number" && Number.isSafeInteger(result.message_id)
    ? result.message_id
    : null;
}

async function sendMarkdownDocument(token: string, chatId: number, audit: KaseobotAuditResult, markdown: string): Promise<Response> {
  const form = new FormData();
  form.set("chat_id", String(chatId));
  form.set("caption", toTelegramMarkdownV2(buildShortSummary(audit), 900));
  form.set("parse_mode", "MarkdownV2");
  const safeAuditId = audit.auditId.replace(/[^a-z0-9_-]/gi, "").slice(0, 64) || "report";
  form.set("document", new Blob([markdown], { type: "text/markdown; charset=utf-8" }), `kaseobot-audit-${safeAuditId}.md`);
  return fetch(`https://api.telegram.org/bot${token}/sendDocument`, { method: "POST", body: form });
}

function buildShortSummary(audit: KaseobotAuditResult): string {
  const label = audit.type === "geo_audit" ? "GEO" : "SEO";
  const lines = [
    `## ${label} audit complete`,
    `Website: ${audit.url}`,
    `Overall score: ${audit.overallScore === null ? "not available" : `${audit.overallScore}/100`}`,
    `Findings: ${audit.summary.failed} failed, ${audit.summary.warnings} warnings`,
  ];
  if (audit.geo) lines.push(`Pages: ${audit.geo.pagesAudited} audited, ${audit.geo.pagesFailed} failed of ${audit.geo.pagesRequested} requested`);
  const priorities = audit.categories.flatMap((category) => category.findings
    .filter((finding) => finding.status === "fail" || finding.status === "warn")
    .map((finding) => ({ status: finding.status, title: finding.title })))
    .sort((a, b) => Number(a.status !== "fail") - Number(b.status !== "fail"))
    .slice(0, 3);
  if (priorities.length > 0) lines.push("", "Priority issues:", ...priorities.map((item) => `- ${item.title.slice(0, 180)}`));
  else lines.push("", "No failed or warning checks were returned.");
  lines.push("", "The attached Markdown file contains the complete report.");
  return lines.join("\n");
}

async function failPermanentJob(
  db: D1DatabaseLike,
  env: QueueEnvironment,
  jobId: string,
  chatId: string,
  error: AuditEngineError,
): Promise<void> {
  const current = await getJobById(db, jobId);
  if (!current || current.status === "completed" || current.status === "failed" || current.status === "canceled") return;
  if (current.status === "cancel_requested") {
    await setCanceled(db, jobId);
    return;
  }
  const result = await db.prepare(`UPDATE jobs
      SET status = 'failed', completed_at = ?, error = ?
      WHERE job_id = ? AND status IN ('queued', 'running')`)
    .bind(new Date().toISOString(), safeError(error.message), jobId)
    .run();
  if (changesOrThrow(result) > 0) {
    await notifyFailure(env.TELEGRAM_BOT_TOKEN, Number(current.chat_id), jobId, safeError(error.message));
  }
}

async function consumeDeadLetter(db: D1DatabaseLike, env: QueueEnvironment, body: AuditJobMessage): Promise<void> {
  const job = await getJobById(db, body.jobId);
  if (!job) return;
  if (job.status === "completed" || job.status === "failed" || job.status === "canceled") return;
  if (job.status === "cancel_requested") {
    await setCanceled(db, job.job_id);
    return;
  }

  const failed = await db.prepare(`UPDATE jobs
      SET status = 'failed', completed_at = ?, error = ?
      WHERE job_id = ? AND status IN ('queued', 'running')`)
    .bind(new Date().toISOString(), RETRIES_EXHAUSTED, job.job_id)
    .run();
  if (changesOrThrow(failed) > 0) {
    await notifyFailure(env.TELEGRAM_BOT_TOKEN, Number(job.chat_id), job.job_id, RETRIES_EXHAUSTED);
  }
}

async function notifyFailure(token: string | undefined, chatId: number, jobId: string, reason: string): Promise<void> {
  if (!token || !Number.isSafeInteger(chatId)) return;
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text: `Audit job ${jobId} failed: ${reason}. Use /status ${jobId} for details, or tap Retry audit to create a new job.`,
        reply_markup: retryKeyboard(jobId),
      }),
    });
  } catch {
    // Best effort only; never log a request URL that could contain the bot token.
  }
}

function retryKeyboard(jobId: string): { inline_keyboard: Array<Array<{ text: string; callback_data: string }>> } {
  return { inline_keyboard: [[{ text: "Retry audit", callback_data: `retry:${jobId}` }]] };
}

export async function consumeAuditQueue(
  batch: MessageBatchLike<unknown>,
  env: QueueEnvironment,
  auditEngine?: AuditEngine,
  reportGenerator: AuditReportGenerator = generateAuditReport,
): Promise<void> {
  const geoFetcher = new CachedStaticHtmlFetcher();
  const engine = auditEngine ?? createAuditEngine(geoFetcher);
  for (const message of batch.messages) {
    if (!isAuditJobMessage(message.body)) {
      message.ack(); // Malformed messages are permanently invalid.
      continue;
    }
    if (!env.DB) {
      message.retry({ delaySeconds: retryDelay(message.attempts) });
      continue;
    }

    try {
      if (batch.queue === DEAD_LETTER_QUEUE) {
        await consumeDeadLetter(env.DB, env, message.body);
      } else {
        await runJob(env.DB, env, message.body, engine, geoFetcher, message.attempts ?? 1, reportGenerator);
      }
      message.ack();
    } catch (error) {
      if (error instanceof AuditEngineError && !error.retryable) {
        try {
          await failPermanentJob(env.DB, env, message.body.jobId, message.body.chatId, error);
          message.ack();
        } catch {
          message.retry({ delaySeconds: retryDelay(message.attempts) });
        }
      } else {
        message.retry({ delaySeconds: retryDelay(message.attempts) });
      }
    }
  }
}

function positiveInteger(value: string | undefined, fallback: number, maximum: number): number {
  const parsed = Number(value);
  return Number.isSafeInteger(parsed) && parsed > 0 ? Math.min(parsed, maximum) : fallback;
}

function safeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 300);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
