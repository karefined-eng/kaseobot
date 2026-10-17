# Scope: `/keywords` — first AI/SEO command for kaseomator

**Status:** Proposed — `[PENDING_USER_REVIEW]`
**Date:** 2026-10-17
**Author:** AutoClaw (agent), based on Telegram competitive analysis in docs/research/telegram-bot-competitive-analysis.md

## Goal

Add `/keywords <url>` — kaseomator's first AI/SEO command. Given a URL, it runs the existing static HTML audit engine, extracts SEO-relevant keyword signals from the page markup (title, H1, meta description, canonical, lang, heading structure), and returns a short, prioritized keyword summary in Telegram.

This follows the competitive-analysis pattern: **AI/LLM integration is the growth vector** (kirara-ai, AstrBot, elizaOS all trend because of AI). kaseomator already has filtered Kimi analysis in `src/ai/` — this command reuses that pipeline instead of building a new one.

## Why this command

| Competitive signal | How `/keywords` answers it |
|--------------------|---------------------------|
| AI/LLM bots trend | Reuses existing NVIDIA Kimi pipeline (`src/ai/`) for AI explanation |
| Narrow scope done perfectly | One job: keyword signals from static HTML. No crawling, no rendering, no new engine |
| Copy-paste onboarding | `/keywords https://example.com` returns a ready-to-use summary in under 3,500 chars |
| Library-like surface | Typed finding extraction; deterministic output with optional AI layer |

## In scope

1. **Command registration** — `/keywords` added to `BOT_COMMANDS` in `src/index.ts` (left-side `/` menu) and to the button-first menu mapping in `src/telegram-ui.ts` (`mainMenuKeyboard` / `menuLabelToCommand`).
2. **URL validation** — reuse `validateAndNormalizeUrl`; invalid URL returns an error message, never a silent drop.
3. **Static audit** — run `StaticHtmlAuditEngine` on the single page (same path as `/audit`).
4. **Keyword signal extraction** — deterministic extraction from the audit result:
   - Title presence + length + truncation note
   - H1 presence + count + text
   - Meta description presence + length
   - Canonical presence + value
   - HTML lang attribute
   - Heading hierarchy (H1–H6 levels found)
   - HTTPS enforcement
5. **Kimi AI layer (opt-in)** — if `NVIDIA_API_KEY` is configured, pass the filtered findings through `generateAuditReport` with a keyword-focused system prompt; otherwise deterministic fallback.
6. **Output** — short summary in chat (under 3,500 chars, Telegram-safe MarkdownV2), full report persisted as `.md` if longer.
7. **Tests** — unit tests for keyword extraction + integration test for the `/keywords` command flow; keep `npm run check` green (102 tests + new).
8. **Docs** — README command table updated; `docs/origin.md` principle alignment noted.

## Out of scope (explicitly excluded)

- No new audit engine — reuses `StaticHtmlAuditEngine` only
- No GEO crawl for this command (that's `/geo`)
- No JavaScript rendering, no Playwright, no Core Web Vitals (per `docs/origin.md` v1 exclusions)
- No multi-page crawling
- No keyword research against external search APIs (Google, Bing, etc.) — signals come from the page's own markup only
- No keyword storage beyond the normal audit row

## Acceptance criteria

- [ ] `npm run check` passes (TypeScript clean + all tests)
- [ ] `/keywords https://example.com` returns a keyword summary in a private allowlisted chat
- [ ] Invalid URL returns `validated.error`, no silent drop
- [ ] Without `NVIDIA_API_KEY`, deterministic fallback report is used
- [ ] With `NVIDIA_API_KEY`, Kimi explanation is generated and attached
- [ ] Command appears in Telegram's left-side `/` menu and the persistent reply keyboard

## Files to touch

| File | Change |
|------|--------|
| `src/index.ts` | Register `/keywords` in `BOT_COMMANDS`; add command handler branch |
| `src/telegram-ui.ts` | Add "Keywords" button to `mainMenuKeyboard`; map label to `/keywords` in `menuLabelToCommand` |
| `src/ai/prompts.ts` | Add keyword-focused system prompt + user prompt builder (or reuse existing with a keyword hint) |
| `src/audits/` | No change — reuse `StaticHtmlAuditEngine` + finding extraction from existing result |
| `test/` | New `test/keywords.test.ts` (extraction + command flow) |
| `README.md` | Add `/keywords` to command table |
| `docs/research/telegram-bot-competitive-analysis.md` | Note `/keywords` as adopted |

## Alignment with docs/origin.md

| Origin principle | `/keywords` alignment |
|------------------|----------------------|
| Evidence before interpretation | Keyword signals come only from measured static HTML; Kimi explains, never invents |
| Bounded, transparent work | Single page, static checks only, plain-language progress/errors |
| No hidden actions | No external submission; AI is opt-in via `NVIDIA_API_KEY` |
| Keep chat concise, preserve detail | Short in-chat summary + full `.md` if over threshold |
| Private by default | Allowlisted, private-chat only — same as all commands |

## Estimate

Small — roughly half a milestone. All primitives (engine, Kimi client, URL validation, Telegram UI patterns) already exist; this is composition, not invention.
