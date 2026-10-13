import { afterEach, describe, expect, it, vi } from "vitest";
import worker, { type Env, type ExecutionContextLike } from "../src/index";
import { createAuditJob, type AuditJobMessage } from "../src/jobs";
import { cleanupExpiredHistory, forgetUserHistory } from "../src/history";
import { normalizeAuditResult } from "../src/audits/normalizer";
import { saveAuditResult } from "../src/audits/storage";
import { consumeAuditQueue, type QueueMessageLike } from "../src/queue-consumer";
import type { KaseobotAuditResult } from "../src/audits/types";
import { FakeD1, FakeQueue } from "./fakes";

const WEBHOOK_SECRET = "m6-test-secret";

function makeEnv(db = new FakeD1(), queue = new FakeQueue()): Env & { DB: FakeD1; AUDIT_QUEUE: FakeQueue } {
  return {
    DB: db,
    AUDIT_QUEUE: queue,
    TELEGRAM_BOT_TOKEN: "test-bot-token",
    TELEGRAM_WEBHOOK_SECRET: WEBHOOK_SECRET,
    ALLOWED_TELEGRAM_USER_IDS: "42,7",
    MAX_AUDITS_PER_USER_PER_HOUR: "10",
    MAX_CONCURRENT_AUDITS_PER_USER: "2",
  };
}

function makeContext(): ExecutionContextLike & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return { pending, waitUntil(promise) { pending.push(promise); } };
}

function postUpdate(update: unknown): Request {
  return new Request("https://kaseobot.test/telegram/webhook", {
    method: "POST",
    headers: {
      "content-type": "application/json",
      "X-Telegram-Bot-Api-Secret-Token": WEBHOOK_SECRET,
    },
    body: JSON.stringify(update),
  });
}

async function createJob(
  env: ReturnType<typeof makeEnv>,
  userId: number,
  url: string,
  updateId: number,
  type: "seo_audit" | "geo_audit" = "seo_audit",
) {
  return createAuditJob(env, { telegramUserId: userId, chatId: userId, url, updateId, type });
}

function callbackUpdate(jobId: string, userId = 42, updateId = 900) {
  return {
    update_id: updateId,
    callback_query: {
      id: `callback-${updateId}`,
      from: { id: userId, is_bot: false },
      message: { message_id: 31, chat: { id: userId, type: "private" } },
      data: `retry:${jobId}`,
    },
  };
}

function fakeMessage(body: AuditJobMessage) {
  return {
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies QueueMessageLike<AuditJobMessage>;
}

function sampleAudit(job: Awaited<ReturnType<typeof createJob>>["job"]): KaseobotAuditResult {
  return normalizeAuditResult({
    jobId: job.job_id,
    auditId: job.audit_id,
    type: job.type,
    url: job.url,
    requestedBy: job.telegram_user_id,
    startedAt: job.started_at ?? job.created_at,
    now: () => new Date(),
    engineResult: {
      engineName: "m6-test",
      engineVersion: "1",
      output: { overallScore: 75, categoryResults: [] },
    },
  });
}

afterEach(() => vi.unstubAllGlobals());

describe("Milestone 6 history and privacy", () => {
  it("/history lists only the requesting user's recent audit rows", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const own = await createJob(env, 42, "https://own.example/", 1);
    const another = await createJob(env, 7, "https://other.example/", 2);
    db.rows.get(own.job.job_id)!.status = "completed";
    db.rows.get(another.job.job_id)!.status = "completed";

    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = makeContext();
    const response = await worker.fetch(postUpdate({
      update_id: 1001,
      message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: "/history" },
    }), env, context);
    expect(response.status).toBe(200);
    await Promise.all(context.pending);

    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    const text = JSON.parse(String(init.body)).text as string;
    expect(text).toContain("https://own.example/");
    expect(text).not.toContain("https://other.example/");
    expect(text).toContain("/status ");
  });

  it("/forget deletes only the user's jobs and results and the write guard prevents resurrection", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const own = await createJob(env, 42, "https://own.example/", 10);
    const other = await createJob(env, 7, "https://other.example/", 11);
    const ownRow = db.rows.get(own.job.job_id)!;
    ownRow.status = "running";
    db.rows.get(other.job.job_id)!.status = "running";
    const ownAudit = sampleAudit(ownRow);
    expect(await saveAuditResult(db, ownAudit)).toBe(true);
    const otherAudit = sampleAudit(db.rows.get(other.job.job_id)!);
    expect(await saveAuditResult(db, otherAudit)).toBe(true);

    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = makeContext();
    const response = await worker.fetch(postUpdate({
      update_id: 1002,
      message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: "/forget" },
    }), env, context);
    expect(response.status).toBe(200);
    await Promise.all(context.pending);

    expect(db.rows.has(own.job.job_id)).toBe(false);
    expect(db.audits.has(own.job.audit_id)).toBe(false);
    expect(db.rows.has(other.job.job_id)).toBe(true);
    expect(db.audits.has(other.job.audit_id)).toBe(true);
    expect(await saveAuditResult(db, ownAudit)).toBe(false);
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain("cannot remove copies already delivered");
  });
});

describe("Milestone 6 retry and external fallback actions", () => {
  it("retries only the owning user's failed job from a private callback", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const env = makeEnv(db, queue);
    const failed = await createJob(env, 42, "https://example.com/retry", 20, "geo_audit");
    db.rows.get(failed.job.job_id)!.status = "failed";
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);

    const context = makeContext();
    const response = await worker.fetch(postUpdate(callbackUpdate(failed.job.job_id)), env, context);
    expect(response.status).toBe(200);
    await Promise.all(context.pending);

    expect(queue.messages).toHaveLength(2);
    expect(queue.messages[1].type).toBe("geo_audit");
    expect(queue.messages[1].url).toBe("https://example.com/retry");
    expect(queue.messages[1].telegramUserId).toBe("42");
    expect(db.rows.get(queue.messages[1].jobId)?.status).toBe("queued");
    expect(telegramFetch.mock.calls[0]?.[0]).toContain("answerCallbackQuery");
    const [, init] = telegramFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain("GEO audit job accepted");
  });

  it("attaches a retry button to exhausted-queue failure notices", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const env = makeEnv(db, queue);
    const job = await createJob(env, 42, "https://example.com/failed", 22);
    const message = fakeMessage(queue.messages[0]);
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-dead-letter", messages: [message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(db.rows.get(job.job.job_id)?.status).toBe("failed");
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).reply_markup).toEqual({
      inline_keyboard: [[{ text: "Retry audit", callback_data: `retry:${job.job.job_id}` }]],
    });
  });

  it("does not retry another user's failed job", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const env = makeEnv(db, queue);
    const failed = await createJob(env, 42, "https://private.example/", 21);
    db.rows.get(failed.job.job_id)!.status = "failed";
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);

    const context = makeContext();
    await worker.fetch(postUpdate(callbackUpdate(failed.job.job_id, 7, 901)), env, context);
    await Promise.all(context.pending);

    expect(queue.messages).toHaveLength(1); // Only the original job.
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ text: "This retry is no longer available." });
  });

  it("validates /seomator URLs and exposes the exact public SEO/GEO tool pages without auto-submitting", async () => {
    const env = makeEnv();
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = makeContext();
    await worker.fetch(postUpdate({
      update_id: 1003,
      message: { from: { id: 42, is_bot: false }, chat: { id: 42, type: "private" }, text: "/seomator https://example.com/path" },
    }), env, context);
    await Promise.all(context.pending);

    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    const payload = JSON.parse(String(init.body));
    expect(payload.text).toContain("https://example.com/path");
    expect(payload.text).toContain("does not submit the URL");
    expect(payload.reply_markup.inline_keyboard.flat().map((button: { url: string }) => button.url)).toEqual([
      "https://seomator.com/free-seo-audit-tool",
      "https://seomator.com/geo-audit-tool",
    ]);
    expect(telegramFetch.mock.calls).toHaveLength(1);
  });
});

describe("Milestone 6 long reports and scheduled retention", () => {
  it("sends the complete long source report as a Markdown document with a short measured summary", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const env = makeEnv(db, queue);
    const created = await createJob(env, 42, "https://long.example/", 30);
    const message = fakeMessage(queue.messages[0]);
    const fullMarkdown = `# Complete audit report\n\n${"Detailed issue and evidence.\n".repeat(180)}`;
    const reportGenerator = vi.fn(async () => ({
      markdown: fullMarkdown,
      markdownV2: "*Inline report omitted because this is long.*",
      ai: {
        provider: "nvidia" as const,
        model: "moonshotai/kimi-k3",
        used: false,
        requestId: null,
        error: null,
        reportMarkdown: fullMarkdown,
        reportMarkdownV2: "*Inline report omitted because this is long.*",
      },
    }));
    const engine = {
      auditPage: vi.fn(async ({ url }: { url: string }) => ({
        engineName: "m6-test",
        engineVersion: "1",
        output: {
          url,
          overallScore: 50,
          categoryResults: [{
            categoryId: "metadata",
            name: "Metadata",
            score: 50,
            results: [{ id: "title", title: "Title is missing", status: "fail", severity: "high", evidence: "No title found" }],
          }],
        },
      })),
    };
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true,"result":{"message_id":88}}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
      engine,
      reportGenerator,
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(db.rows.get(created.job.job_id)?.status).toBe("completed");
    expect(telegramFetch.mock.calls[0]?.[0]).toContain("sendDocument");
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(init.body).toBeInstanceOf(FormData);
    const form = init.body as FormData;
    expect(form.get("parse_mode")).toBe("MarkdownV2");
    expect(String(form.get("caption"))).toContain("Title is missing");
    const document = form.get("document") as File;
    expect(document.name).toMatch(/\.md$/);
    expect(await document.text()).toBe(fullMarkdown);
  });

  it("runs daily cleanup and removes expired terminal jobs and audit records", async () => {
    const db = new FakeD1();
    const env = makeEnv(db);
    const old = await createJob(env, 42, "https://expired.example/", 40);
    const recent = await createJob(env, 42, "https://recent.example/", 41);
    const now = Date.now();
    const oldRow = db.rows.get(old.job.job_id)!;
    oldRow.status = "completed";
    oldRow.created_at = new Date(now - 31 * 24 * 60 * 60 * 1000).toISOString();
    db.rows.get(recent.job.job_id)!.status = "completed";
    db.audits.set(old.job.audit_id, {
      audit_id: old.job.audit_id,
      job_id: old.job.job_id,
      telegram_user_id: "42",
      url: old.job.url,
      type: old.job.type,
      overall_score: 50,
      normalized_result: "{}",
      raw_result: "{}",
      created_at: oldRow.created_at,
      expires_at: new Date(now - 1).toISOString(),
    });

    const context = makeContext();
    worker.scheduled({ scheduledTime: now }, env, context);
    await Promise.all(context.pending);
    expect(db.rows.has(old.job.job_id)).toBe(false);
    expect(db.audits.has(old.job.audit_id)).toBe(false);
    expect(db.rows.has(recent.job.job_id)).toBe(true);
  });

  it("deletes expired orphan records during the cleanup helper as well", async () => {
    const db = new FakeD1();
    const now = Date.now();
    const result = await cleanupExpiredHistory(db, now);
    expect(result).toEqual({ deletedJobs: 0, deletedAudits: 0, deletedUsers: 0 });
    await expect(forgetUserHistory(db, "42")).resolves.toBeUndefined();
  });
});
