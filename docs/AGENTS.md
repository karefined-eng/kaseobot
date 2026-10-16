# kaseomator Agent Operating Manual

## Start here

1. Read [`origin.md`](origin.md) before proposing a scope, architecture, or user-workflow change.
2. Treat the user-provided kaseomator v1 BUILD_SPEC as the implementation contract; exploratory snippets are references, not proof that a feature is complete.
3. Work one milestone at a time and stop after its implementation, tests, documentation, and handoff are complete.
4. Keep secrets out of source, test output, logs, archives, and documentation. Never log Telegram Bot API request URLs because the token is embedded in the path.

## Architecture map

| Area | Responsibility |
|---|---|
| `src/index.ts` | Worker HTTP routes, webhook validation/allowlist, command dispatch, private retry callbacks, scheduled retention entry point |
| `src/jobs.ts` | D1 job creation, limits, queue production, owner-scoped status/cancel operations |
| `src/history.ts` | Owner-scoped history query, atomic `/forget`, and 30-day expiry cleanup |
| `src/telegram-ui.ts` | Inline keyboards, compact history formatting, callback acknowledgements |
| `src/queue-consumer.ts` | Idempotent audit execution, queue retry/dead-letter transitions, result persistence, Markdown/document delivery |
| `src/audits/` | URL/fetch safety, static SEO engine, canonical normalizer, GEO crawl/signals, storage, deterministic reports |
| `src/ai/` | Filtered audit input, Kimi client/prompt, Markdown-to-MarkdownV2 conversion, fallback orchestration |
| `migrations/` | Ordered D1 schema migrations; inspect before changing queries or retention |
| `test/` | Vitest unit/integration coverage; `test/fakes.ts` implements the narrow D1/queue test doubles |
| `wrangler.toml` | Worker bindings, queues, D1 migration path, nonsecret variables, and daily Cron Trigger |
| `docs/origin.md`, `docs/research/`, `docs/handoff/` | Product intent, cited workflow rationale, and permanent milestone walkthroughs |

## Useful checks

Run from the repository root (the directory containing `wrangler.toml`; `C:\Users\asamoah\kaseobot` on the machine this was set up on). These are POSIX-style snippets; on PowerShell 5.1 use the equivalents below.

```sh
rg -n "history|forget|retry|callback_query|sendDocument|seomator" src test README.md docs/README.md
rg -n "CREATE TABLE|CREATE INDEX|expires_at|FOREIGN KEY" migrations
npm run check
npm audit
npx wrangler deploy --dry-run
npx wrangler d1 migrations apply kaseobot-data --local
```

For noisy BUILD_SPEC searches, search one feature at a time and use bounded file-reader ranges. Validate D1 SQL with Wrangler's local D1 as well as test fakes. For packaging, exclude `node_modules`, `.wrangler`, `.dev.vars`, `.git`, and editor lock files. This workspace is a Git repository with `origin` = `karefined-eng/kaseobot`; use `git status`, `git log`, and `git fetch` normally, and do not `git init` it again.

## Tool quirks and environment traps

| Observed behavior or exact error | Workaround |
|---|---|
| Opening the full Telegram Bot API in the in-app browser returned `SNAPSHOT_TOO_LARGE`; the page had 50,001 nodes, over the 50,000-node safety budget. | Use targeted text fetches with a specific method/field query or a smaller anchored section; do not repeat the full-page snapshot. |
| A broad `rg ... | tail -360` over the attached BUILD_SPEC returned captured/truncated output rather than complete inline text. | Narrow the search and read bounded ranges; if a capture file is returned, read that file rather than rerunning the broad command. |
| `.~lock.wrangler.toml#` was an unrelated editor lock file in the project root. It is not present in the current checkout. | If it reappears, do not delete it automatically; exclude `kaseobot/.~lock.*` from archives. |
| V4A patch context can be ambiguous: one hunk reported `Found 2 places matching these lines` for repeated `await saveAuditResult(db, audit);`; another reported `Found 5 places matching these lines` for a bare `}`. A long `/help` line also produced `failed to find the lines to replace`. | Re-read a narrow range immediately before patching, use short unique context with surrounding control flow, and inspect the affected file immediately after a successful insertion. Do not use a bare brace or treat a `@@` context header as new content. |
| A helper insertion anchored only by `@@ function jobAcknowledgment(...)` was misplaced at the end of `src/index.ts`, leaving an incomplete duplicate and a truncated file. | Restore from the previously read source; for insertions include actual unchanged neighboring lines and verify the insertion location before continuing. Prefer a standalone module for reusable helpers. |
| `git status --short --branch` returned `fatal: not a git repository (or any of the parent directories): .git`. | Historical, from a non-Git workspace. The repository now exists, so this no longer reproduces. |
| On PowerShell 5.1, `git fetch`/`git pull` print progress to **stderr**. PowerShell wraps stderr from native commands in `NativeCommandError` / `RemoteException` and the run renders as a red failure ("git : From https://github.com/... At line:1 char:..."). | The exit code is still `0`, so the operation succeeded. Do not retry or "fix" it. Judge success from `git status -sb`, `git rev-list --left-right --count HEAD...origin/main`, and `git log -1` instead of from the stderr rendering. |
| npm 11.19.0 blocked the `esbuild` and `workerd` postinstall scripts (npm `install-scripts` warning) during `npm ci`. | Both still work: `esbuild.exe` and `workerd.exe` ship as prebuilt binaries, so the skipped script is harmless. Verify by running "npx --no-install wrangler deploy --dry-run" and "npm run check", not by trusting a "--version" probe. Do not re-run `npm ci` or approve scripts to "fix" it. |
| `Invoke-WebRequest` against the deployed Worker failed with "The request was aborted: Could not create SSL/TLS secure channel", and `curl.exe` reported `http_code=000`, which looks like the Worker being down. | PowerShell 5.1 defaults to TLS 1.0 and modern Cloudflare edges renegotiate, so the client-side handshake fails while the Worker is healthy. Either set `[Net.ServicePointManager]::SecurityProtocol = [Net.SecurityProtocolType]::Tls12` first, or use `curl.exe` and read its output on stdout — `curl.exe` is reported as a native-command error by PowerShell, so pipe it and inspect the body, and do not judge reachability from `%{http_code}=000` alone. |
| A live-route probe of `/health` returned `404`, suggesting a broken deployment. | The health route is `HEALTH_PATH = "/healthz"`, not `/health`. Read the route constants in `src/index.ts` before probing; the only two routes are `/healthz` (GET) and `/telegram/webhook` (POST). |
| The deploy refused to publish with "You need to register a workers.dev subdomain before publishing to workers.dev", and non-interactively answered its own prompt with "no". | Register the subdomain once per account via `PUT https://api.cloudflare.com/client/v4/accounts/<account_id>/workers/subdomain` with body `{"subdomain":"<name>"}`, then redeploy. Confirm with the matching `GET`. |
| Shell snippets written for POSIX do not run as-is on PowerShell 5.1: a leading env assignment such as `CI=1 npx wrangler d1 migrations apply kaseobot-data --local` fails, as does `&&` chaining. | Set the variable first and chain with `;`: `$env:CI=1; npx wrangler d1 migrations apply kaseobot-data --local`. |
| Cloudflare Containers is unavailable on the Workers Free plan: `wrangler containers list` returns `Unauthorized: You do not have access to Cloudflare Containers. Deploying containers requires the Workers Paid plan.` and `containers build --push` fails at the registry step with a bare `Unauthorized`. | Not a token or Docker problem. Containers needs Workers Paid ($5/mo) — there is no free tier. Deploy the Worker without the container using `wrangler deploy --containers-rollout=none` (works on Free, keeps the DO binding). Remove the flag after upgrading. |
| `wrangler-action@v3` defaults to Wrangler **3.90.0**, which lacks the `containers` subcommand, so container steps die with `Unknown arguments: tag, push, containers, build`. | Set `wranglerVersion: latest` on every `cloudflare/wrangler-action@v3` step. Verify by reading the action log line `npm i wrangler@<version>`. |
| Vitest fails to import the Worker once `@cloudflare/containers` is a dependency: `Cannot find package 'cloudflare:workers'`. | The SDK imports workerd-only modules. Stub them: `test/stubs/cloudflare-workers.ts` exporting inert `DurableObject`/`WorkerEntrypoint`, wired via a `resolve.alias` in `vitest.config.ts`. |
| `wrangler.toml` `[[containers]]` rejects `dir` and a bare directory for `image` (`./container-seomator is a directory, you should specify a path to the Dockerfile`). | Use `image = "./container-seomator/Dockerfile"` plus `name`, `class_name`, and `max_instances`. The container must be linked to a Durable Object class exported from the Worker entry. |
| A commit is blocked with `COMMIT BLOCKED - wrong git identity`. | Expected: a machine-wide pre-commit hook (`core.hooksPath` -> `~/.githooks`) enforces `karefined-eng <ka.refined@gmail.com>` on every commit in every repo, because the shell's `GIT_AUTHOR_*`/`GIT_COMMITTER_*` environment variables override git config. Set the four variables inline and re-run the same git command. Do not reach for `--no-verify`. |
| The editor file tools match content as LF, but this workspace checks out CRLF
| `npm ls -g` fails with `ENOENT` on `AppData\Roaming\AutoClaw-oversea-official\toolchain\node\prefix`, while global packages actually live in `AppData\Roaming\npm\`. | npm is configured with a broken global prefix pointing at a non-existent AutoClaw toolchain path. Use `npm ls -g --prefix $env:APPDATA\npm` or check `$env:APPDATA\npm` directly. Do not run `npm config set prefix` to "fix" it — it breaks the AutoClaw node wrapper. |
| The SEOmator CLI (`@seomator/seo-audit` v5.1.0) cannot be bundled into a Cloudflare Worker. The Worker bundle probe failed for v5.1.0, and the runtime takes ~100s (vs the Worker `AUDIT_TIMEOUT_MS=20000`). The adapter `SeomatorAuditEngine` exists but production intentionally falls back to the static engine. Options to use the reference engine: keep static + run CLI manually as a benchmark, or deploy SEOmator in Cloudflare Containers (account has `containers` scope) and call it over HTTP. Note: `docs/origin.md` excludes CWV/browser rendering from v1, so wiring it in is a scope change. |
| Invalid URL in `/audit`, `/geo`, or `/seomator` returns an error message to the user — it does **not** silently drop. The validation function `validateAndNormalizeUrl` returns `{ok:false, error:string}` and the handler replies with `reply = validated.error`. A silent drop (200 OK with no job) means the update reached the Worker but was rejected *before* the command handler — likely an allowlist mismatch (chat_id != user_id or non-private chat) or a `source_update_id` UNIQUE constraint violation on duplicate delivery. | (`core.autocrlf=true`, no `.gitattributes`). A match has failed with `workspace_edit_match_not_found` (disk CRLF, supplied text LF), and a successful editor edit injects LF lines into a CRLF file, leaving mixed endings that make git warn "LF will be replaced by CRLF". | For CRLF files, patch through PowerShell with `[IO.File]::ReadAllText` and `WriteAllText`, or re-normalize the whole file to CRLF after any editor-tool edit; confirm with a byte-level CRLF-vs-LF count. |

The documentation foundation was absent at Milestone 6 start; `docs/origin.md` and this manual were established from the user's standards, authoritative handoff, and current implementation. The M6 walkthrough belongs in `docs/handoff/`, and user-workflow rationale belongs in `docs/research/`.

### Additional M6 patch notes

A privacy-copy edit failed with `DeviceTextEditorUnsupportedError: failed to find context` because the supplied context accidentally repeated “report metadata”; the source sentence contained that phrase only once. A second edit returned `Please read the file content of /workspace/kaseobot/docs/README.md to understand it before making any edits.` Workaround: compare against the exact current source line and read each newly copied/created file before editing it. The rejected patches changed no content; the README was then read in full.

A local D1 probe's shell `EXIT` trap attempted two `DELETE` statements in one `wrangler d1 execute --command`; a later `SELECT` showed `probe_jobs=1, probe_audits=1`, so cleanup had not succeeded. The trap suppressed its own error with `|| true`, and the cause is unconfirmed. Workaround: issue each local `DELETE` separately, inspect the CLI result, then query both probe counts before stopping.

An archive exclusion check used `\.git` as a substring and falsely flagged the expected `.gitignore` file as a private Git directory, exiting with `Unexpected private/build artifact present in archive`. The archive itself passed `unzip -t`; workaround: match a `.git` directory boundary (`(^|/)\.git(/|$)`) rather than the `.git` prefix, then rerun the full archive check.
