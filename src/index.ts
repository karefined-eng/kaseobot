import {
  cancelAuditJob,
  createAuditJob,
  getJobForUser,
  getJobStatusMessage,
  getJobsForUser,
  UserFacingError,
  type AuditQueueLike,
  type D1DatabaseLike,
  type JobEnvironment,
} from "./jobs";
import { consumeAuditQueue, type MessageBatchLike } from "./queue-consumer";
import { clampGeoPageLimit } from "./audits/geo-links";
import { cleanupExpiredHistory, ensureUser, forgetUserHistory, getUserHistory } from "./history";
import {
  addWatchedUrl,
  listWatchedUrls,
  removeWatchedUrl,
  removeWatchedUrlById,
  runWatcher,
  type WatchedUrl,
} from "./watch";
import {
  answerCallbackQuery,
  chunkedResultsKeyboard,
  dataPrivacyKeyboard,
  deepAuditConfirmKeyboard,
  deepAuditCostMessage,
  formatHistory,
  forgetConfirmKeyboard,
  helpMessage,
  jobAckKeyboard,
  jobAcknowledgment,
  jobsKeyboard,
  jobsMessage,
  mainMenuKeyboard,
  menuLabelToCommand,
  retryKeyboard,
  seomatorKeyboard,
  updateIdFrom,
  welcomeMessage,
  watchesKeyboard,
  watchAckKeyboard,
  type TelegramInlineKeyboard,
  type TelegramReplyKeyboard,
} from "./telegram-ui";
import { validateAndNormalizeUrl } from "./url-validation";
import { createAuditEngine } from "./audits/engine";
import { normalizeAuditResult } from "./audits/normalizer";
import { buildKeywordSummary } from "./audits/keyword-signals";
import type { SeomatorContainerNamespace } from "./seomator-container";

export interface Env extends JobEnvironment {
  TELEGRAM_BOT_TOKEN?: string;
  TELEGRAM_WEBHOOK_SECRET?: string;
  ALLOWED_TELEGRAM_USER_IDS?: string;
  DB?: D1DatabaseLike;
  AUDIT_QUEUE?: AuditQueueLike;
  MAX_AUDITS_PER_USER_PER_HOUR?: string;
  MAX_CONCURRENT_AUDITS_PER_USER?: string;
  AUDIT_TIMEOUT_MS?: string;
  NVIDIA_API_KEY?: string;
  NVIDIA_KIMI_MODEL?: string;
  NVIDIA_KIMI_ENDPOINT?: string;
  KIMI_TIMEOUT_MS?: string;
  MAX_FINDINGS_FOR_KIMI?: string;
  MAX_EVIDENCE_LENGTH?: string;
  GEO_MAX_PAGES?: string;
  SEOMATOR_CONTAINER?: SeomatorContainerNamespace;
}

export interface ExecutionContextLike {
  waitUntil(promise: Promise<unknown>): void;
}

export interface ParsedCommand {
  name: string;
  args: string;
  botUsername?: string;
}

interface TelegramMessage {
  text?: unknown;
  from?: { id?: unknown; is_bot?: unknown };
  chat?: { id?: unknown; type?: unknown };
}

const WEBHOOK_PATH = "/telegram/webhook";
const HEALTH_PATH = "/healthz";

// Commands registered in Telegram's left-side / menu.
const BOT_COMMANDS = [
  { command: "start", description: "Start the bot and show the main menu" },
  { command: "help", description: "Show available commands" },
  { command: "audit", description: "Enqueue a one-page SEO audit" },
  { command: "geo", description: "GEO crawl of up to five same-origin pages" },
  { command: "keywords", description: "Extract keyword signals from a page" },
  { command: "deepaudit", description: "Full SEOmator deep audit (paid plan)" },
  { command: "jobs", description: "Show in-progress audits" },
  { command: "status", description: "Check an audit job" },
  { command: "watch", description: "Watch a site and get alerted when results change" },
  { command: "unwatch", description: "Stop watching a site" },
  { command: "cancel", description: "Cancel a queued job" },
  { command: "history", description: "List recent audits" },
  { command: "forget", description: "Delete all saved data" },
  { command: "privacy", description: "Show data-handling information" },
];

export function parseTelegramCommand(text: string): ParsedCommand | null {
  const match = /^\/([a-z0-9_]+)(?:@([a-z0-9_]+))?(?:\s+([\s\S]*))?$/i.exec(text.trim());
  if (!match) return null;

  const [, rawName, botUsername, rawArgs = ""] = match;
  return {
    name: rawName.toLowerCase(),
    args: rawArgs.trim(),
    ...(botUsername ? { botUsername } : {}),
  };
}

export function routeCommand(command: ParsedCommand): string {
  switch (command.name) {
    case "start":
      return "Welcome to kaseomator. Tap a button below, or send /help.";;
    case "help":
      return [
        "Kaseobot commands:",
        "/start — start the bot",
        "/help — show this help",
        "/audit <url> — enqueue a one-page SEO audit",
        "/geo <url> — enqueue a GEO crawl of up to five same-origin pages",
        "/deepaudit <url> [--type=seo-full|geo|quick|custom] [--categories=...] [--crawl] [--max-pages=N] [--mobile] — run full SEOmator engine via Container (requires Workers Paid plan)",
        "/jobs — show in-progress audits",
        "/status <job_id> — check an audit job",
"/watch <url> — watch a site and get alerted when audit results change",
"/unwatch <url> — stop watching a site",
        "/cancel <job_id> — cancel a queued job",
        "/history — list your recent audits",
        "/forget — delete your saved audit history",
        "/seomator <url> — open SEOmator's external SEO/GEO tools",
        "/privacy — show data-handling information",
        "",
        "Audits inspect static HTML only. GEO crawls are capped at five same-origin pages. Kimi may explain measured findings when NVIDIA access is configured; otherwise Kaseobot sends a deterministic report.",
        "Failed audits include a retry button. History is retained for 30 days and can be removed with /forget.",
        "Long reports arrive as Markdown files.",
      ].join("\n");
    case "privacy":
      return [
        "Kaseobot is private and available only to allowlisted Telegram users.",
        "Kaseobot stores your Telegram user ID, chat ID, submitted URL, job status, normalized findings, raw static-audit output, generated report Markdown, and report metadata in D1 so it can run and show your audits. GEO audits can inspect up to five same-origin static HTML pages.",
        "Audit results expire after 30 days and the daily cleanup removes them within 24 hours of expiry. Use /history to view recent audits or /forget to immediately delete your saved jobs and results. /forget cannot recall copies already delivered in Telegram or data already sent to NVIDIA for analysis.",
        "When AI analysis is configured, only a filtered summary, GEO page counts/scores for GEO audits, and up to 25 failed or warning findings are sent to NVIDIA's hosted Kimi K3. Telegram IDs, raw webhook data, and raw audit-engine output are not sent to Kimi. If Kimi is unavailable, Kaseobot sends a deterministic report from the audit findings.",
        "SEOmator buttons open its external public tools. Kaseobot does not submit your URL or retrieve the external result automatically.",
      ].join("\n\n");
    default:
      return "I don't recognize /" + command.name + ". Use /help to see available commands.";
  }
}

function jsonResponse(body: unknown, status = 200): Response {
  return new Response(JSON.stringify(body), {
    status,
    headers: {
      "content-type": "application/json; charset=utf-8",
      "cache-control": "no-store",
    },
  });
}

async function secretsMatch(expected: string | undefined, actual: string | null): Promise<boolean> {
  if (!expected || actual === null) return false;

  const encoder = new TextEncoder();
  const [expectedDigest, actualDigest] = await Promise.all([
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(expected)),
    crypto.subtle.digest("SHA-256", new TextEncoder().encode(actual)),
  ]);

  const expectedBytes = new Uint8Array(expectedDigest);
  const actualBytes = new Uint8Array(actualDigest);
  let difference = 0;
  for (let index = 0; index < expectedBytes.length; index += 1) {
    difference |= expectedBytes[index] ^ actualBytes[index];
  }
  return difference === 0;
}

function isAllowedUser(userId: number, allowlist: string | undefined): boolean {
  if (!Number.isSafeInteger(userId) || userId <= 0) return false;
  const allowedIds = new Set(
    (allowlist ?? "")
      .split(",")
      .map((id) => id.trim())
      .filter((id) => /^\d+$/.test(id)),
  );
  return allowedIds.has(String(userId));
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

async function sendTelegramMessage(
  botKey: string,
  chatId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboard | TelegramReplyKeyboard,
): Promise<void> {
  try {
    await fetch("https://api.telegram.org/bot" + botKey + "/sendMessage", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        chat_id: chatId,
        text,
        ...(replyMarkup ? { reply_markup: replyMarkup } : {}),
      }),
    });
  } catch {
    // Do not log the exception: request URLs can contain the bot token.
  }
}

async function registerBotCommands(botKey: string): Promise<void> {
  try {
    await fetch("https://api.telegram.org/bot" + botKey + "/setMyCommands", {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ commands: BOT_COMMANDS }),
    });
  } catch {
    // Best effort; commands are a nice-to-have, not required for bot function.
  }
}

/*────────────────────────────────────────────────────────────────────────────
  User state (two-step URL flow)
────────────────────────────────────────────────────────────────────────────*/

type PendingUrl = { kind: "audit" | "geo"; jobId?: string };

async function getUserState(db: D1DatabaseLike, userId: string): Promise<string | null> {
  try {
    const row = await db.prepare(`SELECT state FROM user_state WHERE telegram_user_id = ?`)
      .bind(userId)
      .first<{ state: string }>();
    return row?.state ?? null;
  } catch {
    return null;
  }
}

async function setUserState(db: D1DatabaseLike, userId: string, state: string | null): Promise<void> {
  try {
    if (state === null) {
      await db.prepare(`DELETE FROM user_state WHERE telegram_user_id = ?`).bind(userId).run();
      return;
    }
    await db.prepare(`INSERT INTO user_state (telegram_user_id, state, updated_at) VALUES (?, ?, ?)
      ON CONFLICT(telegram_user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
      .bind(userId, state, new Date().toISOString())
      .run();
  } catch {
    // State persistence is best-effort; the URL flow still works without it.
  }
}

function parsePendingUrl(state: string | null): PendingUrl | null {
  if (state === "awaiting_url:audit") return { kind: "audit" };
  if (state === "awaiting_url:geo") return { kind: "geo" };
  return null;
}

/*────────────────────────────────────────────────────────────────────────────
  Message sending with optional reply keyboard
────────────────────────────────────────────────────────────────────────────*/

async function sendWithMenu(
  env: Env,
  chatId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboard | TelegramReplyKeyboard,
): Promise<void> {
  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN ?? "", chatId, text, replyMarkup);
}

/*────────────────────────────────────────────────────────────────────────────
  Jobs view — in-progress audits
────────────────────────────────────────────────────────────────────────────*/

async function buildJobsView(
  db: D1DatabaseLike,
  userId: number,
  now = Date.now(),
): Promise<{ text: string; replyMarkup: TelegramInlineKeyboard }> {
  const jobs = await getJobsForUser(db, String(userId), ["queued", "running", "cancel_requested"]);
  const items = jobs.map((job) => {
    const createdMs = Date.parse(job.created_at);
    const elapsed = Number.isFinite(createdMs)
      ? formatElapsed(Math.max(0, now - createdMs))
      : "unknown";
    return {
      job_id: job.job_id,
      url: job.url,
      status: job.status,
      type: job.type,
      created_at: job.created_at,
      elapsed,
    };
  });
  return {
    text: jobsMessage(items),
    replyMarkup: jobsKeyboard(),
  };
}

function formatElapsed(milliseconds: number): string {
  const seconds = Math.floor(milliseconds / 1000);
  if (seconds < 60) return `${seconds}s`;
  const minutes = Math.floor(seconds / 60);
  if (minutes < 60) return `${minutes}m ${seconds % 60}s`;
  const hours = Math.floor(minutes / 60);
  return `${hours}h ${minutes % 60}m`;
}

/*────────────────────────────────────────────────────────────────────────────
  Authorized message handling
────────────────────────────────────────────────────────────────────────────*/

async function handleAuthorizedMessage(
  env: Env,
  message: TelegramMessage,
  userId: number,
  chatId: number,
  updateId: number | null,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const db: D1DatabaseLike = env.DB!;
  if (!db) return;
  await ensureUser(db, String(userId));

  const rawText = typeof message.text === "string" ? message.text.trim() : "";
  const command = rawText ? parseTelegramCommand(rawText) : null;

  // --- URL state machine: plain text while awaiting a URL ---
  if (command === null && rawText.length > 0) {
    const state = await getUserState(db, String(userId));
    const pending = parsePendingUrl(state);
    if (pending) {
      await setUserState(db, String(userId), null);
      const validated = validateAndNormalizeUrl(rawText);
      if (!validated.ok) {
        await sendWithMenu(env, chatId, validated.error, mainMenuKeyboard());
        return;
      }
      const result = await createAuditJob(env, {
        telegramUserId: userId,
        chatId,
        url: validated.url,
        updateId,
        type: pending.kind === "geo" ? "geo_audit" : "seo_audit",
      });
      const type = pending.kind === "geo" ? "geo_audit" : "seo_audit";
      const maxPages = clampGeoPageLimit(env.GEO_MAX_PAGES);
      const ack = jobAcknowledgment(result.job.job_id, result.job.url, result.job.status, type, maxPages);
      await sendWithMenu(env, chatId, ack, result.job.status === "failed" ? retryKeyboard(result.job.job_id) : jobAckKeyboard(result.job.job_id));
      return;
    }
  }

  // --- Button labels route to the same handlers as slash commands ---
  if (command === null) {
    const mapped = menuLabelToCommand(rawText);
    if (mapped) {
      if (mapped === "/status") {
        await sendWithMenu(env, chatId, "Send /status <job_id> to check a specific job, or tap /jobs to see in-progress audits.", mainMenuKeyboard());
        return;
      }
      if (mapped === "/cancel") {
        await sendWithMenu(env, chatId, "Send /cancel <job_id> to cancel a specific job.", mainMenuKeyboard());
        return;
      }
      if (mapped === "/jobs") {
        const { text, replyMarkup } = await buildJobsView(db, userId);
        await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, replyMarkup);
        return;
      }
      await routeMappedCommand(env, mapped.slice(1), chatId, userId, updateId, mainMenuKeyboard());
      return;
    }
    await sendWithMenu(env, chatId, "Tap a button below, or send /help to see available commands.", mainMenuKeyboard());
    return;
  }

  let reply: string;
  let replyMarkup: TelegramInlineKeyboard | TelegramReplyKeyboard | undefined;
  try {
    if (command.name === "start") {
      const { text, replyMarkup: markup } = welcomeMessage();
      reply = text;
      replyMarkup = markup;
    } else if (command.name === "help") {
      const { text, replyMarkup: markup } = helpMessage();
      reply = text;
      replyMarkup = markup;
    } else if (command.name === "jobs") {
      const { text, replyMarkup: markup } = await buildJobsView(db, userId);
      reply = text;
      replyMarkup = markup;
    } else if (command.name === "audit") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error + "\n\nSend me the URL to audit, or tap Start Audit again.";
        await setUserState(db, String(userId), "awaiting_url:audit");
        replyMarkup = mainMenuKeyboard();
      } else {
        const result = await createAuditJob(env, {
          telegramUserId: userId,
          chatId,
          url: validated.url,
          updateId,
        });
        reply = jobAcknowledgment(result.job.job_id, result.job.url, result.job.status);
        if (result.job.status === "failed") replyMarkup = retryKeyboard(result.job.job_id);
        else replyMarkup = jobAckKeyboard(result.job.job_id);
      }
    } else if (command.name === "geo") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error + "\n\nSend me the URL to crawl, or tap GEO Crawl again.";
        await setUserState(db, String(userId), "awaiting_url:geo");
        replyMarkup = mainMenuKeyboard();
      } else {
        const result = await createAuditJob(env, {
          telegramUserId: userId,
          chatId,
          url: validated.url,
          updateId,
          type: "geo_audit",
        });
        reply = jobAcknowledgment(
          result.job.job_id,
          result.job.url,
          result.job.status,
          "geo_audit",
          clampGeoPageLimit(env.GEO_MAX_PAGES),
        );
        if (result.job.status === "failed") replyMarkup = retryKeyboard(result.job.job_id);
        else replyMarkup = jobAckKeyboard(result.job.job_id);
      }
    } else if (command.name === "keywords") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error;
      } else {
        const engineResult = await createAuditEngine().auditPage({
          url: validated.url,
          timeoutMs: 20000,
          includeJavaScriptRendering: false,
          includeCoreWebVitals: false,
        });
        const audit = normalizeAuditResult({
          jobId: crypto.randomUUID(),
          auditId: crypto.randomUUID(),
          type: "seo_audit",
          url: validated.url,
          requestedBy: String(userId),
          startedAt: new Date().toISOString(),
          engineResult,
        });
        reply = buildKeywordSummary(audit);
        replyMarkup = mainMenuKeyboard();
      }
    } else if (command.name === "deepaudit") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error;
      } else if (!env.SEOMATOR_CONTAINER) {
        reply = "Deep audit engine (SEOmator Container) is not configured. Use /audit for static checks or /seomator for external tools.";
      } else {
        // Parse options from args for storage in pending deep-audit state.
        const args = command.args.split(/\s+/);
        const options: Record<string, unknown> = { url: validated.url };
        for (const arg of args.slice(1)) {
          if (arg.startsWith("--type=")) options.auditType = arg.slice(7);
          else if (arg.startsWith("--categories=")) options.categories = arg.slice(13);
          else if (arg === "--crawl") options.crawl = true;
          else if (arg.startsWith("--max-pages=")) options.maxPages = parseInt(arg.slice(12), 10);
          else if (arg === "--mobile") options.mobile = true;
          else if (arg.startsWith("--concurrency=")) options.concurrency = parseInt(arg.slice(14), 10);
          else if (arg.startsWith("--timeout=")) options.timeout = parseInt(arg.slice(10), 10);
          else if (arg.startsWith("--user-agent=")) options.userAgent = arg.slice(13);
        }
        const jobId = crypto.randomUUID();
        await db.prepare(`INSERT INTO user_state (telegram_user_id, state, updated_at) VALUES (?, ?, ?)
          ON CONFLICT(telegram_user_id) DO UPDATE SET state = excluded.state, updated_at = excluded.updated_at`)
          .bind(String(userId), `awaiting_deep_confirm:${jobId}:${JSON.stringify(options)}`, new Date().toISOString())
          .run();
        reply = deepAuditCostMessage(validated.url, jobId);
        replyMarkup = deepAuditConfirmKeyboard(jobId);
      }
    } else if (command.name === "status") {
      reply = await getJobStatusMessage(db, command.args || undefined, userId);
      replyMarkup = mainMenuKeyboard();
    } else if (command.name === "cancel") {
      reply = await cancelAuditJob(db, command.args || undefined, userId);
      replyMarkup = mainMenuKeyboard();
    } else if (command.name === "watch") {
      if (!command.args || command.args.trim().length === 0) {
        const watches = await listWatchedUrls(db, String(userId));
        if (watches.length === 0) {
          reply = `You're not watching any sites yet.\n\nSend /watch <url> to start monitoring a site for changes.\n\nExample: /watch https://example.com`;
        } else {
          reply = `Watching ${watches.length} site${watches.length === 1 ? '' : 's'}. Tap Remove next to one to stop watching it:`;
        }
        replyMarkup = watchesKeyboard(watches);
      } else {
        const validated = validateAndNormalizeUrl(command.args);
        if (!validated.ok) {
          reply = validated.error;
        } else {
          const { created, watchId } = await addWatchedUrl(db, String(userId), validated.url);
          reply = created
            ? `Watching ${validated.url}. Watch ID: ${watchId}\n\nI'll check it on a schedule and alert you if anything changes.`
            : `You are already watching ${validated.url}. Watch ID: ${watchId}\n\nUse /unwatch <url> to stop watching it.`;
          replyMarkup = watchAckKeyboard(watchId);
        }
      }
    } else if (command.name === "unwatch") {
      if (!command.args || command.args.trim().length === 0) {
        const watches = await listWatchedUrls(db, String(userId));
        if (watches.length === 0) {
          reply = `You're not watching any sites.\n\nSend /watch <url> to start monitoring a site.`;
        } else {
          reply = `Watching ${watches.length} site${watches.length === 1 ? '' : 's'}. Tap Remove next to one to stop watching it:`;
        }
        replyMarkup = watchesKeyboard(watches);
      } else {
        const { removed } = await removeWatchedUrl(db, String(userId), command.args.trim());
        reply = removed
          ? `Stopped watching ${command.args.trim()}.`
          : `I wasn't watching ${command.args.trim()}. Use /watch <url> to start watching it.`;
        replyMarkup = mainMenuKeyboard();
      }
    } else if (command.name === "history") {
      reply = formatHistory(await getUserHistory(db, String(userId)));
      replyMarkup = mainMenuKeyboard();
    } else if (command.name === "forget") {
      await forgetUserHistory(db, String(userId));
      reply = "Your saved audit history and reports have been deleted. This cannot remove copies already delivered in Telegram or information already sent to NVIDIA.";
      replyMarkup = mainMenuKeyboard();
    } else if (command.name === "seomator") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error;
      } else {
        reply = "Open SEOmator's hosted tools for this website:\n" + validated.url + "\n\nChoose a tool below. SEOmator runs it on its website; Kaseobot does not submit the URL or store that external audit.";
        replyMarkup = seomatorKeyboard();
      }
    } else if (command.name === "privacy") {
      reply = routeCommand(command);
      replyMarkup = mainMenuKeyboard();
    } else {
      reply = routeCommand(command);
      replyMarkup = mainMenuKeyboard();
    }
  } catch (error) {
    reply = error instanceof UserFacingError
      ? error.message
      : "I couldn't complete that request right now. Please try again later.";
  }

  await sendWithMenu(env, chatId, reply, replyMarkup);
}

async function routeMappedCommand(
  env: Env,
  name: string,
  chatId: number,
  userId: number,
  updateId: number | null,
  replyMarkup: TelegramReplyKeyboard,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN || !env.DB) return;
  switch (name) {
    case "start":
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, welcomeMessage().text, replyMarkup);
      break;
    case "help":
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, helpMessage().text, replyMarkup);
      break;
    case "jobs": {
      const { text, replyMarkup: markup } = await buildJobsView(env.DB, userId);
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, text, markup);
      break;
    }
    case "privacy":
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, routeCommand({ name: "privacy", args: "" }), replyMarkup);
      break;
    default:
      await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, "Use /" + name + " <url> to run that command.", replyMarkup);
  }
}

/*────────────────────────────────────────────────────────────────────────────
  Callback query handling (inline buttons)
────────────────────────────────────────────────────────────────────────────*/

async function handleRetryCallback(
  env: Env,
  callbackQueryId: string,
  callbackData: unknown,
  userId: number,
  chatId: number,
  updateId: number | null,
): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey) return;
  const match = typeof callbackData === "string" && new TextEncoder().encode(callbackData).byteLength <= 64
    ? /^retry:([a-z0-9_-]{1,48})$/i.exec(callbackData)
    : null;
  if (!match) {
    await answerCallbackQuery(botKey, callbackQueryId, "This button is no longer available.");
    return;
  }
  if (!env.DB || !env.AUDIT_QUEUE) {
    await answerCallbackQuery(botKey, callbackQueryId, "Retry is temporarily unavailable.", true);
    return;
  }

  try {
    const job = await getJobForUser(env.DB, match[1], String(userId));
    if (!job || job.status !== "failed") {
      await answerCallbackQuery(botKey, callbackQueryId, "This retry is no longer available.");
      return;
    }
    const validated = validateAndNormalizeUrl(job.url);
    if (!validated.ok) {
      await answerCallbackQuery(botKey, callbackQueryId, "The saved URL is no longer valid.", true);
      return;
    }
    const retried = await createAuditJob(env, {
      telegramUserId: userId,
      chatId,
      url: validated.url,
      type: job.type,
      updateId,
    });
    const message = jobAcknowledgment(
      retried.job.job_id,
      retried.job.url,
      retried.job.status,
      retried.job.type,
      clampGeoPageLimit(env.GEO_MAX_PAGES),
    );
    await answerCallbackQuery(
      botKey,
      callbackQueryId,
      retried.job.status === "queued" ? "Retry queued." : "A new job was created but could not be queued.",
    );
    await sendTelegramMessage(
      botKey,
      chatId,
      message,
      retried.job.status === "failed" ? retryKeyboard(retried.job.job_id) : jobAckKeyboard(retried.job.job_id),
    );
  } catch (error) {
    const message = error instanceof UserFacingError ? error.message : "Retry could not be started. Please try again later.";
    await answerCallbackQuery(botKey, callbackQueryId, message, true);
  }
}

async function handleStatusCallback(env: Env, jobId: string, userId: number, callbackQueryId: string, chatId: number): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey || !env.DB) {
    if (botKey) await answerCallbackQuery(botKey, callbackQueryId, "Status is temporarily unavailable.", true);
    return;
  }
  const statusText = await getJobStatusMessage(env.DB, jobId, userId);
  await answerCallbackQuery(botKey, callbackQueryId, statusText.slice(0, 200), true);
  await sendTelegramMessage(botKey, chatId, statusText, mainMenuKeyboard());
}

async function handleCancelCallback(env: Env, jobId: string, userId: number, callbackQueryId: string, chatId: number): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey || !env.DB) {
    if (botKey) await answerCallbackQuery(botKey, callbackQueryId, "Cancel is temporarily unavailable.", true);
    return;
  }
  const result = await cancelAuditJob(env.DB, jobId, userId);
  await answerCallbackQuery(botKey, callbackQueryId, result);
  await sendTelegramMessage(botKey, chatId, result, mainMenuKeyboard());
}

async function handleDeepConfirmCallback(
  env: Env,
  jobId: string,
  userId: number,
  callbackQueryId: string,
  chatId: number,
  proceed: boolean,
): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey || !env.DB || !env.SEOMATOR_CONTAINER) {
    if (botKey) await answerCallbackQuery(botKey, callbackQueryId, "Deep audit is temporarily unavailable.", true);
    return;
  }

  const userIdStr = String(userId);
  const row = await env.DB.prepare(`SELECT state FROM user_state WHERE telegram_user_id = ?`)
    .bind(userIdStr)
    .first<{ state: string }>();
  const state = row?.state ?? null;
  const match = state ? /^awaiting_deep_confirm:([a-z0-9-]+):(.+)$/s.exec(state) : null;
  if (!match || match[1] !== jobId) {
    await answerCallbackQuery(botKey, callbackQueryId, "This deep-audit confirmation is no longer available.");
    return;
  }

  if (!proceed) {
    await env.DB.prepare(`DELETE FROM user_state WHERE telegram_user_id = ?`).bind(userIdStr).run();
    await answerCallbackQuery(botKey, callbackQueryId, "Deep audit cancelled.");
    await sendTelegramMessage(botKey, chatId, "Deep audit cancelled. Tap Start Audit for a static SEO audit instead.", mainMenuKeyboard());
    return;
  }

  let options: Record<string, unknown>;
  try {
    options = JSON.parse(match[2]);
  } catch {
    await env.DB.prepare(`DELETE FROM user_state WHERE telegram_user_id = ?`).bind(userIdStr).run();
    await answerCallbackQuery(botKey, callbackQueryId, "The deep-audit options could not be read.", true);
    return;
  }

  // Clear state before the long container call.
  await env.DB.prepare(`DELETE FROM user_state WHERE telegram_user_id = ?`).bind(userIdStr).run();
  await answerCallbackQuery(botKey, callbackQueryId, "Deep audit started.");

  const url = typeof options.url === "string" ? options.url : "";
  const validated = validateAndNormalizeUrl(url);
  if (!validated.ok) {
    await sendTelegramMessage(botKey, chatId, "That URL is no longer valid.", mainMenuKeyboard());
    return;
  }

  const controller = new AbortController();
  const timeoutMs = 300000;
  const timeoutId = setTimeout(() => controller.abort(), timeoutMs);
  try {
    const stub = env.SEOMATOR_CONTAINER.get(env.SEOMATOR_CONTAINER.idFromName("seomator"));
    const response = await stub.fetch("http://container/audit", {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(options),
      signal: controller.signal,
    });
    clearTimeout(timeoutId);
    if (!response.ok) {
      const err = await response.text();
      const text = /workers paid|unauthorized|entitlement/i.test(err)
        ? "Deep audit needs the Cloudflare Workers Paid plan ($5/mo) - Cloudflare Containers has no free tier. /audit and /geo work on the free plan."
        : "Deep audit failed (" + response.status + "): " + err.slice(0, 200);
      await sendTelegramMessage(botKey, chatId, text, mainMenuKeyboard());
    } else {
      const markdown = await response.text();
      await sendTelegramMessage(botKey, chatId, markdown, mainMenuKeyboard());
    }
  } catch (err: unknown) {
    clearTimeout(timeoutId);
    const message = err instanceof Error ? err.message : String(err);
    const text = /workers paid|unauthorized|entitlement/i.test(message)
      ? "Deep audit needs the Cloudflare Workers Paid plan ($5/mo) - Cloudflare Containers has no free tier. /audit and /geo work on the free plan."
      : "Deep audit error: " + message;
    await sendTelegramMessage(botKey, chatId, text, mainMenuKeyboard());
  }
}

async function handleJobsCallback(env: Env, userId: number, callbackQueryId: string, chatId: number): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey || !env.DB) {
    if (botKey) await answerCallbackQuery(botKey, callbackQueryId, "Jobs view is temporarily unavailable.", true);
    return;
  }
  const { text, replyMarkup } = await buildJobsView(env.DB, userId);
  await answerCallbackQuery(botKey, callbackQueryId, "Jobs updated.");
  await sendTelegramMessage(botKey, chatId, text, replyMarkup);
}

async function handleJobsMenuCallback(env: Env, callbackQueryId: string, chatId: number): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey) return;
  await answerCallbackQuery(botKey, callbackQueryId, "Main menu.");
  await sendTelegramMessage(botKey, chatId, welcomeMessage().text, welcomeMessage().replyMarkup);
}

async function handleRemoveWatchCallback(
  env: Env,
  callbackQueryId: string,
  watchId: string,
  userId: number,
  chatId: number,
): Promise<void> {
  const botKey = env.TELEGRAM_BOT_TOKEN;
  if (!botKey || !env.DB) {
    if (botKey) await answerCallbackQuery(botKey, callbackQueryId, "Watch management is temporarily unavailable.", true);
    return;
  }

  const result = await removeWatchedUrlById(env.DB, String(userId), watchId);
  if (result.removed) {
    const watches = await listWatchedUrls(env.DB, String(userId));
    await answerCallbackQuery(botKey, callbackQueryId, "Watching stopped.");
    if (watches.length === 0) {
      await sendTelegramMessage(botKey, chatId, "You're not watching any sites anymore.", mainMenuKeyboard());
    } else {
      await sendTelegramMessage(botKey, chatId, `Watching ${watches.length} site${watches.length === 1 ? '' : 's'}. Tap Remove next to one to stop watching it:`, watchesKeyboard(watches));
    }
  } else {
    await answerCallbackQuery(botKey, callbackQueryId, "Couldn't stop watching that site.", true);
  }
}

async function handleWebhook(
  request: Request,
  env: Env,
  context: ExecutionContextLike,
): Promise<Response> {
  if (!env.TELEGRAM_WEBHOOK_SECRET) return jsonResponse({ ok: false }, 503);
  const secretMatches = await secretsMatch(
    env.TELEGRAM_WEBHOOK_SECRET,
    request.headers.get("X-Telegram-Bot-Api-Secret-Token"),
  );
  if (!secretMatches) return jsonResponse({ ok: false }, 401);

  let update: unknown;
  try {
    update = await request.json();
  } catch {
    return jsonResponse({ ok: false }, 400);
  }
  if (!isRecord(update)) return jsonResponse({ ok: false }, 400);

  if (isRecord(update.callback_query)) {
    const query = update.callback_query;
    const queryId = typeof query.id === "string" ? query.id : "";
    const from = isRecord(query.from) ? query.from : null;
    const callbackMessage = isRecord(query.message) ? query.message : null;
    const chat = callbackMessage && isRecord(callbackMessage.chat) ? callbackMessage.chat : null;
    const userId = from?.id;
    const chatId = chat?.id;
    const authorized = typeof userId === "number" && Number.isSafeInteger(userId) &&
      typeof chatId === "number" && Number.isSafeInteger(chatId) && chat?.type === "private" &&
      chatId === userId && from?.is_bot !== true && isAllowedUser(userId, env.ALLOWED_TELEGRAM_USER_IDS);
    if (queryId && env.TELEGRAM_BOT_TOKEN && authorized) {
      const data = query.data;
      if (typeof data === "string") {
        if (/^retry:/.test(data)) {
          context.waitUntil(handleRetryCallback(env, queryId, data, userId as number, chatId as number, updateIdFrom(update)));
        } else if (/^stat:/.test(data)) {
          const jobId = data.slice(5);
          context.waitUntil(handleStatusCallback(env, jobId, userId as number, queryId, chatId as number));
        } else if (/^cncl:/.test(data) && !/^cncl:deep:/.test(data)) {
          const jobId = data.slice(5);
          context.waitUntil(handleCancelCallback(env, jobId, userId as number, queryId, chatId as number));
        } else if (/^cnfm:deep:/.test(data)) {
          const jobId = data.slice(11);
          context.waitUntil(handleDeepConfirmCallback(env, jobId, userId as number, queryId, chatId as number, true));
        } else if (/^cncl:deep:/.test(data)) {
          const jobId = data.slice(10);
          context.waitUntil(handleDeepConfirmCallback(env, jobId, userId as number, queryId, chatId as number, false));
        } else if (/^more:/.test(data)) {
          const parts = data.split(":");
          const jobId = parts[1];
          const nextOffset = parts[2] ? parseInt(parts[2], 10) : 0;
          context.waitUntil(answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "More fixes coming in the next update."));
        } else if (/^rpt:/.test(data)) {
          const jobId = data.slice(4);
          context.waitUntil(answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Full report: use /status " + jobId));
        } else if (/^del:/.test(data)) {
          const jobId = data.slice(4);
          context.waitUntil(answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Deleted job " + jobId));
        } else if (data === "hist:me") {
          context.waitUntil(answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Use /history or tap View History."));
        } else if (data === "forget:confirm") {
          context.waitUntil(answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Tap Confirm delete to erase all your data."));
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId as number, "Delete all your data?", forgetConfirmKeyboard());
        } else if (data === "forget:yes") {
          if (env.DB) {
            await forgetUserHistory(env.DB, String(userId));
            await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Your data has been deleted.");
            await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId as number, "Your saved audit history and reports have been deleted.", mainMenuKeyboard());
          } else {
            await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Data deletion is temporarily unavailable.", true);
          }
        } else if (data === "forget:no") {
          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Deletion cancelled.");
        } else if (data === "priv:info") {
          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Use /privacy for full details.");
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId as number, routeCommand({ name: "privacy", args: "" }), mainMenuKeyboard());
        } else if (data === "aud:quick") {
          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "Tap Start Audit for a static SEO audit.");
          await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId as number, "Tap Start Audit below for a static SEO audit (~0.5s).", mainMenuKeyboard());
        } else if (data === "jobs:refresh") {
          context.waitUntil(handleJobsCallback(env, userId as number, queryId, chatId as number));
        } else if (/^rmwatch:/.test(data)) {
          const watchId = data.slice(8);
          context.waitUntil(handleRemoveWatchCallback(env, queryId, watchId, userId as number, chatId as number));
        } else if (data === "jobs:menu") {
          context.waitUntil(handleJobsMenuCallback(env, queryId, chatId as number));
        } else {
          await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "This button is no longer available.");
        }
      }
    } else if (queryId && env.TELEGRAM_BOT_TOKEN) {
      context.waitUntil(answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, queryId, "This action is not available."));
    }
    return jsonResponse({ ok: true });
  }

  const message = update.message as TelegramMessage | undefined;
  const userId = message?.from?.id;
  const chatId = message?.chat?.id;
  if (
    typeof userId !== "number" ||
    !Number.isSafeInteger(userId) ||
    typeof chatId !== "number" ||
    !Number.isSafeInteger(chatId) ||
    !isAllowedUser(userId, env.ALLOWED_TELEGRAM_USER_IDS) ||
    message?.chat?.type !== "private" ||
    message?.from?.is_bot === true
  ) {
    return jsonResponse({ ok: true });
  }

  context.waitUntil(handleAuthorizedMessage(env, message, userId, chatId, updateIdFrom(update)));
  return jsonResponse({ ok: true });
}

const worker = {
  async fetch(request: Request, env: Env, context: ExecutionContextLike): Promise<Response> {
    const { pathname } = new URL(request.url);

    if (pathname === HEALTH_PATH) {
      if (request.method !== "GET") return jsonResponse({ ok: false }, 405);
      return jsonResponse({ ok: true, service: "kaseomator" });
    }

    if (pathname === WEBHOOK_PATH) {
      if (request.method !== "POST") return jsonResponse({ ok: false }, 405);
      return handleWebhook(request, env, context);
    }

    return jsonResponse({ ok: false }, 404);
  },
  async queue(batch: MessageBatchLike<unknown>, env: Env): Promise<void> {
    await consumeAuditQueue(batch, env);
  },
  scheduled(controller: { scheduledTime: number }, env: Env, context: ExecutionContextLike): void {
    if (!env.DB) return;
    context.waitUntil(cleanupExpiredHistory(env.DB, controller.scheduledTime));
    context.waitUntil(
      runWatcher(env.DB, env).catch(() => undefined),
    );
  },
};

export default worker;
export { SeomatorContainer } from "./seomator-container";
