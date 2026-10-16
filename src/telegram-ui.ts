import type { UserHistoryItem } from "./history";

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
}

export interface TelegramReplyKeyboard {
  keyboard: Array<Array<{ text: string }>>;
  resize_keyboard?: boolean;
  one_time_keyboard?: boolean;
  input_field_placeholder?: string;
}

/*────────────────────────────────────────────────────────────────────────────
  Persistent reply keyboard — primary UI
────────────────────────────────────────────────────────────────────────────*/

export function mainMenuKeyboard(): TelegramReplyKeyboard {
  return {
    keyboard: [
      [{ text: "Start Audit" }, { text: "Check Status" }],
      [{ text: "GEO Crawl" }, { text: "View History" }],
      [{ text: "Your Data" }, { text: "Privacy" }, { text: "Help" }],
    ],
    resize_keyboard: true,
    one_time_keyboard: false,
    input_field_placeholder: "Tap a button, or send /help",
  };
}

export function jobsKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Refresh", callback_data: "jobs:refresh" }],
      [{ text: "Main menu", callback_data: "jobs:menu" }],
    ],
  };
}

export function menuLabelToCommand(label: string): string | null {
  switch (label) {
    case "Start Audit":
      return "/audit";
    case "Check Status":
      return "/status";
    case "GEO Crawl":
      return "/geo";
    case "View History":
      return "/history";
    case "Your Data":
      return "/forget";
    case "Privacy":
      return "/privacy";
    case "Help":
      return "/help";
    default:
      return null;
  }
}

/*────────────────────────────────────────────────────────────────────────────
  Inline keyboards — contextual actions on individual messages
────────────────────────────────────────────────────────────────────────────*/

export function retryKeyboard(jobId: string): TelegramInlineKeyboard {
  return { inline_keyboard: [[{ text: "Retry audit", callback_data: `retry:${jobId}` }]] };
}

export function seomatorKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Open SEOmator SEO Audit", url: "https://seomator.com/free-seo-audit-tool" }],
      [{ text: "Open SEOmator GEO Audit", url: "https://seomator.com/geo-audit-tool" }],
    ],
  };
}

export function jobAckKeyboard(jobId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Check status", callback_data: `stat:${jobId}` }],
      [{ text: "Cancel", callback_data: `cncl:${jobId}` }],
    ],
  };
}

export function deepAuditConfirmKeyboard(jobId: string): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Proceed", callback_data: `cnfm:deep:${jobId}` }],
      [{ text: "Switch to quick", callback_data: `aud:quick` }, { text: "Cancel", callback_data: `cncl:deep:${jobId}` }],
    ],
  };
}

export function chunkedResultsKeyboard(jobId: string, nextOffset: number): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Show more fixes", callback_data: `more:${jobId}:${nextOffset}` }],
      [{ text: "View full report", callback_data: `rpt:${jobId}` }, { text: "Delete", callback_data: `del:${jobId}` }],
    ],
  };
}

export function dataPrivacyKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "View history", callback_data: "hist:me" }],
      [{ text: "Delete all my data", callback_data: "forget:confirm" }],
      [{ text: "Privacy info", callback_data: "priv:info" }],
    ],
  };
}

export function forgetConfirmKeyboard(): TelegramInlineKeyboard {
  return {
    inline_keyboard: [
      [{ text: "Confirm delete", callback_data: "forget:yes" }, { text: "Cancel", callback_data: "forget:no" }],
    ],
  };
}

/*────────────────────────────────────────────────────────────────────────────
  Message builders (button-first, slash commands still work)
────────────────────────────────────────────────────────────────────────────*/

export function welcomeMessage(): { text: string; replyMarkup: TelegramReplyKeyboard } {
  return {
    text:
      "Welcome to Kaseobot — private SEO & GEO audit bot.\n\n" +
      "Tap a button below to start, or send a slash command such as /help.",
    replyMarkup: mainMenuKeyboard(),
  };
}

export function helpMessage(): { text: string; replyMarkup: TelegramReplyKeyboard } {
  return {
    text:
      "Kaseobot — button-first commands:\n\n" +
      "• Start Audit — enqueue a one-page SEO audit\n" +
      "• GEO Crawl — crawl up to five same-origin pages\n" +
      "• Check Status — view job progress\n" +
      "• View History — list recent audits\n" +
      "• Your Data — delete all saved data\n" +
      "• Privacy — data handling information\n" +
      "• Help — show this help\n\n" +
      "Slash commands still work: /audit <url>, /geo <url>, /deepaudit <url>, /status <id>, /cancel <id>, /history, /forget, /privacy",
    replyMarkup: mainMenuKeyboard(),
  };
}

export function jobAcknowledgment(
  jobId: string,
  url: string,
  status: string,
  type: "seo_audit" | "geo_audit" = "seo_audit",
  maxPages = 5,
): string {
  const label = type === "geo_audit" ? "GEO audit" : "SEO audit";
  if (status === "failed") {
    return "The " + label.toLowerCase() + " job could not be queued.\nWebsite: " + url + "\nJob ID: " + jobId;
  }
  const crawlNote = type === "geo_audit" ? "\nCrawling up to " + maxPages + " same-origin pages." : "";
  return label + " job accepted.\nWebsite: " + url + "\nJob ID: " + jobId + "\nStatus: " + status + crawlNote;
}

export function formatHistory(items: UserHistoryItem[]): string {
  if (items.length === 0) return "You have no saved audits in the last 30 days.";
  const lines = items.map((item) => {
    const url = item.url.length > 180 ? item.url.slice(0, 177) + "..." : item.url;
    const when = item.created_at.replace("T", " ").slice(0, 16);
    const label = item.type === "geo_audit" ? "GEO" : "SEO";
    const score = item.overall_score === null ? " · not measured" : ` · ${item.overall_score}/100`;
    return `• ${label} · ${item.status}${score}\n  ${url}\n  ${when} · /status ${item.job_id}`;
  });
  return `Your recent audits (up to 10):\n\n${lines.join("\n\n")}\n\nUse /forget to delete your saved audit history.`;
}

export function jobsMessage(jobs: Array<{ job_id: string; url: string; status: string; type: string; created_at: string; elapsed: string }>): string {
  if (jobs.length === 0) return "No audits are running or queued right now. Tap Start Audit to begin.";
  const lines = jobs.map((job) => {
    const label = job.type === "geo_audit" ? "GEO" : "SEO";
    return `• ${label} · ${job.status}\n  ${job.url}\n  ${job.elapsed} · Job ${job.job_id.slice(0, 8)}`;
  });
  return `In-progress audits (${jobs.length}):\n\n${lines.join("\n\n")}\n\nTap Check status on a job for details, or Cancel to stop it.`;
}

export function deepAuditCostMessage(url: string, jobId: string): string {
  return (
    "Full deep audit · ~100s · ~$0.004\n" +
    "Proceed on " + url + "?"
  );
}

export async function answerCallbackQuery(botKey: string, callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${botKey}/answerCallbackQuery`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({
        callback_query_id: callbackQueryId,
        ...(text ? { text: text.slice(0, 180) } : {}),
        ...(showAlert ? { show_alert: true } : {}),
      }),
    });
  } catch {
    // Best effort: never log a request URL containing the bot token.
  }
}

export function updateIdFrom(update: Record<string, unknown>): number | null {
  return typeof update.update_id === "number" && Number.isSafeInteger(update.update_id)
    ? update.update_id
    : null;
}
