# Changelog

All notable changes to this project are documented here.

Format based on [Keep a Changelog](https://keepachangelog.com/en/1.0.0/), versioning per [SemVer](https://semver.org/).

## [Unreleased]

### Added
- `/deepaudit` command with Cloudflare Container integration
- SEOmator Container with full-page, desktop, and mobile screenshots
- Markdown report with category scores, findings, and priority action plan
- Granular audit options: `--type`, `--categories`, `--crawl`, `--max-pages`, `--mobile`, `--concurrency`, `--timeout`, `--user-agent`
- GitHub Actions workflow for Container build + Worker deploy
- 102 unit tests (100% pass)

### Fixed
- `users` table now populated on job creation
- Git authorship enforced via inline env vars
- TypeScript strict mode compliance

## [1.0.0] - 2026-10-14

### Added
- Initial Kaseobot v1 release
- Private Telegram bot for SEO/GEO audits
- Static HTML SEO audit engine (12 checks)
- GEO crawl (up to 5 same-origin pages)
- D1 storage for jobs, audits, users
- Cloudflare Queue for audit processing
- Per-user rate limits (10/hr, 2 concurrent)
- `/audit`, `/geo`, `/status`, `/cancel`, `/history`, `/forget`, `/seomator`, `/privacy`
- NVIDIA Kimi K3 AI analysis (optional)
- Telegram MarkdownV2 formatting + long-report document delivery
- Inline retry buttons for failed jobs
- 30-day retention with daily cleanup cron
- 102 unit tests (100% pass)

### Security
- Private-chat allowlist enforcement
- Webhook secret-token validation
- 30-day data expiry + `/forget` immediate deletion
- No external URL submissions

---

**Legend**: `Added` `Changed` `Deprecated` `Removed` `Fixed` `Security`