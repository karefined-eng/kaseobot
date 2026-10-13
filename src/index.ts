import {
  cancelAuditJob,
  createAuditJob,
  getJobForUser,
  getJobStatusMessage,
  UserFacingError,
  type AuditQueueLike,
  type D1DatabaseLike,
  type JobEnvironment,
} from "./jobs";
import { consumeAuditQueue, type MessageBatchLike } from "./queue-consumer";
import { clampGeoPageLimit } from "./audits/geo-links";
import { cleanupExpiredHistory, forgetUserHistory, getUserHistory } from "./history";
import {
  answerCallbackQuery,
  formatHistory,
  retryKeyboard,
  seomatorKeyboard,
  updateIdFrom,
  type TelegramInlineKeyboard,
} from "./telegram-ui";
import { validateAndNormalizeUrl } from "./url-validation";

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
      return "Welcome to Kaseobot.\n\nUse /help to see available commands.";
    case "help":
      return [
        "Kaseobot commands:",
        "/start — start the bot",
        "/help — show this help",
        "/audit <url> — enqueue a one-page SEO audit",
        "/geo <url> — enqueue a GEO crawl of up to five same-origin pages",
        "/status <job_id> — check an audit job",
        "/cancel <job_id> — cancel a queued job",
        "/history — list your recent audits",
        "/forget — delete your saved audit history",
        "/seomator <url> — open SEOmator’s external SEO/GEO tools",
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
      return `I don't recognize /${command.name}. Use /help to see available commands.`;
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
    crypto.subtle.digest("SHA-256", encoder.encode(expected)),
    crypto.subtle.digest("SHA-256", encoder.encode(actual)),
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
  token: string,
  chatId: number,
  text: string,
  replyMarkup?: TelegramInlineKeyboard,
): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/sendMessage`, {
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

function jobAcknowledgment(
  jobId: string,
  url: string,
  status: string,
  type: "seo_audit" | "geo_audit" = "seo_audit",
  maxPages = 5,
): string {
  const label = type === "geo_audit" ? "GEO audit" : "SEO audit";
  if (status === "failed") {
    return `The ${label.toLowerCase()} job could not be queued or processed.\nWebsite: ${url}\nJob ID: ${jobId}\nUse /status ${jobId} for details.`;
  }
  const crawlNote = type === "geo_audit" ? `\nCrawling up to ${maxPages} same-origin pages.` : "";
  return `${label} job accepted.\nWebsite: ${url}\nJob ID: ${jobId}\nStatus: ${status}${crawlNote}\nUse /status ${jobId} to check progress.`;
}

async function handleAuthorizedMessage(
  env: Env,
  message: TelegramMessage,
  userId: number,
  chatId: number,
  updateId: number | null,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;

  const command = typeof message.text === "string" ? parseTelegramCommand(message.text) : null;
  let reply: string;
  let replyMarkup: TelegramInlineKeyboard | undefined;
  try {
    if (!command) {
      reply = "Please use a slash command. Send /help to see available commands.";
    } else if (command.name === "audit") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error;
      } else {
        const result = await createAuditJob(env, {
          telegramUserId: userId,
          chatId,
          url: validated.url,
          updateId,
        });
        reply = jobAcknowledgment(result.job.job_id, result.job.url, result.job.status);
        if (result.job.status === "failed") replyMarkup = retryKeyboard(result.job.job_id);
      }
    } else if (command.name === "geo") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error;
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
      }
    } else if (command.name === "status") {
      reply = await getJobStatusMessage(env.DB, command.args || undefined, userId);
    } else if (command.name === "cancel") {
      reply = await cancelAuditJob(env.DB, command.args || undefined, userId);
    } else if (command.name === "history") {
      if (!env.DB) throw new Error("Audit storage is not configured.");
      reply = formatHistory(await getUserHistory(env.DB, String(userId)));
    } else if (command.name === "forget") {
      if (!env.DB) throw new Error("Audit storage is not configured.");
      await forgetUserHistory(env.DB, String(userId));
      reply = "Your saved audit history and reports have been deleted. This cannot remove copies already delivered in Telegram or information already sent to NVIDIA.";
    } else if (command.name === "seomator") {
      const validated = validateAndNormalizeUrl(command.args);
      if (!validated.ok) {
        reply = validated.error;
      } else {
        reply = `Open SEOmator’s hosted tools for this website:\n${validated.url}\n\nChoose a tool below. SEOmator runs it on its website; Kaseobot does not submit the URL or store that external audit.`;
        replyMarkup = seomatorKeyboard();
      }
    } else {
      reply = routeCommand(command);
    }
  } catch (error) {
    reply = error instanceof UserFacingError
      ? error.message
      : "I couldn't complete that request right now. Please try again later.";
  }

  await sendTelegramMessage(env.TELEGRAM_BOT_TOKEN, chatId, reply, replyMarkup);
}

async function handleRetryCallback(
  env: Env,
  callbackQueryId: string,
  callbackData: unknown,
  userId: number,
  chatId: number,
  updateId: number | null,
): Promise<void> {
  if (!env.TELEGRAM_BOT_TOKEN) return;
  const match = typeof callbackData === "string" && new TextEncoder().encode(callbackData).byteLength <= 64
    ? /^retry:([a-z0-9_-]{1,48})$/i.exec(callbackData)
    : null;
  if (!match) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQueryId, "This button is no longer available.");
    return;
  }
  if (!env.DB || !env.AUDIT_QUEUE) {
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQueryId, "Retry is temporarily unavailable.", true);
    return;
  }

  try {
    const job = await getJobForUser(env.DB, match[1], String(userId));
    if (!job || job.status !== "failed") {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQueryId, "This retry is no longer available.");
      return;
    }
    const validated = validateAndNormalizeUrl(job.url);
    if (!validated.ok) {
      await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQueryId, "The saved URL is no longer valid.", true);
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
      env.TELEGRAM_BOT_TOKEN,
      callbackQueryId,
      retried.job.status === "queued" ? "Retry queued." : "A new job was created but could not be queued.",
    );
    await sendTelegramMessage(
      env.TELEGRAM_BOT_TOKEN,
      chatId,
      message,
      retried.job.status === "failed" ? retryKeyboard(retried.job.job_id) : undefined,
    );
  } catch (error) {
    const message = error instanceof UserFacingError ? error.message : "Retry could not be started. Please try again later.";
    await answerCallbackQuery(env.TELEGRAM_BOT_TOKEN, callbackQueryId, message, true);
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
      context.waitUntil(handleRetryCallback(env, queryId, query.data, userId as number, chatId as number, updateIdFrom(update)));
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
    message?.from?.is_bot === true ||
    typeof message.text !== "string"
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
      return jsonResponse({ ok: true, service: "kaseobot" });
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
  },
};

export default worker;
