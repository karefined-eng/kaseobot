# kaseomator — Telegram Rebrand Operations

**Bot:** kaseomator (display name) · `@ka_seobot` (username)
**Previous:** Kaseobot (`@KaseobotBot` per test fixtures) · legacy handle released on rename

## 1. BotFather steps (perform manually in Telegram)

1. Open a chat with `@BotFather`.
2. Send `/mybots` → select the existing bot → **Edit Bot**.
3. **Edit Name** → enter `kaseomator` (this is the display name users see).
4. **Edit Username** → enter `ka_seobot`.
   - Constraints: 5–32 chars, Latin letters/digits/underscores only, must end in `bot`. `ka_seobot` is valid at 9 chars.
   - **Availability:** confirm the handle is free before confirming; the old username is released immediately and can be snatched by others.
5. **Edit Description** / **Edit About** → refresh SEO-tool metadata for the new brand.
6. **Edit Botpic** → upload `kaseomator-profile-512.png` (512×512 transparent PNG; Telegram crops to a circle — keep the graphic centered within the inner 70%).
7. **Edit Commands** → update the `/` menu list if needed (already defined as `BOT_COMMANDS` in `src/index.ts`).

## 2. New brand assets (committed to this workspace)

| Asset | Path | Purpose |
|-------|------|---------|
| Logo SVG (primary) | `kaseomator-logo.svg` | Single-color stroke logo, `#0F172A`, viewBox 0 0 32 32 |
| Logo SVG (reversed) | `kaseomator-logo-white.svg` | Same logo in `#FFFFFF` for dark backgrounds |
| Telegram profile photo | `kaseomator-profile-512.png` | 512×512 RGBA transparent, upload via BotFather → Edit Botpic |
| Brand identity spec | `kaseomator-brand-identity.md` | Full palette, typography, logo concept, application notes |

Brand palette: Slate `#0F172A` primary, Emerald `#10B981` accent (pass/growth), Amber `#F59E0B` accent 2 (warnings/CTAs). Craft floor: body ≥12px, functional text ≥11px, prose measure ≤58ch, no emojis.

## 3. Open actions (before launch)

- [ ] **Trademark knockout search:** `kaseomator`, `kaseo`, `seobot` in USPTO TESS and WIPO Global Brand Database (Class 9 software, Class 42 SaaS/SEO services). Not yet searched — treat as `[PENDING_USER_REVIEW]`.
- [ ] **Confirm `@ka_seobot` availability** via `@BotFather` before finalizing the rename.
- [ ] Rename does not migrate subscribers, chat history, or inline-query settings. Users keep the bot via token, but old `t.me/KaseobotBot` links break. Communicate the new handle to allowlisted users.
