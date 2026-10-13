# Milestone 6 — History and Polish Handoff

**Status:** Implemented and locally validated. This completes the requested Milestone 6 scope only; no production deployment, Telegram webhook registration, or external account changes were made.

## Delivered behavior

| Acceptance item | Implementation |
|---|---|
| `/history` lists only the requesting user's audits | `src/history.ts` filters by Telegram user ID, terminal status, 30-day window, and a 10-item limit. `LEFT JOIN` supplies score when a result exists. The `/history` route is private-chat/allowlist gated. |
| `/forget` deletes the user's stored history | `forgetUserHistory` deletes audit rows, job rows, and the caller's user row in a D1 `batch`. Queue result writes are guarded by an `INSERT … SELECT` that requires the same owned job to remain `running`, so a forgotten job cannot recreate its D1 result. |
| Failed audits offer a retry | Permanent and dead-letter failure notices include a **Retry audit** inline button. The webhook acknowledges callbacks and accepts only the `retry:<job-id>` action in an allowlisted private chat. It verifies job ownership and `failed` status, then creates a new rate-limited job without changing the original row. |
| SEOmator fallback button opens the public tool pages | `/seomator <url>` validates and displays the URL, then exposes `https://seomator.com/free-seo-audit-tool` and `https://seomator.com/geo-audit-tool`. It does not auto-submit the URL or scrape external results. |
| Long reports are delivered as Markdown documents | Reports over 3,500 characters in source Markdown or Telegram MarkdownV2 use multipart `sendDocument` with a `.md` attachment and a short summary caption (score, counts, up to three measured priorities). The complete Markdown and MarkdownV2 rendering are persisted for delivery retries. |
| Audit history is retained for 30 days | A Cloudflare Cron Trigger (`0 3 * * *`, 03:00 UTC) calls `cleanupExpiredHistory`; expired audit results and terminal jobs are removed, and orphaned user rows are pruned. Active jobs are not deleted by cleanup. `/privacy` explains the daily cleanup timing and `/forget` boundary. |
| Better progress/error messages | `/status` responses suggest next steps by state. URL errors now mention `/audit`, `/geo`, and `/seomator`; failure messages explain the retry action. |

No schema migration was necessary: the existing D1 schema already has the `users`, `jobs`, and `audits` tables, result expiry field, and expiry index.

## Main files

- `src/history.ts` — user-scoped history, batch deletion, and scheduled retention cleanup.
- `src/telegram-ui.ts` — retry/SEOmator keyboards, history formatting, and callback acknowledgements.
- `src/index.ts` — new commands, secure private callback routing, updated privacy/help copy, and `scheduled()` handler.
- `src/jobs.ts` — D1 list/batch interface support and actionable state-specific status guidance.
- `src/audits/storage.ts` — owner/job-status-guarded result writes.
- `src/ai/report.ts`, `src/audits/types.ts` — persisted full Markdown source alongside MarkdownV2.
- `src/queue-consumer.ts` — retry controls on failures and long-report summary/document delivery.
- `wrangler.toml` — daily 03:00 UTC Cron Trigger.
- `test/milestone-6.test.ts`, `test/fakes.ts` — history/forget privacy, race prevention, retry ownership, SEOmator links, cleanup, and full-document tests.
- `docs/research/milestone-6-ux-rationale.md` — cited workflow rationale.

## Validation performed

- `npm run check` — passed strict TypeScript and **102 tests across 5 files**.
- `npm audit` — **0 vulnerabilities**.
- `npx wrangler deploy --dry-run` — Worker bundled successfully; approximately 110.69 KiB upload / 28.01 KiB gzip. **No deployment occurred.**
- `CI=1 npx wrangler d1 migrations apply kaseobot-data --local` — local schema was up to date; confirmed `users`, `jobs`, `audits`, and `idx_audits_expires_at` exist.
- A real local D1 SQL probe of the owner/status-guarded audit upsert succeeded; both temporary probe rows were subsequently deleted and verified absent.
- No production secrets, D1 IDs, queues, webhook registrations, or remote records were created or changed.

## Deployment prerequisites and boundaries

Before production use, create/configure the Cloudflare D1 database and queues, apply both existing migrations remotely, set Telegram/NVIDIA secrets and the user allowlist, deploy the Worker, and register Telegram's webhook secret/path. Verify the scheduled trigger appears on the deployed Worker. These external changes were intentionally not made in this implementation session.

`/forget` removes Kaseobot's stored records but cannot recall a report already delivered in Telegram or data already sent to NVIDIA before the deletion. SEOmator remains an explicit external user action, not a Kaseobot submission.
