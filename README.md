# kaseomator — Private SEO & GEO Audit Bot for Telegram

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-orange?logo=cloudflare)](https://deploy.workers.cloudflare.com/?url=https://github.com/karefined-eng/kaseobot)
[![CI](https://github.com/karefined-eng/kaseobot/actions/workflows/deploy.yml/badge.svg)](https://github.com/karefined-eng/kaseobot/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-2CA5E0?logo=telegram)](https://core.telegram.org/bots)
[![SEOmator](https://img.shields.io/badge/SEOmator-v5.1.0-00D4AA)](https://seomator.com/)

A private Telegram bot for SEO and GEO (generative search) audits. Runs static HTML checks, multi-page GEO crawls, and optional deep audits via the SEOmator engine in Cloudflare Containers. 100% on Cloudflare's edge. No server management. Zero cold-start cost.

kaseomator is positioned as SEO/GEO audit infrastructure you invoke from Telegram — a library-like surface with typed checks, deterministic reports, and optional AI explanation — not a general-purpose chatbot.

---

## Features

| Command | Description |
|---------|-------------|
| `/audit <url>` | Static HTML SEO audit (12 checks, ~0.5s) |
| `/geo <url>` | Multi-page GEO crawl (up to 5 same-origin pages) |
| `/deepaudit <url>` | Full SEOmator engine via Cloudflare Container — 365+ rules, JS rendering, CWV, screenshots (requires Workers Paid plan) |
| `/seomator <url>` | Links to SEOmator's hosted tools (no auto-submit) |
| `/status <id>` | Job progress and elapsed time |
| `/cancel <id>` | Cancel a queued or running job |
| `/history` | Your recent audits (30-day retention) |
| `/forget` | Delete all your saved data instantly |
| `/privacy` | Data-handling transparency |

---

## Architecture

```
Telegram -> Cloudflare Worker (edge)
          |
          +--> D1 Database (jobs, audits, users)
          +--> Cloudflare Queue (audit processing)
          +--> Cloudflare Container (SEOmator engine)
                   |
                   +--> @seomator/seo-audit v5.1.0 + Playwright Chromium
                        +-- 365+ rules across 20 categories
                        +-- JavaScript rendering and Core Web Vitals
                        +-- Full-page, desktop, and mobile screenshots
                        +-- Markdown report with priority action plan
```

---

## Plan requirements

| Feature | Plan needed |
|---------|-------------|
| `/audit`, `/geo`, `/status`, `/cancel`, `/history`, `/forget`, `/seomator`, `/privacy`, GEO crawls, Kimi AI analysis | Workers Free |
| `/deepaudit` (SEOmator engine in Cloudflare Containers) | Workers Paid ($5/mo) — Cloudflare Containers has no free tier |

The repo deploys cleanly on the free plan: `wrangler deploy --containers-rollout=none` ships the Worker and its Durable Object binding while skipping the container. `main` stays green either way. Remove that flag after upgrading to roll the container out.

---

## Quick Deploy

### Prerequisites

- Cloudflare account
- Telegram bot token (from @BotFather)
- NVIDIA API key (optional, for Kimi AI analysis)

### 1-Click Deploy

[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button.svg)](https://deploy.workers.cloudflare.com/?url=https://github.com/karefined-eng/kaseobot)

### Manual Deploy

```
# 1. Clone and install
git clone https://github.com/karefined-eng/kaseobot.git
cd kaseobot
npm ci

# 2. Configure secrets (never commit these)
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your tokens

# 3. Create Cloudflare resources
npx wrangler d1 create kaseobot-data
npx wrangler queues create kaseobot-audit-jobs
npx wrangler queues create kaseobot-audit-dead-letter

# 4. Update wrangler.toml with your D1 database_id

# 5. Apply migrations
npx wrangler d1 migrations apply kaseobot-data --remote

# 6. Deploy (GitHub Actions handles Container build)
git push origin main
# Add GitHub secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
```

---

## Commands

| Command | Example | Description |
|---------|---------|-------------|
| `/start` | `/start` | Welcome and quick help |
| `/help` | `/help` | Full command reference |
| `/audit` | `/audit https://example.com` | Static SEO audit (12 checks) |
| `/geo` | `/geo https://example.com` | GEO crawl (up to 5 pages) |
| `/deepaudit` | `/deepaudit https://example.com --type=geo --crawl --max-pages=5` | Full SEOmator engine (paid plan) |
| `/status` | `/status abc-123` | Job progress |
| `/cancel` | `/cancel abc-123` | Cancel a job |
| `/history` | `/history` | Your last 10 audits |
| `/forget` | `/forget` | Delete all your data |
| `/seomator` | `/seomator https://example.com` | Open SEOmator's external tools |
| `/privacy` | `/privacy` | Data-handling information |

### `/deepaudit` options

```
/deepaudit https://example.com \
  --type=seo-full|geo|quick|custom \
  --categories=technical,content,performance \
  --crawl \
  --max-pages=5 \
  --mobile \
  --concurrency=3 \
  --timeout=180000 \
  --user-agent="Custom UA"
```

---

## Audit types compared

| Feature | `/audit` (static) | `/deepaudit` (container) |
|---------|-------------------|--------------------------|
| Runtime | ~0.5s | ~100s |
| Checks | 12 | 365+ |
| Categories | 12 | 20 |
| JavaScript rendering | No | Yes |
| Core Web Vitals | No | Yes |
| Screenshots | No | Yes (full, desktop, mobile) |
| JavaScript-heavy sites | No | Yes |
| Logged-in pages | No | Yes (with cookies) |
| Cost per audit | ~$0 | ~$0.004 |

---

## Privacy and security

- Allowlist-only — only approved Telegram users can use the bot
- Private chats only — no group or channel exposure
- 30-day auto-expiry — audits auto-delete after 30 days
- `/forget` — instant, complete data deletion
- No external submissions — `/seomator` only opens links, never auto-submits
- AI analysis opt-in — NVIDIA Kimi used only when `NVIDIA_API_KEY` is configured
- Encrypted secrets — Cloudflare Workers secrets, never in code

---

## Tech stack

- Runtime: Cloudflare Workers (V8 isolates)
- Database: Cloudflare D1 (SQLite at the edge)
- Queue: Cloudflare Queues (audit processing)
- Container: Cloudflare Containers (SEOmator engine)
- Language: TypeScript 5.9
- Testing: Vitest (102 tests)
- SEO engine: `@seomator/seo-audit` v5.1.0 + Playwright Chromium

---

## Contributing

```
# 1. Fork and clone
git clone https://github.com/your-username/kaseobot.git

# 2. Create a feature branch
git checkout -b feat/amazing-feature

# 3. Make changes and test
npm run check   # typecheck plus tests

# 4. Submit a pull request
```

See CONTRIBUTING.md for guidelines.

---

## License

MIT License — see LICENSE for details.

---

## Acknowledgments

- @seomator/seo-audit — the reference SEO engine
- Cloudflare Workers — edge runtime
- Telegram Bot API — messaging platform
- NVIDIA Kimi K3 — AI analysis
- Playwright — browser automation

---

## Support

- Issues: GitHub Issues
- Discussions: GitHub Discussions
- Telegram: @ka_seobot (demo bot)

Star this repo if you find it useful — it helps others discover it.
