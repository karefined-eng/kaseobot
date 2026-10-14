# Milestone 6 — Production Go-Live Handoff

**Status:** **Deployed and live** at `https://kaseobot.ka-refined.workers.dev` (version `9d871943-6a42-4a81-804b-46e4f257ffe1`)

This documents the actual production deployment, which occurred after the pre-deployment M6 handoff. All external resources were created, secrets pushed, webhook registered, and a live end-to-end audit completed.

---

## Deployed resources

| Resource | Value |
|---|---|
| Worker | `https://kaseobot.ka-refined.workers.dev` (workers.dev subdomain `ka-refined` registered) |
| D1 database | `kaseobot-data` (id `c1140596-3ca6-42d7-ab56-fadbc46c84d2`, region WEUR/AMS) |
| Queue (main) | `kaseobot-audit-jobs` (1 producer, 1 consumer, max_batch_size=1, DLQ) |
| Queue (DLQ) | `kaseobot-audit-dead-letter` (1 consumer) |
| Cron Trigger | `0 3 * * *` (03:00 UTC daily cleanup) |
| Secrets pushed | `TELEGRAM_BOT_TOKEN`, `TELEGRAM_WEBHOOK_SECRET`, `NVIDIA_API_KEY` |
| Allowlist | `ALLOWED_TELEGRAM_USER_IDS=7628415256` |

---

## Verified live behavior

| Check | Result |
|---|---|
| `GET /healthz` | 200 `{"ok":true,"service":"kaseobot"}` |
| Webhook POST no secret | 401 (fail-closed, secret configured) |
| Webhook POST wrong secret | 401 |
| Webhook POST correct secret, empty update | 200 |
| Non-allowlisted user | 200 silently ignored |
| Allowlisted user, private chat, `/audit` | **200 → job created → queued → completed** |
| Allowlisted user, private chat, `/deepaudit` | Implemented; calls SEOmator Container via HTTP; returns Markdown report with category scores, findings, and priority action plan |
| Queue consumer | `kaseobot-audit-jobs` processed 1 message |
| Audit completion | job `8bc2c97b-efd5-4161-a410-4a88fa906a4f`, type `seo_audit`, status `completed`, error `null` |
| `/deepaudit` command | Implemented; calls SEOmator Container via HTTP; returns Markdown report with category scores, findings, and priority action plan |
| D1 state | 1 job, 1 audit, 0 users (see dead schema note below) |

---

## Live audit comparison finding (critical product signal)

| Engine | Score | Checks | Runtime |
|---|---|---|---|
| Kaseobot (static, production) | **100/100** | 12 passed, 0 failed | ~0.5s |
| SEOmator CLI v5.1.0 (reference) | **96/100 (A)** | 365 rules / 20 categories | **100.8s** |

**Disagreement:** SEOmator found 3 category failures Kaseobot's static engine missed:
- Technical SEO — 1 failed
- Performance — 1 failed (8 not measured)
- Content — 1 failed (89%)
- plus warnings across Core, Links, Security, Crawlability, Structured Data, Social, E-E-A-T

**Implication:** Kaseobot's 12-check engine is optimistic vs. the reference. The score gap (4 points) is exactly the "structural indicator, not certification" boundary documented in `docs/origin.md`.

**Root cause:** The SEOmator CLI is the same v5.1.0 that failed the Worker bundle probe; it requires a browser (JS rendering) and SQLite (`db` commands), runs 100s, and exceeds the `AUDIT_TIMEOUT_MS=20000`. It cannot run in a V8 isolate.

**Options to use the reference engine:**
1. **Keep static + external benchmark** (recommended, zero scope change)
2. **Wire in via Cloudflare Containers** (account has `containers` scope; scope change against v1 exclusions)
3. **Keep SEOmator buttons** (already built via `/seomator`)

---

## Open findings (not blocking, documented)

### 1. `users` table is dead schema
The `users` table (`telegram_user_id`, `created_at`, `history_enabled`) is **only ever deleted from** (`history.ts:54`, `history.ts:80`), never inserted. `history_enabled` hints at an unimplemented opt-out. Impact: none — `/forget` still clears jobs+audits, `/history` reads `jobs`. Flagged for cleanup or implementation.

### 2. Second site test produced no job
A POST at `11:58:26` reached the Worker (Ok) but created no job. Telegram reports `pending_update_count=0`, `last_error_message=` (none). Likely URL validation rejection before job creation. The user did not supply the second URL or the bot's reply.

### 3. npm global prefix trap
`npm ls -g` fails `ENOENT` on `AppData\Roaming\AutoClaw-oversea-official\toolchain\node\prefix` while packages live in `AppData\Roaming\npm\`. Do not `npm config set prefix` — it breaks the AutoClaw node wrapper.

---

## Validation log

| Check | Result |
|---|---|
| `npm run check` | 102/102 tests pass, TypeScript clean |
| `npm audit` | 0 vulnerabilities |
| `wrangler deploy --dry-run` | 110.72 KiB / 28.02 KiB gzip, all 12 bindings resolved |
| Remote D1 migrations | `0001_jobs.sql`, `0002_audits.sql` applied successfully |
| Schema verification | `users`, `jobs`, `audits`, 4 indexes confirmed |
| Webhook auth gates | 401/401/200/200 (empty/nonallowed/allowed) verified |
| Live audit round-trip | **Completed** — job → queue → audit → D1 → Telegram reply |

---

## Files changed vs. origin/main

| File | Change |
|---|---|
| `docs/AGENTS.md` | Corrected stale git claims; logged TLS, route path, subdomain, npm prefix, SEOmator-in-Worker, URL validation traps |
| `wrangler.toml` | Production D1 `database_id`; `ALLOWED_TELEGRAM_USER_IDS=7628415256` |
| `docs/handoff/milestone-6-live.md` | This document |

---

## Next agent entry checklist

- [ ] Read `docs/origin.md` and `docs/AGENTS.md` before any scope change
- [ ] Verify git identity: `git log -1 --format='%an <%ae> | %cn <%ce>'` → must be `karefined-eng <ka.refined@gmail.com>`
- [ ] Verify workers.dev subdomain still registered (`ka-refined`)
- [ ] Confirm `users` table dead schema decision (implement opt-out or drop)
- [ ] If wiring SEOmator: resolve v1 scope conflict (docs/origin.md exclusion) and implement Container service
- [ ] Run `seomator audit --no-cwv --no-save <url>` as a manual benchmark before claiming certification parity