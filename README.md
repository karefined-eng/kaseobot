# kaseomator — Private SEO/GEO Audit Bot for Telegram

[![Deploy to Cloudflare Workers](https://img.shields.io/badge/Deploy%20to-Cloudflare%20Workers-orange?logo=cloudflare)](https://deploy.workers.cloudflare.com/?url=https://github.com/karefined-eng/kaseobot)
[![CI](https://github.com/karefined-eng/kaseobot/actions/workflows/deploy.yml/badge.svg)](https://github.com/karefined-eng/kaseobot/actions/workflows/deploy.yml)
[![License: MIT](https://img.shields.io/badge/License-MIT-green.svg)](LICENSE)
[![TypeScript](https://img.shields.io/badge/TypeScript-5.9-blue?logo=typescript)](https://www.typescriptlang.org/)
[![Cloudflare Workers](https://img.shields.io/badge/Cloudflare-Workers-F38020?logo=cloudflare)](https://workers.cloudflare.com/)
[![Telegram Bot](https://img.shields.io/badge/Telegram-Bot-2CA5E0?logo=telegram)](https://core.telegram.org/bots)
[![SEOmator](https://img.shields.io/badge/SEOmator-v5.1.0-00D4AA)](https://seomator.com/)

> **A private Telegram bot for SEO & GEO audits** — static HTML checks, multi-page GEO crawls, and optional deep audits via SEOmator engine in Cloudflare Containers. Runs 100% on Cloudflare's edge. No server management. Zero cold-start cost.

---

## ✨ Features

| Command | Description |
|---------|-------------|
| `/audit <url>` | Static HTML SEO audit (12 checks, ~0.5s) |
| `/geo <url>` | Multi-page GEO crawl (up to 5 same-origin pages) |
| `/deepaudit <url>` | **Full SEOmator engine** via Cloudflare Container — 365+ rules, JS rendering, CWV, screenshots ⚠️ *requires Workers Paid plan* |
| `/seomator <url>` | Links to SEOmator's hosted tools (no auto-submit) |
| `/status <id>` | Job progress & elapsed time |
| `/cancel <id>` | Cancel queued/running job |
| `/history` | Your recent audits (30-day retention) |
| `/forget` | Delete all your data instantly |
| `/privacy` | Data handling transparency |

---

## 🏗 Architecture

```
Telegram → Cloudflare Worker (edge)
    │
    ├─→ D1 Database (jobs, audits, users)
    ├→ Cloudflare Queue (audit processing)
    └─→ Cloudflare Container (SEOmator engine)
         │
         └─→ @seomator/seo-audit v5.1.0 + Playwright Chromium
              ├─ 365+ rules across 20 categories
              ├─ JavaScript rendering & CWV
              ├─ Full-page + viewport + mobile screenshots
              └─ Markdown report with priority action plan
```

---

## ⚠️ Plan requirements

| Feature | Plan needed |
|---|---|
| `/audit`, `/geo`, `/status`, `/cancel`, `/history`, `/forget`, `/seomator`, `/privacy`, GEO crawls, Kimi AI analysis | **Workers Free** ✅ |
| `/deepaudit` (SEOmator engine in Cloudflare Containers) | **Workers Paid** ($5/mo) — Cloudflare Containers has no free tier |

The repo deploys cleanly on the free plan: `wrangler deploy --containers-rollout=none` ships the Worker and its Durable Object binding while skipping the container. `main` stays green either way. Remove that flag after upgrading to roll the container out.
## 🚀 Quick Deploy

### Prerequisites
- Cloudflare account
- Telegram bot token (from [@BotFather](https://t.me/BotFather))
- NVIDIA API key (optional, for Kimi AI analysis)

### 1-Click Deploy
[![Deploy to Cloudflare Workers](https://deploy.workers.cloudflare.com/button.svg)](https://deploy.workers.cloudflare.com/?url=https://github.com/karefined-eng/kaseobot)

### Manual Deploy

```bash
# 1. Clone & install
git clone https://github.com/karefined-eng/kaseobot.git
cd kaseobot
npm ci

# 2. Configure secrets (never commit these!)
cp .dev.vars.example .dev.vars
# Edit .dev.vars with your tokens

# 3. Create Cloudflare resources
npx wrangler d1 create kaseobot-data
npx wrangler queues create kaseobot-audit-jobs
npx wrangler queues create kaseobot-audit-dead-letter

# 4. Update wrangler.toml with your D1 database_id
# 5. Apply migrations
npx wrangler d1 migrations apply kaseobot-data --remote

# 6. Deploy (uses GitHub Actions for Container build)
git push origin main
# Add GitHub secrets: CLOUDFLARE_API_TOKEN, CLOUDFLARE_ACCOUNT_ID
```

---

## 📖 Commands

| Command | Example | Description |
|---------|---------|-------------|
| `/start` | `/start` | Welcome & quick help |
| `/help` | `/help` | Full command reference |
| `/audit` | `/audit https://example.com` | Static SEO audit (12 checks) |
| `/geo` | `/geo https://example.com` | GEO crawl (≤5 pages) |
| `/deepaudit` | `/deepaudit https://example.com --type=geo --crawl --max-pages=5` | **Full SEOmator engine** |
| `/status` | `/status abc-123` | Job progress |
| `/cancel` | `/cancel abc-123` | Cancel job |
| `/history` | `/history` | Your last 10 audits |
| `/forget` | `/forget` | Delete all your data |
| `/seomator` | `/seomator https://example.com` | Links to SEOmator tools |
| `/privacy` | `/privacy` | Data handling info |

### `/deepaudit` Options

```bash
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

## 📊 Audit Types Compared

| Feature | `/audit` (Static) | `/deepaudit` (Container) |
|---------|-------------------|--------------------------|
| **Runtime** | ~0.5s | ~100s |
| **Checks** | 12 | 365+ |
| **Categories** | 12 | 20 |
| **JS Rendering** | ❌ | ✅ |
| **Core Web Vitals** | ❌ | ✅ |
| **INP (Interaction)** | ❌ | ✅ |
| **Screenshots** | ❌ | ✅ (Full + Desktop + Mobile) |
| **JS-heavy sites** | ❌ | ✅ |
| **Logged-in pages** | ❌ | ✅ (with cookies) |
| **Cost/audit** | ~$0 | ~$0.004 |

---

## 🔒 Privacy & Security

- **Allowlist-only** — only approved Telegram users can use the bot
- **Private chats only** — no group/channel exposure
- **30-day auto-expiry** — audits auto-delete after 30 days
- **`/forget`** — instant, complete data deletion
- **No external submissions** — `/seomator` only opens links, never auto-submits
- **AI analysis opt-in** — NVIDIA Kimi only used if `NVIDIA_API_KEY` configured
- **Encrypted secrets** — Cloudflare Workers secrets, never in code

---

## 🛠 Tech Stack

- **Runtime**: Cloudflare Workers (V8 isolates)
- **Database**: Cloudflare D1 (SQLite at edge)
- **Queue**: Cloudflare Queues (audit processing)
- **Container**: Cloudflare Containers (SEOmator engine)
- **Language**: TypeScript 5.9
- **Testing**: Vitest (102 tests)
- **SEO Engine**: `@seomator/seo-audit` v5.1.0 + Playwright Chromium

---

## 🤝 Contributing

```bash
# 1. Fork & clone
git clone https://github.com/your-username/kaseobot.git

# 2. Create feature branch
git checkout -b feat/amazing-feature

# 3. Make changes & test
npm run check  # typecheck + tests

# 4. Submit PR
```

See [CONTRIBUTING.md](CONTRIBUTING.md) for guidelines.

---

## 📄 License

MIT License — see [LICENSE](LICENSE) for details.

---

## 🙏 Acknowledgments

- [@seomator/seo-audit](https://github.com/seo-skills/seo-audit-skill) — the reference SEO engine
- [Cloudflare Workers](https://workers.cloudflare.com/) — edge runtime
- [Telegram Bot API](https://core.telegram.org/bots/api) — messaging platform
- [NVIDIA Kimi K3](https://docs.api.nvidia.com/nim/reference/moonshotai-kimi-k3-infer) — AI analysis
- [Playwright](https://playwright.dev/) — browser automation

---

## 📞 Support

- **Issues**: [GitHub Issues](https://github.com/karefined-eng/kaseobot/issues)
- **Discussions**: [GitHub Discussions](https://github.com/karefined-eng/kaseobot/discussions)
- **Telegram**: [@ka_seobot](https://t.me/ka_seobot) (demo bot)

---

**Star ⭐ this repo if you find it useful!** — it helps others discover it.