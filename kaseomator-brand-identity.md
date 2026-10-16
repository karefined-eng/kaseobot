# kaseomator — Brand Identity Concept

Private Telegram SEO/GEO audit bot (@ka_seobot). Trustworthy, analytical, clean. Minimalist, no emojis, lucide-react style aesthetic.

---

## 1. Color palette

Hex codes chosen for WCAG AA contrast on light surfaces and for the Telegram dark/light theme switch. Primary is a deep slate (trust, data), accent is emerald (growth / improved rankings), secondary accent amber (CTAs / alerts), neutrals for structure and muted text.

| Role | Name | Hex | Usage |
|------|------|-----|-------|
| Primary | Slate 900 | `#0F172A` | Logo strokes, headings, primary buttons, borders |
| Primary (dimmed) | Slate 800 | `#1E293B` | Secondary headings, card surfaces |
| Accent | Emerald 500 | `#10B981` | "Pass" audit checks, growth indicators, primary CTA |
| Accent (soft) | Emerald 100 | `#D1FAE5` | Pass check backgrounds, success chips |
| Accent 2 | Amber 500 | `#F59E0B` | Warning checks, CTAs, active states |
| Accent 2 (soft) | Amber 100 | `#FEF3C7` | Warning backgrounds |
| Neutral | Slate 500 | `#64748B` | Muted labels, secondary text, dividers |
| Neutral (lighter) | Slate 400 | `#94A3B8` | Placeholder text, disabled states |
| Neutral (pale) | Slate 100 | `#F1F5F9` | Input fields, subtle backgrounds |
| Text | Slate 900 | `#0F172A` | Body copy, primary text |
| Text (muted) | Slate 600 | `#475569` | Secondary body text |
| Background | White | `#FFFFFF` | Base canvas |
| Background (alt) | Slate 50 | `#F8FAFC` | Section backgrounds |

Contrast notes (WCAG AA): `#10B981` on `#0F172A` ≈ 4.6:1; `#F59E0B` on `#FFFFFF` ≈ 4.5:1; `#64748B` on `#FFFFFF` fails AA at small sizes — reserve `#64748B` for decorative/muted elements only, never for body text.

Telegram avatar application: render the logo mark in `#0F172A` on a transparent PNG (Telegram crops to a circle); keep all graphic elements centered within the inner 70% of the 512×512 canvas so nothing is lost to the circular crop.

---

## 2. Logo concept (SVG-ready)

**Name mark:** `kaseomator` wordmark + `K` symbol mark. For the Telegram profile photo (circular crop, 512×512 recommended), use the symbol mark alone.

**Symbol concept:** a rounded-square "tool badge" containing a stylized letter `K` whose lower arm doubles as an ascending line-chart stroke — combining the brand initial (`K` for kaseomator) with SEO/audit ideas (rankings growth, audited data) and a bot/tool motif (badge enclosure). Thin, uniform 2–2.5px strokes, rounded caps/joins, no fill, no gradients, no emojis. Scales legibly down to ~150px (Telegram minimum) and works at 512×512.

**Construction (viewBox 0 0 32 32):**
- Outer rounded square (`rx="6"`): tool/badge container, stroke only
- Vertical spine at x=10 from y=8 to y=24: the `K` stem
- Upper arm from (10,12) to (22,8): top of the `K`
- Lower arm from (10,20) to (24,12): bottom of the `K`, angled upward to read as a rising audit/rankings line

Color: stroke `#0F172A` (primary), or single-color reversed (`#FFFFFF`) for dark backgrounds.

---

## 3. Typography

| Use | Font | Size | Weight | Notes |
|-----|------|------|--------|-------|
| Display / headings | Inter (or system-ui sans) | 20–32px | 600–700 | Telegram has no custom fonts; applies to web/landing surfaces |
| Body copy | Inter | ≥14px (craft floor ≥12px) | 400–500 | Line-height 1.5; measure ≤58ch for prose |
| Functional / meta text (badges, labels, timestamps, check names) | Inter | ≥11px (craft floor) | 500–600 | Letter-spacing 0.02em; uppercase optional for labels |
| Data / monospace (URLs, IDs, scores) | JetBrains Mono / Source Code Mono | 12–13px | 400 | For audit IDs, URLs, status codes |

Craft floor compliance: body copy never below 12px; functional UI text never below 11px. Avoid color-only state (pair pass/fail with check/x icons or text labels).

---

## 4. Inline SVG logo markup

Save as `kaseomator-logo.svg`. Single-color, stroke-based, 32×32 viewBox (export at 512×512 for Telegram).

```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#0F172A" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <!-- tool/badge container -->
  <rect x="4" y="4" width="24" height="24" rx="6"/>
  <!-- K vertical spine -->
  <path d="M10 8V24"/>
  <!-- K upper arm -->
  <path d="M10 12L22 8"/>
  <!-- K lower arm as ascending audit line -->
  <path d="M10 20L24 12"/>
</svg>
```

**Reversed (white on dark):**
```svg
<svg xmlns="http://www.w3.org/2000/svg" viewBox="0 0 32 32" fill="none" stroke="#FFFFFF" stroke-width="2.5" stroke-linecap="round" stroke-linejoin="round">
  <rect x="4" y="4" width="24" height="24" rx="6"/>
  <path d="M10 8V24"/>
  <path d="M10 12L22 8"/>
  <path d="M10 20L24 12"/>
</svg>
```

---

## 5. Application notes

- Telegram `@BotFather` → Edit Botpic: upload the SVG rasterized to a 512×512 PNG (transparent background), key graphic centered (Telegram crops to a circle).
- Display name: `kaseomator`; username: `@ka_seobot` (must end in `bot`, already compliant).
- Before launch: knockout trademark search for `kaseomator` / `kaseo` / `seobot` in USPTO TESS and WIPO (Class 9 software, Class 42 SaaS/SEO), and confirm `@ka_seobot` availability via BotFather. Not yet searched — treat as an open action.