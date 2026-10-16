# kaseomator v1 — Milestone 6

A private Telegram bot for static-HTML SEO audits and bounded multi-page GEO audits, running on Cloudflare Workers with a webhook, D1 job/result storage, and a Cloudflare Queue.

## Included

- `POST /telegram/webhook` with Telegram secret-token validation and a private-chat allowlist.
- `/start`, `/help`, `/privacy`, `/audit <url>`, `/geo <url>`, `/status <job_id>`, `/cancel <job_id>`, `/history`, `/forget`, and `/seomator <url>`.
- HTTP(S)-only URL validation, private/reserved IP-literal checks, public-host checks, and redirect revalidation.
- Idempotent queue processing, transient retries, dead-letter handling, owner-checked inline retry callbacks, and per-user limits of 10 jobs/hour and 2 active jobs.
- A Worker-native `StaticHtmlAuditEngine` that fetches at most 2 MB of static HTML and checks title, meta description, canonical, robots directives, viewport, H1 count, image alt attributes, internal/external links, `html[lang]`, HTTPS, and basic heading hierarchy.
- `/geo` breadth-first discovery of same-origin HTML links, with a hard maximum of five pages per job and validated redirects.
- Aggregated, page-attributed SEO findings plus deterministic GEO citability, Schema.org, and content-structure checks. Partial page failures are reported; a crawl fails only when no page can be audited.
- Canonical normalized/raw result persistence, GEO page counts and nullable scores, and deterministic reports with separate SEO and GEO sections.
- Optional NVIDIA-hosted Kimi K3 analysis of a filtered aggregate projection, with request-ID polling for HTTP 202, safe MarkdownV2 formatting, and deterministic fallback.
- Owner-scoped `/history` and `/forget`; a daily Cloudflare Cron Trigger cleans expired records.
- Complete Markdown report attachments for long reports, with a short score/findings summary; failed jobs have an inline Retry audit button.
- `/seomator` links to SEOmator's hosted SEO and GEO audit tools without automatically submitting or scraping the user's URL.
- `GET /healthz`.

## SEOmator compatibility

The official `@seomator/seo-audit` v5.1.0 package documents a `createAuditor({ ... }).audit(url)` programmatic API. Its Worker compatibility probe used Wrangler with `nodejs_compat`; bundling failed because Playwright pulled unresolved `chromium-bidi` modules. The package is therefore not included or forced into the Worker. The `SeomatorAuditEngine` adapter remains isolated and injectable, while production uses the static fallback. No Playwright, Puppeteer, Chromium, JavaScript rendering, Lighthouse, or Core Web Vitals are used.

## Configure locally

```sh
npm ci
npx wrangler secret put TELEGRAM_BOT_TOKEN
npx wrangler secret put TELEGRAM_WEBHOOK_SECRET
npx wrangler secret put NVIDIA_API_KEY
```

`GEO_MAX_PAGES` is a nonsecret variable configured in `wrangler.toml`, defaulting to `5`; code always clamps it to `1–5`. `NVIDIA_KIMI_MODEL`, `NVIDIA_KIMI_ENDPOINT`, `KIMI_TIMEOUT_MS`, `MAX_FINDINGS_FOR_KIMI`, and `MAX_EVIDENCE_LENGTH` are also nonsecret variables; defaults are `moonshotai/kimi-k3`, NVIDIA's documented Kimi K3 chat-completions endpoint, 60 seconds, 25 findings, and 300 characters. Keep the NVIDIA key in Worker secrets or a local `.dev.vars` file (ignored by Git), never in source control.

Set the Telegram allowlist in `wrangler.toml` or as a Worker variable before deploying:

```toml
[vars]
ALLOWED_TELEGRAM_USER_IDS = "123456789"
GEO_MAX_PAGES = "5"
```

Create production D1/Queue resources, then replace the local placeholder `database_id` in `wrangler.toml` with the actual D1 ID:

```sh
npx wrangler d1 create kaseobot-data
npx wrangler queues create kaseobot-audit-jobs
npx wrangler queues create kaseobot-audit-dead-letter
npx wrangler d1 migrations apply kaseobot-data --remote
```

The configured Cron Trigger runs expiry cleanup daily at **03:00 UTC**. No additional scheduler resource is required beyond deploying the Worker with the `[triggers]` stanza.

For local development, keep credentials in `.dev.vars` (ignored by Git). Start with `.dev.vars.example`, then fill in local-only values:

```dotenv
TELEGRAM_BOT_TOKEN=replace-with-a-local-test-token
TELEGRAM_WEBHOOK_SECRET=replace-with-a-long-random-secret
NVIDIA_API_KEY=replace-with-a-nvidia-api-key
ALLOWED_TELEGRAM_USER_IDS=123456789
GEO_MAX_PAGES=5
```

Then run:

```sh
npm run dev
npm run check
```

After deployment, configure Telegram's webhook URL as `https://<worker-host>/telegram/webhook`, with the same secret supplied as `secret_token`. Do not commit bot credentials or the production D1 database ID.

## Audit commands

`/audit https://example.com` validates and normalizes one explicit HTTP(S) URL, creates a `seo_audit` job, and enqueues it. The worker fetches static HTML only (maximum 2 MB, bounded timeout, at most five redirects); redirects are checked against the URL safety rules before the next request. It normalizes the measured checks and saves normalized and raw JSON in D1.

`/geo https://example.com` creates a `geo_audit` job. The worker fetches the homepage, discovers internal HTTP(S) links breadth-first, and audits no more than `GEO_MAX_PAGES` pages (hard-capped at five). It follows same-origin links only, skips known non-HTML asset extensions, validates every discovered URL, and rejects pages that redirect outside the homepage origin. Each page reuses the static SEO engine; results are aggregated with page URLs preserved in findings. Failed subpages are counted and retained in the raw result without discarding successful pages. If every attempted page fails, the job fails (and transient engine/network errors remain retryable).

The deterministic GEO signals are deliberately narrow, static-HTML proxies:

- **Citability:** an introductory paragraph of at least 120 characters and at least two H2/H3 headings.
- **Schema:** valid Schema.org JSON-LD or Schema.org microdata detected in the HTML.
- **Content structure:** at least 200 extracted visible-text words and a `main` or `article` landmark.
- **Crawler access:** not measured in this milestone; its score is stored as `null` rather than guessed.

Each GEO signal category uses the existing deterministic finding score (pass = 100% of that check's points; warning = 50%). These are structural indicators, not semantic content-quality judgments, crawler-permission checks, ranking predictions, or a full GEO certification.

The fallback report includes requested/audited/failed page counts, measured GEO scores, an explicit “not measured” crawler-access label, and separate **SEO findings** and **GEO findings** sections.

## History, retry, and external tools

`/history` lists up to 10 terminal jobs belonging only to the requesting Telegram user, with URL, type, status, and score when available. `/forget` deletes that user's D1 audit rows, jobs, and user row as a D1 batch. Queue result writes require the owning job to still exist and be running, so a forgotten in-flight job cannot recreate its local result. `/forget` cannot recall a message already delivered in Telegram or information already sent to NVIDIA before deletion.

Failed jobs receive a **Retry audit** inline button. The callback is accepted only in the allowlisted user's private chat, only when the failed job belongs to that user, and only while the original job remains failed. Retrying creates a new job and preserves the original history row; normal active-job and hourly limits still apply. `/seomator <url>` validates the URL, displays it, and presents the public SEO and GEO tool links. The user chooses and submits the URL on SEOmator; kaseomator neither auto-submits nor scrapes that site.

Reports that exceed **3,500 characters** in their normal or Telegram-safe rendering are sent as a `.md` document. The Telegram caption includes the audit type, URL, overall score, failure/warning counts, and up to three measured priority issues. Shorter reports remain inline. The complete ordinary Markdown source is stored with the audit result for delivery retries.

## AI analysis and privacy

When `NVIDIA_API_KEY` is present, the queue worker sends Kimi an allowlisted projection of the aggregate result: overall/category scores, summary counts, GEO page counts and scores when present, and up to `MAX_FINDINGS_FOR_KIMI` (maximum 25) failed/warning findings. Evidence and recommendations are limited to `MAX_EVIDENCE_LENGTH` (maximum 300) characters each. The raw audit-engine result, raw Telegram update, job/audit identifiers, and Telegram user/chat IDs are excluded. Website-derived text is treated as untrusted prompt data. The Kimi system prompt requires SEO and GEO findings to remain distinguishable and grounded in supplied checks.

The Kimi client uses NVIDIA's OpenAI-compatible chat-completions API. It handles immediate `200` results and the documented `202` pending response by polling the returned `NVCF-REQID` at NVIDIA's `/v1/status/{requestId}` endpoint, within the configured timeout. The result's `ai` metadata records provider, model, success/error, request ID, and the final formatted report. Persisting the report lets queue redeliveries avoid another model call. Kimi returns ordinary Markdown; the formatter safely converts supported emphasis, links, lists, and code blocks to Telegram MarkdownV2, escaping other reserved characters.

If the key is missing or the API times out, returns an error, or gives an invalid response, kaseomator saves a short error and sends a deterministic MarkdownV2 report derived only from normalized findings. A retry after the report is saved reuses the same report.

## Privacy and retention

D1 stores Telegram user ID, chat ID, URL, job state, normalized findings, raw static-audit output, per-page GEO results, AI report metadata, and complete Markdown source for long reports. Audit rows expire **30 days after result creation**; terminal jobs without a stored audit result are eligible for cleanup after 30 days from job creation. The daily 03:00 UTC Cron Trigger removes expired terminal jobs and audit results within 24 hours of expiry, plus orphaned user rows. Active jobs are not removed by scheduled cleanup. `/forget` removes the requesting user's saved records immediately.

When Kimi analysis is used, filtered aggregate audit evidence and GEO counters/scores are sent to NVIDIA. The AI input does not include Telegram IDs, raw webhook payloads, or raw engine output. No Kimi call occurs when `NVIDIA_API_KEY` is absent. `/privacy` summarizes these disclosures in the bot.

## Official references

- [NVIDIA Kimi K3 inference API](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer) — chat completions, HTTP 200/202, `NVCF-REQID`.
- [NVIDIA Kimi K3 status polling](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-statuspolling) — `GET /v1/status/{requestId}`.
- [Telegram Bot API](https://core.telegram.org/bots/api) — inline keyboards, `answerCallbackQuery`, `sendDocument`, and MarkdownV2.
