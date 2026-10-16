import { createAuditEngine } from "./audits/engine";
import { PublicStaticHtmlFetcher } from "./audits/static-html-engine";
import { normalizeAuditResult } from "./audits/normalizer";
import {
  getAuditResult,
  getPreviousAuditSnapshot,
  saveAuditResult,
} from "./audits/storage";
import { compareAuditToPrevious, formatDiffSummary } from "./audits/diff";
import type { D1DatabaseLike } from "./jobs";
import { validateAndNormalizeUrl } from "./url-validation";

export interface WatchedUrl {
  watch_id: string;
  telegram_user_id: string;
  url: string;
  active: number;
  created_at: string;
  last_checked_at: string | null;
}

const WATCH_TIMEOUT_MS = 20_000;

export async function addWatchedUrl(
  db: D1DatabaseLike,
  telegramUserId: string,
  url: string,
): Promise<{ created: boolean; watchId: string }> {
  const existing = await db
    .prepare(
      `SELECT watch_id FROM watched_urls
        WHERE telegram_user_id = ? AND url = ? AND active = 1
        LIMIT 1`,
    )
    .bind(telegramUserId, url)
    .first<{ watch_id: string }>();
  if (existing) return { created: false, watchId: existing.watch_id };

  const watchId = crypto.randomUUID();
  await db
    .prepare(`INSERT INTO watched_urls
      (watch_id, telegram_user_id, url, active, created_at)
      VALUES (?, ?, ?, 1, ?)`)
    .bind(watchId, telegramUserId, url, new Date().toISOString())
    .run();
  return { created: true, watchId };
}

export async function removeWatchedUrl(
  db: D1DatabaseLike,
  telegramUserId: string,
  url: string,
): Promise<{ removed: boolean }> {
  const result = await db
    .prepare(`UPDATE watched_urls SET active = 0
      WHERE telegram_user_id = ? AND url = ? AND active = 1`)
    .bind(telegramUserId, url)
    .run();
  return { removed: (result.meta?.changes ?? 0) > 0 };
}

export async function listWatchedUrls(
  db: D1DatabaseLike,
  telegramUserId: string,
): Promise<WatchedUrl[]> {
  const result = await db
    .prepare(`SELECT watch_id, telegram_user_id, url, active, created_at, last_checked_at
      FROM watched_urls
      WHERE telegram_user_id = ? AND active = 1
      ORDER BY created_at DESC`)
    .bind(telegramUserId)
    .all<WatchedUrl>();
  return result.results ?? [];
}

async function sendTelegramMessage(
  botTokenParam: string | undefined,
  chatId: number,
  text: string,
): Promise<void> {
  if (!botTokenParam) return;
  try {
    await fetch(`https://api.telegram.org/bot${botTokenParam}/sendMessage`, {
      method: "POST",
      headers: { "content-type": "application/json" },
      body: JSON.stringify({ chat_id: chatId, text }),
    });
  } catch {
    // Best effort; never log a request URL containing the bot token.
  }
}

interface WatcherEnv {
  DB?: D1DatabaseLike;
  TELEGRAM_BOT_TOKEN?: string;
}

export async function runWatcher(
  db: D1DatabaseLike,
  env: WatcherEnv,
): Promise<{ watched: number; alerts: number }> {
  const result = await db
    .prepare(`SELECT watch_id, telegram_user_id, url, active, created_at, last_checked_at
      FROM watched_urls WHERE active = 1`)
    .all<WatchedUrl>();
  const items: WatchedUrl[] = result.results ?? [];

  const engine = createAuditEngine(new PublicStaticHtmlFetcher());
  let alerts = 0;

  for (const watch of items) {
    const validated = validateAndNormalizeUrl(watch.url);
    if (!validated.ok) continue;

    try {
      const page = await new PublicStaticHtmlFetcher().fetch({
        url: validated.url,
        timeoutMs: WATCH_TIMEOUT_MS,
      });
      const engineResult = await engine.auditPage({
        url: page.url,
        timeoutMs: WATCH_TIMEOUT_MS,
        includeJavaScriptRendering: false,
        includeCoreWebVitals: false,
      });
      const normalized = normalizeAuditResult({
        jobId: `watch-${watch.watch_id}`,
        auditId: `watch-${watch.watch_id}`,
        type: "seo_audit",
        url: watch.url,
        requestedBy: watch.telegram_user_id,
        startedAt: new Date().toISOString(),
        engineResult,
      });

      const previous = await getPreviousAuditSnapshot(
        db,
        watch.telegram_user_id,
        watch.url,
      );
      const diff = previous ? compareAuditToPrevious(normalized, previous) : null;

      if (diff && diff.hasChanges) {
        const alert = [
          `Kaseobot watch alert: ${watch.url}`,
          formatDiffSummary(diff),
          `Watch ID: ${watch.watch_id}`,
        ].join("\n\n");
        await sendTelegramMessage(
          env.TELEGRAM_BOT_TOKEN,
          Number(watch.telegram_user_id),
          alert,
        );
        alerts += 1;
      }

      await saveAuditResult(db, normalized);
    } catch {
      // A single failing watch must not silence the others.
      continue;
    }
  }

  return { watched: items.length, alerts };
}
