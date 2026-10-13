import type { UserHistoryItem } from "./history";

export interface TelegramInlineKeyboard {
  inline_keyboard: Array<Array<{ text: string; url?: string; callback_data?: string }>>;
}

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

export function formatHistory(items: UserHistoryItem[]): string {
  if (items.length === 0) return "You have no saved audits in the last 30 days.";
  const lines = items.map((item) => {
    const url = item.url.length > 180 ? `${item.url.slice(0, 177)}...` : item.url;
    const when = item.created_at.replace("T", " ").slice(0, 16);
    const label = item.type === "geo_audit" ? "GEO" : "SEO";
    const score = item.overall_score === null ? "" : ` · ${item.overall_score}/100`;
    return `• ${label} · ${item.status}${score}\n  ${url}\n  ${when} · /status ${item.job_id}`;
  });
  return `Your recent audits (up to 10):\n\n${lines.join("\n\n")}\n\nUse /forget to delete your saved audit history.`;
}

export async function answerCallbackQuery(token: string, callbackQueryId: string, text?: string, showAlert = false): Promise<void> {
  try {
    await fetch(`https://api.telegram.org/bot${token}/answerCallbackQuery`, {
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
