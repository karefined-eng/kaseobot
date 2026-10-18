# History Opt-Out — UX and Research Rationale

Milestone 9 turned the dead `history_enabled` column into a working retention toggle. This note records why the toggle is designed the way it is, grounded in documented cognitive and privacy research rather than generic aesthetics.

## Decision 1: opt-out via toggle, not a prompt or a paywall

**Design:** the `/history` reply always carries one inline button — "Turn history off" when retention is on, "Turn history on" when it is off. No extra command to memorize, no nested settings menu.

**Research grounding:**

- **Hick's law / choice fatigue.** A single binary control in the context where the user is already thinking about their data (the history list) avoids adding a new command to the help surface. The bot already exposes 14 commands; adding a 15th for a rarely-used preference would tax working memory for no functional gain (Miller's 7±2 chunking; Hick's law on decision latency).
- **Context of use.** Privacy controls are most discoverable at the moment the user is looking at their data (just-in-time disclosure), not buried in a settings surface they may never open.

## Decision 2: turning history off deletes stored data immediately

**Design:** the `hist:off` callback erases stored audits, regression snapshots, and terminal jobs right away; active jobs are purged the moment their report is delivered.

**Research grounding:**

- **Perceived control drives trust.** Privacy research consistently finds that giving users real, immediate control over their data (not just promises about future behavior) is what reduces privacy concern; a toggle that only affects *future* records would feel misleading the first time the user checks `/history` and still sees old rows.
- **Transparency matching behavior.** `docs/origin.md` principle 6 requires "Privacy copy must match actual runtime behavior." The `/privacy` text was updated to state exactly what is kept while history is off (Telegram ID, `created_at`, and the flag itself) — no more, no less.

## Decision 3: the opt-out is sticky through `/forget` and cleanup

**Design:** `/forget` deletes the preference row like everything else but immediately re-creates it with `history_enabled = 0`; the daily cleanup never deletes opted-out preference rows.

**Research grounding:**

- **Status quo / default bias** (Samuelson & Zeckhauser, 1988): people tend to stay with whatever state a system resets them to. If `/forget` silently reset the preference to "retain 30 days," an opted-out user would be re-enrolled into retention by their own deletion request — a dark-pattern-shaped outcome. Keeping the opt-out sticky means the *user's* last explicit choice remains the default.

## Decision 4: no retry button for failed audits while history is off

**Design:** failure notices for opted-out users drop the "Retry audit" inline button and explain why; the user can simply send the audit command again.

**Research grounding:**

- **Honest trade-off over hidden retention.** Retry requires storing the job row (URL, status). Silently keeping failed jobs "just for retry" would contradict the no-retention promise. Presenting the trade-off plainly follows the bot's zero-shame, blunt-re-entry voice from `docs/origin.md`: state the boundary, offer the immediate alternative action (run the audit again), and do not alarm or apologize.
- **Zeigarnik closure via immediate re-run.** A failed audit under opt-out still closes cleanly: the user re-issues one command and gets a fresh result, rather than a dead button.

## Decision 5: 24-hour cleanup backstop instead of claiming instant perfection

**Design:** the queue consumer purges immediately after confirmed delivery, but the daily cron also removes any opted-out leftovers older than 24 hours (for example a job that failed to enqueue).

**Research grounding:**

- **Expectation management.** Privacy copy that claims "instantly deleted" breaks trust the first time an edge case survives; copy that says "deleted right after delivery, leftovers within 24 hours" matches observable behavior. The `/privacy` text uses the latter wording on purpose.

## What this deliberately does not do

- No punitive or alarming framing anywhere: the off-state history reply is a neutral explanation plus the toggle, not a warning.
- No tag clouds, sort options, or granular per-audit deletion (Hick's law): retention is one binary choice plus `/forget` for everything.
- No changes to the design tokens, fonts, or the button-first main menu.
