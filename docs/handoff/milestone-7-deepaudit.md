# Milestone 7 — `/deepaudit` Container Integration Handoff

**Status:** Code complete, deployed, and **dormant by plan gate**. The Worker ships with the Durable Object binding live; the container itself cannot roll out until the account moves to the Workers Paid plan.

---

## Why this milestone exists

The static engine scores optimistically. A side-by-side run of the reference engine proved it:

| Engine | Score | Coverage | Runtime |
|---|---|---|---|
| Kaseobot static (production) | **100/100** | 12 checks | ~0.5s |
| SEOmator CLI v5.1.0 | **96/100 (A)** | 365 rules / 20 categories | **100.8s** |

The reference found three category failures the static engine cannot see (Technical SEO, Performance, Content 89%). It cannot run inside a Worker: V8 isolates have no `fs`, no `child_process`, no browser, and the 100s runtime exceeds the Worker budget. Hence a container.

---

## What was built

| Piece | Detail |
|---|---|
| `container-seomator/Dockerfile` | `node:22-slim` + Chromium system libs + `@seomator/seo-audit` + `playwright`, version-matched browser install |
| `container-seomator/server.js` | HTTP server, `POST /audit`. Returns a **Markdown** report (not JSON) with category score table, findings grouped by category, a priority action plan for an agent, and full-page + desktop + mobile screenshots as base64 data URIs. `GET /health`, `GET /categories`. |
| `src/seomator-container.ts` | `SeomatorContainer extends Container` (from `@cloudflare/containers`), `defaultPort = 3000`, `sleepAfter = "15m"`, plus the minimal `SeomatorContainerNamespace` structural type |
| `src/index.ts` | `/deepaudit <url>` with flags `--type=seo-full\|geo\|quick\|custom`, `--categories`, `--crawl`, `--max-pages`, `--mobile`, `--concurrency`, `--timeout`, `--user-agent`. Calls the DO stub; maps entitlement failures to a plain-language message. |
| `wrangler.toml` | `[[containers]]` with `name`, `class_name`, `image = "./container-seomator/Dockerfile"`, `max_instances = 1`; `[durable_objects]` binding `SEOMATOR_CONTAINER`; migration `v1` `new_sqlite_classes = ["SeomatorContainer"]` |

Requests reach the container by stub-fetching the DO: `stub.fetch("http://container/audit", ...)` is proxied to container port 3000.

---

## The plan gate (the one blocker)

Cloudflare Containers **requires the Workers Paid plan ($5/mo)**. There is no free tier. Verified directly:

```
$ wrangler containers list
Unauthorized: You do not have access to Cloudflare Containers.
Deploying containers requires the Workers Paid plan.
```

The failure signature is misleading: the Docker build succeeds in CI and only the **registry push** returns a bare `Unauthorized`, which looks like a token problem. It is not — the token is correct.

**Decision on record:** stay on the free plan for now. Everything else runs there.

---

## Current production behaviour

| Surface | Free plan |
|---|---|
| `/audit`, `/geo`, `/status`, `/cancel`, `/history`, `/forget`, `/seomator`, `/privacy` | Working |
| GEO crawls, Kimi analysis, retry buttons, 30-day retention, cron cleanup | Working |
| Auto-deploy on push to `main` | Working (verified: run `38919121808`, version `e903ee0e`) |
| `/deepaudit` | Dormant. Replies with the plan requirement, not a raw error. |

Deploy uses `--containers-rollout=none`, which ships the Worker and the DO binding while skipping the container. The `[[containers]]` block stays valid on free; only the rollout is skipped.

---

## To activate after upgrading to Workers Paid

1. Remove ` --containers-rollout=none` from the `Deploy Worker` step in `.github/workflows/deploy.yml`.
2. Remove `continue-on-error: true` from the `Build & push Container` step (so a real failure fails the build).
3. Push to `main`. The workflow builds the image, pushes to the managed registry, and rolls the container out.
4. Verify in Telegram: `/deepaudit https://example.com --type=geo --crawl --max-pages=5 --mobile`.

No code changes are required — the entire path is already built and tested.

---

## Validation performed

| Check | Result |
|---|---|
| `npm run check` | TypeScript clean, 102 tests pass |
| `wrangler deploy --dry-run --containers-rollout=none` | 166.11 KiB / 41.54 KiB gzip; all bindings resolve including `SEOMATOR_CONTAINER (SeomatorContainer)` |
| `wrangler deploy --containers-rollout=none` (real) | Deployed, version `233b1e4a` |
| Live `/healthz` after deploy | 200 `{"ok":true,"service":"kaseobot"}` |
| Live webhook auth gates | 401 without secret, 200 with correct secret |
| CI/CD run `38919121808` | Green; Deploy Worker step uploaded and deployed version `e903ee0e` |
| Docker image build (GitHub Actions) | Succeeded — full Chromium + Playwright layer built |

---

## Known caveats

- **`max_instances = 1`** — the DO uses `idFromName("seomator")`, so audits serialize through one container. Raise `max_instances` and shard the DO name if concurrency is needed.
- **Costs on Paid:** ~$0.004 per audit at ~150 vCPU-s and ~200 GB-s; Container startup is 3–5s cold, then warm for `sleepAfter`.
- **Screenshots are base64 in the Markdown** — reports with three screenshots are large. Telegram delivery of such a report through the Worker has not been exercised; long reports fall back to `sendDocument` (>3,500 chars), which is the intended path.
- **`wrangler-action@v3` defaults to Wrangler 3.90.0**, which has no `containers` subcommand. Every action step in this repo must keep `wranglerVersion: latest`.
