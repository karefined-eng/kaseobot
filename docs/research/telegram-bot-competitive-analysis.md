# Telegram Bot Competitive Analysis — GitHub Star Leaders

**Source:** Live read of `https://github.com/topics/telegram` sorted "Most stars", Saturday 2026-10-17. Star counts are live snapshot numbers, not permanently verified. The "telegram" topic includes clients, libraries, and frameworks — not every entry is strictly a Telegram bot. Type is noted per row so kaseobot can separate signal from noise.

## Top repositories by stars (snapshot)

| # | Repo | Stars | Lang | Type | What it is |
|---|------|-------|------|------|------------|
| 1 | `DIYgod/RSSHub` | 46.5k | TypeScript | Utility | RSS generator; Telegram is one output channel |
| 2 | `AstrBotDevs/AstrBot` | 42k | Python | AI agent framework | Multi-IM agent framework incl. Telegram, QQ, Discord |
| 3 | `telegramdesktop/tdesktop` | 33.3k | C++ | Client | Telegram Desktop app (not a bot) |
| 4 | `tqdm/tqdm` | 31.4k | Python | Utility | CLI progress bar (tangential to Telegram) |
| 5 | `DrKLO/Telegram` | 30.1k | Java | Client | Telegram for Android (not a bot) |
| 6 | `python-telegram-bot/python-telegram-bot` | 29.5k | Python | Library | Canonical Python Telegram Bot API library |
| 7 | `pppscn/SmsForwarder` | 28.5k | Kotlin | Utility | SMS forwarder with Telegram support |
| 8 | `AZeC4/TelegramGroup` | 23.5k | — | Bot | Telegram group bot |
| 9 | `elizaOS/eliza` | 19.6k | TypeScript | AI agent framework | Multi-platform agent framework incl. Telegram |
| 10 | `lss233/kirara-ai` | 19.1k | Python | Bot | Telegram AI chatbot |

Also notable just outside top 10:
- `yagop/node-telegram-bot-api` — 9.2k, TypeScript, Node.js Telegram Bot library
- `telegraf/telegraf` — 9.2k, TypeScript, Node.js Telegram bot framework
- `eternnoir/pyTelegramBotAPI` — 8.8k, Python, Python Telegram Bot API library

## Patterns that drive stars

| Pattern | Examples | Why it wins |
|---------|----------|-------------|
| **Infrastructure > end-user bot** | `python-telegram-bot` (~29.5k), `pyTelegramBotAPI` (~8.8k), `telegraf` (~9.2k), `node-telegram-bot-api` (~9.2k) | Libraries get starred by thousands of developers building *their own* bots. A bot gets users; a library gets an ecosystem. |
| **Multi-protocol extensibility** | `AstrBot` (~42k), `elizaOS` (~19.6k) | Telegram-first but architected to add WhatsApp/Discord/LINE without rewriting. |
| **AI/LLM integration** | `kirara-ai` (~19.1k), `AstrBot`, `elizaOS` | AI bots are the current growth vector; plain rule-based bots plateau. |
| **Narrow scope done perfectly** | `RSSHub` (~46.5k), `python-telegram-bot` | One job, rock-solid. No kitchen sink. |
| **Copy-paste onboarding** | All top 10 | README has a working example you can run in 60 seconds. |
| **Active maintenance** | Recent commit dates visible on every entry | Abandoned repos don't trend. |

## What kaseobot should adopt

1. **Position kaseomator as SEO/GEO infrastructure, not just another bot.**  
   If kaseobot exposes audit utilities (static SEO checks, GEO signals, keyword/canonical analysis), document that surface like a library — typed, example-first, easy to invoke. Libraries star; bots just get used.

2. **Add one AI/SEO command.**  
   The trending bots all integrate LLMs (content drafting, keyword expansion, summary). kaseobot's SEO + Telegram fit is natural: `/audit`, `/geo`, `/keywords` style commands. This is the trend vector, not a scope violation — kaseobot already runs filtered Kimi analysis per `docs/origin.md`.

3. **Stay Telegram-first, architecture-open.**  
   AstrBot and elizaOS prove you can start with Telegram and add platforms later. Don't build a Telegram client (wrong layer — `tdesktop`/`DrKLO/Telegram` territory). Keep the core portable.

4. **README as marketing.**  
   Stars come from discoverability. A clear one-line value prop ("Telegram-first SEO and GEO audit assistant"), copy-paste `/start` example, command list, and test-passing badge convert visitors more than a sparse README.

5. **Guard the brand consistency already built.**  
   kaseobot rebranded to kaseomator with Slate/Emerald/Amber, committed logos, `kaseomator-brand-identity.md`, and `docs/branding-rebrand.md`. The top repos all have polished visual identity. Keep repo README, Telegram profile, and avatar aligned so the brand looks intentional.

6. **Keep contribution-friendly repo hygiene (already started).**  
   `CONTRIBUTING.md`, `CODEOWNERS`, `SECURITY.md`, migrations, 102 passing tests, typecheck clean — this matches the top repos. Keep tests green on every push.

## What NOT to copy

- **Don't build a Telegram client** (`tdesktop`, `DrKLO/Telegram`) — kaseobot is a bot/audit layer, not a messaging app.
- **Don't chase generic utilities** (`tqdm` progress bars, `SmsForwarder`) — irrelevant to SEO/GEO.
- **Don't bloat scope** — the top repos do one thing, not everything. `docs/origin.md` milestone discipline (one milestone at a time, no browser rendering/Playwright/Lighthouse/CWV/PDF in v1) still governs.

## Alignment with kaseobot origin principles

| Origin principle | Competitive-analysis implication |
|------------------|----------------------------------|
| Private by default, allowlisted users | Star-leader bots are public; kaseobot's allowlist is a deliberate differentiator, not a gap. Document it in the README as a privacy feature. |
| Evidence before interpretation | Matches `python-telegram-bot`-style transparency: show measured results, don't invent scores. |
| Bounded, transparent work | Mirrors "narrow scope done perfectly" — 12 static checks, 5-page GEO cap, plain-language progress/errors. |
| No hidden actions | Matches SEOmator-button pattern: external processing is an explicit user choice, never auto-submitted. |
| Keep chat concise, preserve detail | Matches RSSHub's one-job-do-it-well ethos: short in-chat summary + full `.md` attachment. |

## Decision log (assumptions register)

- `[PENDING_USER_REVIEW]` Adding an AI/keyword command is assumed to be in scope. It fits `docs/origin.md` (Kimi analysis already exists) but is a scope addition beyond Milestones 1–8; confirm before implementing.
- `[PENDING_USER_REVIEW]` Making the repo public is a GitHub Settings action requiring the user's auth; cannot be done by the agent.
- Star counts above are snapshot values from 2026-10-17 and may have changed; treat as directional, not canonical.

## Related files

- `docs/origin.md` — product intent and scope boundaries
- `docs/research/milestone-6-ux-rationale.md` — cited UX rationale (progressive disclosure, user control, Telegram API limits)
- `docs/handoff/milestone-8-button-ui.md` — button-first UI implementation
- `docs/AGENTS.md` — local agent operating manual
