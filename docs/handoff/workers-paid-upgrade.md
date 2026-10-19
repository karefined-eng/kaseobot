# Workers Paid Upgrade — Next-Agent Handoff

**Status:** Prerequisites done, ready to execute.  
**Account:** `karefined-eng` (Cloudflare Workers Paid needed to activate `/deepaudit` Container).

---

## Why

The `/deepaudit` command ships a Cloudflare Container with the full SEOmator CLI (365 rules, ~100s, screenshots, priority action plan). Containers **require Workers Paid** ($5/mo floor); Free tier has no Container support.

Current state: `/deepaudit` is dormant and returns a plain-language message: *"Deep audit needs the Cloudflare Workers Paid plan ($5/mo) - Cloudflare Containers has no free tier."*

---

## Upgrade Steps (exact, in order)

### 1. Flip the account to Workers Paid
1. Open **https://dash.cloudflare.com** → select account **karefined-eng**.
2. Sidebar → **Workers & Pages** → **Plans**.
3. Click **Upgrade to Paid** → confirm **$5/month** (includes 10M req/mo + 30M CPU-ms/mo; overages $0.50/M after).
4. Confirm billing — the change is immediate.

### 2. Update the deploy workflow (one-line change)
File: `.github/workflows/deploy.yml`  
Find the **Deploy Worker** step and **remove** `--containers-rollout=none`:

```diff
- npx wrangler deploy --containers-rollout=none
+ npx wrangler deploy
```

Commit & push (conventional commit, identity enforced):
```bash
git add .github/workflows/deploy.yml
git commit -m "ci: enable Container rollout for /deepaudit"
git push origin main
```

### 3. Verify the Container rolls out
- Watch the **Deploy Kaseobot** workflow (GitHub Actions → Actions → Deploy Kaseobot).
- You should see a new job **Build & push Container** succeed (no `continue-on-error` anymore).
- The **Deploy Worker** step will print the Container image URL and the `kaseomator` worker URL.

### 4. End-to-end smoke test (in Telegram)
```
/deepaudit https://example.com --type=geo --crawl --max-pages=5 --mobile
```
Expect:  
- "Full deep audit · ~100s · ~$0.004 / Proceed on https://example.com?" → tap **Proceed**  
- ~100s later → Markdown report with category scores, findings grouped by category, priority action plan, and 3 base64 screenshots (full-page + desktop + mobile).

### 5. Optional: delete the old worker name (already done)
The legacy `kaseobot` worker was deleted on 2026-10-19. Nothing else to clean.

---

## What changes if you skip this

- `/deepaudit` stays dormant (returns the plan message).
- Everything else (SEO/GEO audits, history, retries, cron, etc.) continues to work on the Free tier — **no regression**.

---

## Cost Reality Check

| Metric | Free Tier | Paid (after upgrade) |
|---|---|---|
| Monthly floor | $0 | **$5** |
| Requests | 100k/day | 10M/mo included |
| CPU time | 10ms/invocation | 30M CPU-ms/mo included |
| Containers | ❌ blocked | ✅ ~$0.004 / deepaudit |
| D1 / Queues / DOs | generous free | same quotas, no floor |

**One `/deepaudit` ≈ 150 vCPU-s / 200 GB-s ≈ $0.004.**  
Even heavy usage (100 audits/mo) ≈ $0.40 — well inside the $5 floor.

---

## Next-Agent First 3 Actions

1. **Confirm the Paid upgrade** is visible in the dashboard (Workers & Pages → Plans → shows "Workers Paid").
2. **Make the one-line workflow change** above, commit/push, watch CI green.
3. **Run the smoke test** in Telegram; confirm the report arrives with screenshots.

---

*Generated at session close 2026-10-19. All M1–M9 features live; only this upgrade unblocks /deepaudit.*