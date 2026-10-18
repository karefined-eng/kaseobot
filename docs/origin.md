# kaseomator — Origin and Product Intent

## Why this project exists

kaseomator is a private Telegram-first SEO and generative-search (GEO) audit assistant. Its purpose is to make a bounded, evidence-based website check easy to request and read inside a conversation, without requiring the user to operate a complex analytics suite or keep a developer's computer online.

The project's origin is the kaseomator v1 build handoff and its six-step implementation sequence. The earlier project history describes SEOmator as the product reference: kaseomator should deliver a practical static audit and prioritized explanation in a mobile-friendly workflow, while preserving the option to open SEOmator's own hosted audit tools for an external comparison. The authoritative implementation contract is the user's attached kaseomator BUILD_SPEC; when it conflicts with exploratory notes or code sketches, the spec governs.

## Product principles

1. **Private by default.** Commands operate only for allowlisted users in private chats. A user can see, cancel, and delete only their own stored records.
2. **Evidence before interpretation.** The static SEO and GEO checks generate the measured results. Kimi can explain and prioritize the supplied results, but must not invent checks, scores, or evidence.
3. **Bounded, transparent work.** SEO audits inspect static HTML; GEO audits are capped at five same-origin pages. Progress, scores, skipped/unmeasured checks, errors, and retry behavior should be described plainly.
4. **Convenience without hidden actions.** kaseomator can enqueue an audit after an explicit command. SEOmator buttons open public tools only; kaseomator must not submit a URL to SEOmator or claim it ran an external audit.
5. **Keep chat concise; preserve detail.** Send a useful in-chat summary and offer the complete Markdown when the report is too long for Telegram.
6. **User control over retained data.** History is private, time-limited to 30 days, and deletable with `/forget`. Privacy copy must match actual runtime behavior. Users can additionally turn retention off from the `/history` reply: stored reports are erased immediately, each new report is deleted from storage as soon as it is delivered, and only the Telegram ID and the preference flag are kept while it is off.
7. **Milestone discipline.** Implement one requested milestone at a time. Do not pull in browser rendering, Playwright/Chromium, Lighthouse, Core Web Vitals, PDF generation, or larger-than-five-page crawling as part of v1.

## Current product scope

Milestones 1–5 established the private webhook, SEO/GEO audit jobs, D1 and Cloudflare Queue pipeline, static HTML checks, canonical normalization, filtered Kimi analysis, Telegram MarkdownV2 delivery, and the five-page GEO crawler. Milestone 6 is limited to per-user `/history` and `/forget`, 30-day cleanup, failure retry buttons, public SEOmator fallback links, clearer progress/error messaging, and Markdown-file delivery for long reports. The Milestone 9 history opt-out completed the flagged dead schema: `history_enabled` now gates retention, delivery-time purges, and the daily cleanup.

The app has no browser-based user interface. Telegram is the user surface; D1 and Cloudflare Queues are the persistence/work pipeline. The report does not certify SEO/GEO performance or measure JavaScript-rendered content, Core Web Vitals, or AI-crawler permissions.
