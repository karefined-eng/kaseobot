# Kaseobot Agent Operating Manual

## Start here

1. Read [`origin.md`](origin.md) before proposing a scope, architecture, or user-workflow change.
2. Treat the user-provided Kaseobot v1 BUILD_SPEC as the implementation contract; exploratory snippets are references, not proof that a feature is complete.
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
| Shell snippets written for POSIX do not run as-is on PowerShell 5.1: a leading env assignment such as `CI=1 npx wrangler d1 migrations apply kaseobot-data --local` fails, as does `&&` chaining. | Set the variable first and chain with `;`: `$env:CI=1; npx wrangler d1 migrations apply kaseobot-data --local`. |
| The editor file tools match content as LF, but this workspace checks out CRLF (`core.autocrlf=true`, no `.gitattributes`). A match has failed with `workspace_edit_match_not_found` (disk CRLF, supplied text LF), and a successful editor edit injects LF lines into a CRLF file, leaving mixed endings that make git warn "LF will be replaced by CRLF". | For CRLF files, patch through PowerShell with `[IO.File]::ReadAllText` and `WriteAllText`, or re-normalize the whole file to CRLF after any editor-tool edit; confirm with a byte-level CRLF-vs-LF count. |

The documentation foundation was absent at Milestone 6 start; `docs/origin.md` and this manual were established from the user's standards, authoritative handoff, and current implementation. The M6 walkthrough belongs in `docs/handoff/`, and user-workflow rationale belongs in `docs/research/`.

### Additional M6 patch notes

A privacy-copy edit failed with `DeviceTextEditorUnsupportedError: failed to find context` because the supplied context accidentally repeated “report metadata”; the source sentence contained that phrase only once. A second edit returned `Please read the file content of /workspace/kaseobot/docs/README.md to understand it before making any edits.` Workaround: compare against the exact current source line and read each newly copied/created file before editing it. The rejected patches changed no content; the README was then read in full.

A local D1 probe's shell `EXIT` trap attempted two `DELETE` statements in one `wrangler d1 execute --command`; a later `SELECT` showed `probe_jobs=1, probe_audits=1`, so cleanup had not succeeded. The trap suppressed its own error with `|| true`, and the cause is unconfirmed. Workaround: issue each local `DELETE` separately, inspect the CLI result, then query both probe counts before stopping.

An archive exclusion check used `\.git` as a substring and falsely flagged the expected `.gitignore` file as a private Git directory, exiting with `Unexpected private/build artifact present in archive`. The archive itself passed `unzip -t`; workaround: match a `.git` directory boundary (`(^|/)\.git(/|$)`) rather than the `.git` prefix, then rerun the full archive check.
