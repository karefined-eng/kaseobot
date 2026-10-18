# Milestone 9 — History Opt-Out (`history_enabled`) Handoff

**Status:** Implemented and locally validated. **Not deployed**: the auto-deploy runs on push to `main`, and this session leaves the changes uncommitted pending the user's commit decision (never commit unless asked).

---

## Why this milestone exists

The Milestone 6 live handoff flagged the `users` table as dead schema: `history_enabled` existed in `migrations/0001_jobs.sql` but was never read anywhere — the column "hints at an unimplemented opt-out." The M6-live entry checklist asked the next agent to "confirm `users` table dead schema decision (implement opt-out or drop)."

**Decision on record:** implement the opt-out. It is the privacy-positive option, needs no schema migration, and completes the product principle in `docs/origin.md` ("User control over retained data"). Dropping the table was rejected because the preference row is the only place to persist a user's retention choice.

## What changed

| Area | Behavior |
|---|---|
| `src/history.ts` | New `getHistoryPreference` (missing row = enabled) and `setHistoryPreference` (upsert preserving `created_at`). `forgetUserHistory` is now preference-sticky: `/forget` re-inserts the row with `history_enabled = 0` so an opted-out user is never silently re-enrolled. `cleanupExpiredHistory` only purges orphaned rows with `history_enabled = 1`, and gains a 24-hour backstop that removes terminal jobs, audits, and snapshots of opted-out users that escaped the immediate purge. |
| `src/telegram-ui.ts` | New `historyKeyboard(enabled)`: a "Turn history off/on" toggle plus "Main menu" — shown with every `/history` reply. |
| `src/index.ts` | `/history` shows the off-state explanation with the toggle when retention is disabled. New `hist:on` / `hist:off` callbacks with `handleHistoryToggleCallback`: turning history off immediately deletes stored audits, snapshots, and terminal jobs (active jobs survive until their report is delivered). Help and `/privacy` copy describe the exact semantics. |
| `src/queue-consumer.ts` | `getHistoryPreference` is consulted before delivery. When history is off, the delivered report carries a "History is off" note, and `purgeJobData` deletes the audit payload, job row, and regression snapshot for the audited URL right after a confirmed terminal delivery (completion, cancel, permanent failure, dead-letter exhaustion). Failure notices for opted-out users drop the retry button (retry requires a stored job) and say so. |
| `test/fakes.ts` | FakeD1 supports the preference read/upsert, job/audit deletes by id, snapshot deletes (per-user, per-url, opted-out backstop), the terminal-only user purge, and the updated cleanup that keeps `history_enabled = 0` rows. |
| `test/history-preference.test.ts` | New suite (6 tests). See coverage note below. |
| Docs | `CHANGELOG.md`, `README.md`, `docs/origin.md` (principle 6 + scope), `docs/AGENTS.md` (architecture row + write-guard quirk), `docs/research/history-optout-rationale.md`, this file. |

**No migration needed** — the column and table already exist in `0001_jobs.sql`.

### Opt-out semantics (privacy copy matches runtime)

1. Off = stored reports erased immediately on toggle; each new report is deleted from storage as soon as it is delivered (transient rows exist only while the pipeline runs).
2. Failed audits cannot be retried from stored jobs while off; the failure notice says to send the audit again.
3. Records that slip past the immediate purge (for example a failed enqueue) are removed by the daily cron within 24 hours.
4. The preference survives `/forget` and the daily cleanup; only the Telegram ID, `created_at`, and the flag are kept.
5. Turning history on restores standard 30-day retention.

## Validation performed

| Check | Result |
|---|---|
| `npm run check` | TypeScript strict clean; **114/114 tests pass across 6 files** (108 before, +6 new) |
| Line endings | All edited files re-normalized to their original style (CRLF for `src/*` and the new test; LF for `test/fakes.ts`) — no mixed-endings git warnings |
| FakeD1 parity | Every new D1 statement has a fake counterpart; no "Unsupported FakeD1 query" paths remain |

## What broke

- Nothing known at the code level. One tooling constraint: the workspace write guard rejects any file containing credential-shaped key names (`TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET` — required `Env` fields), so the new test suite was written **key-free** and covers `history.ts` + `queue-consumer.ts` logic only. The user was asked to permit the webhook-level tests (same pattern as the existing `test/milestone-6.test.ts`); no answer came, so the compliant key-free subset shipped.

**Test coverage gap (follow-ups when policy permits):**
1. Webhook `/history` off-state reply + `hist:on` keyboard.
2. `hist:off` button purging stored audits/terminal jobs (callback path).
3. Completion-path purge after a confirmed delivery while history is off.
4. Failure-notice payload without the retry button.

## What is blocked

- **Commit + push:** per standing rule, no commit without the user's request. Deployment is push-to-`main` (auto workflow, `--containers-rollout=none`). Production still runs Milestone 7/8 code.
- **`/deepaudit` activation:** unchanged — needs the Workers Paid plan (`docs/handoff/milestone-7-deepaudit.md` plan gate).
- **M6-live open item "second site test produced no job":** still needs the user's reproduction details.

## Next agent's first 3 actions

1. Read `docs/origin.md`, this file, and `git diff origin/main` to review the uncommitted opt-out implementation.
2. After the user commits/pushes: verify live `GET /healthz`, webhook 401 gate, then in Telegram: `/history` → "Turn history off" → run `/audit <url>` → confirm the delivery note appears and `/status <job_id>` reports the job as not found → toggle back on.
3. Extend `test/history-preference.test.ts` with the four webhook-level tests above if the write-guard policy permits `Env` keys in new files.
