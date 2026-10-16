# Milestone 6 UX Rationale

## Decisions and implementation

### Keep `/history` compact and scannable

`/history` shows up to 10 recent terminal audits belonging to the requesting user, with website, audit type, status, time, and job ID; it includes an overall score when available. `/status <job_id>` remains the path to an individual job's detail. This prioritizes the most useful information and defers specialized detail, consistent with progressive disclosure.

### Make retry contextual and owner-checked

A failed-job notice places a clearly labeled **Retry audit** button beside the failure context. The webhook acknowledges the callback, requires an allowlisted private-chat user, and checks that the failed job belongs to that user before creating a new rate-limited job. The original job remains in history. No progress percentage or completion-time estimate is invented.

### Make `/forget` direct and transparent

`/forget` is an explicit user-initiated privacy command. It batch-deletes the caller's D1 audit rows, jobs, and user row and confirms after deletion. It does not expose or delete another user's records. Privacy copy explains that already delivered Telegram messages and data already sent to NVIDIA cannot be recalled. Queue writes require the owned job to still exist and be running, so an in-flight worker cannot recreate its saved result after deletion.

### Offer SEOmator as a user-chosen external route

`/seomator <url>` validates and displays the URL and shows two clearly labeled buttons for SEOmator's public SEO and GEO tools. kaseomator does not submit the URL, scrape results, or claim to have run the external audit. This keeps third-party processing an explicit user choice.

### Put the short result in chat and preserve the full report as a file

Reports longer than **3,500 characters** in either source Markdown or Telegram MarkdownV2 are sent as a short measured summary plus a complete `.md` document named `kaseomator-audit-{auditId}.md`. The caption includes audit type, URL, overall score, failed/warning counts, and up to three priority findings. Shorter reports remain inline. The complete source Markdown is persisted so a delivery retry does not need another Kimi request.

### Use scheduled cleanup and disclose its cadence

A Cloudflare Cron Trigger at `0 3 * * *` (daily at 03:00 UTC) removes expired terminal jobs/audit results and orphaned user rows. Completed audit results expire 30 days after result creation; terminal jobs without a result are eligible after 30 days from job creation. Active jobs are not removed by cleanup. `/forget` offers immediate user-initiated deletion.

## Research and platform evidence

- Nielsen Norman Group, [Progressive Disclosure](https://www.nngroup.com/articles/progressive-disclosure/) (Jakob Nielsen, 2006): recommends showing important options first and deferring specialized detail, supporting compact history/status views and an in-chat summary with the full report attached.
- Nielsen Norman Group, [User Control and Freedom](https://www.nngroup.com/articles/user-control-and-freedom/) (Maria Rosala, 2020): recommends clearly signposted recovery and user-control options, supporting contextual retry and clearly named `/forget` behavior.
- Telegram, [Bot API](https://core.telegram.org/bots/api): `sendMessage` is limited to 1–4096 characters after entity parsing; file uploads use `multipart/form-data`; `sendDocument` supports files up to the documented 50 MB limit and captions up to 1024 characters after entity parsing. The implementation uses a conservative 3,500-character threshold and a short caption.
- Telegram, [callback query documentation](https://core.telegram.org/bots/api#callbackquery): Telegram clients show progress until `answerCallbackQuery` is called; `callback_data` is limited to 1–64 bytes. Retry payloads remain short and contain only an action and job ID.

## Limits of this rationale

The cited Nielsen Norman Group articles are usability guidance, not user research with kaseomator's specific audience. The workflows should be checked with real users before later product expansion. Milestone 6 does not add a website UI, reports dashboard, SEOmator auto-submission, or PDF export.
