import { readFileSync } from "node:fs";
import { afterEach, describe, expect, it, vi } from "vitest";
import worker, {
  parseTelegramCommand,
  routeCommand,
  type Env,
  type ExecutionContextLike,
} from "../src/index";
import {
  cancelAuditJob,
  createAuditJob,
  getJobStatusMessage,
  UserFacingError,
  type JobEnvironment,
} from "../src/jobs";
import { consumeAuditQueue, type QueueMessageLike } from "../src/queue-consumer";
import { StaticHtmlAuditEngine } from "../src/audits/static-html-engine";
import { AuditEngineError } from "../src/audits/types";
import { validateAndNormalizeUrl } from "../src/url-validation";
import { FakeD1, FakeQueue } from "./fakes";

const TEST_SECRET = "unit-test-webhook-secret";
const VALID_AUDIT_FIXTURE = readFileSync(new URL("./fixtures/valid-page.html", import.meta.url), "utf8");
const MISSING_TITLE_FIXTURE = readFileSync(new URL("./fixtures/missing-title.html", import.meta.url), "utf8");
const env: Env = {
  TELEGRAM_BOT_TOKEN: "unit-test-bot-token",
  TELEGRAM_WEBHOOK_SECRET: TEST_SECRET,
  ALLOWED_TELEGRAM_USER_IDS: "42, 7",
};

function fixtureAuditEngine(html = VALID_AUDIT_FIXTURE, fetchPage = vi.fn(async ({ url }: { url: string }) => ({ url, html, status: 200 }))) {
  return {
    engine: new StaticHtmlAuditEngine({ fetch: fetchPage }, () => new Date("2026-01-23T16:00:00.000Z")),
    fetchPage,
  };
}

function createContext(): ExecutionContextLike & { pending: Promise<unknown>[] } {
  const pending: Promise<unknown>[] = [];
  return {
    pending,
    waitUntil(promise) {
      pending.push(promise);
    },
  };
}

function update(userId = 42, text = "/start", chatType = "private", updateId = 100) {
  return {
    update_id: updateId,
    message: {
      message_id: 1,
      from: { id: userId, is_bot: false, first_name: "Test" },
      chat: { id: userId, type: chatType },
      text,
    },
  };
}

function webhookRequest(body: unknown, secret: string | null = TEST_SECRET): Request {
  const headers = new Headers({ "content-type": "application/json" });
  if (secret !== null) headers.set("X-Telegram-Bot-Api-Secret-Token", secret);
  return new Request("https://kaseobot.test/telegram/webhook", {
    method: "POST",
    headers,
    body: JSON.stringify(body),
  });
}

function runtimeEnv(db = new FakeD1(), queue = new FakeQueue()): Env & { DB: FakeD1; AUDIT_QUEUE: FakeQueue } {
  return {
    ...env,
    DB: db,
    AUDIT_QUEUE: queue,
    MAX_AUDITS_PER_USER_PER_HOUR: "10",
    MAX_CONCURRENT_AUDITS_PER_USER: "2",
  };
}

function fakeQueueMessage(body: unknown, attempts = 1) {
  const ack = vi.fn();
  const retry = vi.fn();
  return {
    message: { body, attempts, ack, retry } as QueueMessageLike<unknown>,
    ack,
    retry,
  };
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("Telegram webhook authentication", () => {
  it("rejects a missing secret without processing the update", async () => {
    const context = createContext();
    const response = await worker.fetch(webhookRequest(update(), null), env, context);

    expect(response.status).toBe(401);
    expect(context.pending).toHaveLength(0);
  });

  it("rejects an incorrect secret without processing the update", async () => {
    const context = createContext();
    const response = await worker.fetch(webhookRequest(update(), "wrong-secret"), env, context);

    expect(response.status).toBe(401);
    expect(context.pending).toHaveLength(0);
  });
});

describe("Telegram user access control", () => {
  it("responds quickly to an authorized private user and schedules the reply", async () => {
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = createContext();

    const response = await worker.fetch(webhookRequest(update()), env, context);

    expect(response.status).toBe(200);
    expect(context.pending).toHaveLength(1);
    await Promise.all(context.pending);
    expect(telegramFetch).toHaveBeenCalledTimes(1);
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({
      chat_id: 42,
      text: "Welcome to Kaseobot.\n\nUse /help to see available commands.",
    });
  });

  it("silently acknowledges a user outside the allowlist", async () => {
    const telegramFetch = vi.fn();
    vi.stubGlobal("fetch", telegramFetch);
    const context = createContext();

    const response = await worker.fetch(webhookRequest(update(999, "/start")), env, context);

    expect(response.status).toBe(200);
    expect(context.pending).toHaveLength(0);
    expect(telegramFetch).not.toHaveBeenCalled();
  });

  it("does not respond to group messages", async () => {
    const telegramFetch = vi.fn();
    vi.stubGlobal("fetch", telegramFetch);
    const context = createContext();

    const response = await worker.fetch(webhookRequest(update(42, "/help", "group")), env, context);

    expect(response.status).toBe(200);
    expect(context.pending).toHaveLength(0);
    expect(telegramFetch).not.toHaveBeenCalled();
  });
});

describe("command parsing and routing", () => {
  it("parses a command, bot mention, and trimmed arguments", () => {
    expect(parseTelegramCommand("/AUDIT@KaseobotBot  https://example.com ")).toEqual({
      name: "audit",
      botUsername: "KaseobotBot",
      args: "https://example.com",
    });
  });

  it("returns null for ordinary text", () => {
    expect(parseTelegramCommand("https://example.com")).toBeNull();
  });

  it("routes the supported commands and handles unknown commands", () => {
    expect(routeCommand({ name: "start", args: "" })).toContain("Welcome to Kaseobot");
    expect(routeCommand({ name: "help", args: "" })).toContain("/status");
    expect(routeCommand({ name: "help", args: "" })).toContain("/geo <url>");
    expect(routeCommand({ name: "help", args: "" })).toContain("five same-origin pages");
    expect(routeCommand({ name: "privacy", args: "" })).toContain("Telegram user ID");
    expect(routeCommand({ name: "future", args: "" })).toContain("I don't recognize /future");
  });
});

describe("URL validation and normalization", () => {
  it("normalizes an explicit public HTTPS URL, keeps the query, and removes fragments", () => {
    expect(validateAndNormalizeUrl("https://Example.com/path?q=seo#section")).toEqual({
      ok: true,
      url: "https://example.com/path?q=seo",
    });
  });

  it.each([
    [undefined, "missing URL"],
    ["", "empty URL"],
    ["example.com", "missing explicit scheme"],
    ["ftp://example.com", "non-HTTP scheme"],
    ["https://example.com https://other.example", "multiple URLs"],
    ["http://localhost", "localhost"],
    ["http://service.local", "local hostname"],
    ["http://metadata.google.internal", "internal hostname"],
    ["http://127.0.0.1", "loopback IPv4"],
    ["http://2130706433", "integer-encoded loopback IPv4"],
    ["http://10.1.2.3", "private IPv4"],
    ["http://172.31.255.255", "private 172.16/12 IPv4"],
    ["http://192.168.1.1", "private 192.168/16 IPv4"],
    ["http://169.254.169.254/latest/meta-data/", "link-local metadata IPv4"],
    ["http://[::1]/", "IPv6 loopback"],
    ["http://[fe80::1]/", "IPv6 link-local"],
    ["http://[fd00::1]/", "IPv6 unique-local"],
    ["https://user:pass@example.com", "embedded credentials"],
    ["https://example.com/" + "a".repeat(2048), "overlong URL"],
  ])("rejects %s (%s)", (input, _label) => {
    expect(validateAndNormalizeUrl(input)).toMatchObject({ ok: false });
  });

  it("accepts public IPv4 and IPv6 literals", () => {
    expect(validateAndNormalizeUrl("https://8.8.8.8/")).toMatchObject({ ok: true });
    expect(validateAndNormalizeUrl("https://[2001:4860:4860::8888]/")).toMatchObject({ ok: true });
  });
});

describe("audit job creation and queue production", () => {
  it("creates a queued SEO job with a durable queue message", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 777,
    });

    expect(result.job.status).toBe("queued");
    expect(result.enqueued).toBe(true);
    expect(result.duplicate).toBe(false);
    expect(result.job.job_id).toMatch(/^[0-9a-f-]{36}$/i);
    expect(queue.messages).toEqual([{
      jobId: result.job.job_id,
      auditId: result.job.audit_id,
      telegramUserId: "42",
      chatId: "42",
      type: "seo_audit",
      url: "https://example.com/",
      attempt: 1,
    }]);
  });

  it("deduplicates Telegram webhook redelivery by update_id", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const jobEnv = runtimeEnv(db, queue);
    const first = await createAuditJob(jobEnv, {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 778,
    });
    const duplicate = await createAuditJob(jobEnv, {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 778,
    });

    expect(duplicate.job.job_id).toBe(first.job.job_id);
    expect(duplicate.duplicate).toBe(true);
    expect(db.rows.size).toBe(1);
    expect(queue.messages).toHaveLength(2); // Same jobId; the consumer is idempotent.
    expect(queue.messages[0].jobId).toBe(queue.messages[1].jobId);
  });

  it("enforces per-user hourly and active-job limits", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const limited: JobEnvironment = {
      ...runtimeEnv(db, queue),
      MAX_AUDITS_PER_USER_PER_HOUR: "1",
      MAX_CONCURRENT_AUDITS_PER_USER: "1",
    };
    await createAuditJob(limited, {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 779,
    });

    await expect(createAuditJob(limited, {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.org/",
      updateId: 780,
    })).rejects.toBeInstanceOf(UserFacingError);
  });

  it("does not let simultaneous requests exceed the active-job limit", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const limited: JobEnvironment = {
      ...runtimeEnv(db, queue),
      MAX_AUDITS_PER_USER_PER_HOUR: "10",
      MAX_CONCURRENT_AUDITS_PER_USER: "1",
    };
    const attempts = await Promise.allSettled([
      createAuditJob(limited, { telegramUserId: 42, chatId: 42, url: "https://one.example/", updateId: 800 }),
      createAuditJob(limited, { telegramUserId: 42, chatId: 42, url: "https://two.example/", updateId: 801 }),
    ]);

    expect(attempts.filter((attempt) => attempt.status === "fulfilled")).toHaveLength(1);
    const rejected = attempts.find((attempt) => attempt.status === "rejected");
    expect(rejected?.status === "rejected" ? rejected.reason : undefined).toBeInstanceOf(UserFacingError);
    expect(db.rows.size).toBe(1);
    expect(queue.messages).toHaveLength(1);
  });

  it("marks a job failed if queue enqueue fails", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    queue.failNextSend = true;
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 781,
    });

    expect(result.enqueued).toBe(false);
    expect(result.job.status).toBe("failed");
    expect(result.job.error).toContain("queue could not accept");
  });
});

describe("job status and cancellation", () => {
  it("returns status and elapsed time only to the owning user", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 782,
    });

    const status = await getJobStatusMessage(db, result.job.job_id, 42, Date.parse(result.job.created_at) + 61_000);
    const hidden = await getJobStatusMessage(db, result.job.job_id, 7);

    expect(status).toContain("Status: queued");
    expect(status).toContain("Elapsed: 1m 1s");
    expect(hidden).toBe("I couldn't find that job.");
  });

  it("cancels queued jobs and requests cancellation for running jobs", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const queued = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 783,
    });
    expect(await cancelAuditJob(db, queued.job.job_id, 42)).toBe("Job canceled.");
    expect(db.rows.get(queued.job.job_id)?.status).toBe("canceled");

    const running = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.org/",
      updateId: 784,
    });
    const row = db.rows.get(running.job.job_id)!;
    row.status = "running";
    expect(await cancelAuditJob(db, running.job.job_id, 42)).toContain("Cancellation requested");
    expect(row.status).toBe("cancel_requested");
  });
});

describe("audit queue consumer", () => {
  it("runs a static audit, stores normalized/raw output, delivers a deterministic report, and completes the job", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 785,
    });
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true,"result":{"message_id":55}}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const { message, ack, retry } = fakeQueueMessage(queue.messages[0]);
    const { engine } = fixtureAuditEngine(MISSING_TITLE_FIXTURE);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
      engine,
    );

    expect(ack).toHaveBeenCalledOnce();
    expect(retry).not.toHaveBeenCalled();
    expect(db.rows.get(result.job.job_id)?.status).toBe("completed");
    expect(db.rows.get(result.job.job_id)?.result_summary_message_id).toBe("55");
    const saved = db.audits.get(result.job.audit_id)!;
    const normalized = JSON.parse(saved.normalized_result);
    expect(normalized).not.toHaveProperty("raw");
    expect(normalized.ai).toMatchObject({ provider: "nvidia", used: false, requestId: null });
    expect(JSON.parse(saved.raw_result)).toMatchObject({ categoryResults: expect.any(Array) });
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    const body = JSON.parse(String(init.body));
    expect(body.parse_mode).toBe("MarkdownV2");
    expect(body.text).toContain("Page title is present");
    expect(body.text).toContain("1 failed");
  });

  it("acknowledges duplicate delivery for a terminal job without changing it", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 786,
    });
    const first = fakeQueueMessage(queue.messages[0]);
    const duplicate = fakeQueueMessage(queue.messages[0]);
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const { engine, fetchPage } = fixtureAuditEngine();

    await consumeAuditQueue({ queue: "kaseobot-audit-jobs", messages: [first.message] }, { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN }, engine);
    await consumeAuditQueue({ queue: "kaseobot-audit-jobs", messages: [duplicate.message] }, { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN }, engine);

    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(db.rows.get(result.job.job_id)?.status).toBe("completed");
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(telegramFetch).toHaveBeenCalledOnce();
  });

  it("acknowledges a simultaneous first-delivery duplicate without a second audit", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 7860,
    });
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    let releaseAudit: () => void = () => {};
    const gate = new Promise<void>((resolve) => { releaseAudit = resolve; });
    const fetchPage = vi.fn(async ({ url }: { url: string }) => {
      await gate;
      return { url, html: VALID_AUDIT_FIXTURE, status: 200 };
    });
    const engine = new StaticHtmlAuditEngine({ fetch: fetchPage }, () => new Date("2026-01-23T16:00:00.000Z"));
    const first = fakeQueueMessage(queue.messages[0], 1);
    const duplicate = fakeQueueMessage(queue.messages[0], 1);

    const firstProcessing = consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [first.message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
      engine,
    );
    await vi.waitFor(() => expect(fetchPage).toHaveBeenCalledOnce());
    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [duplicate.message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
      engine,
    );
    releaseAudit();
    await firstProcessing;

    expect(first.ack).toHaveBeenCalledOnce();
    expect(duplicate.ack).toHaveBeenCalledOnce();
    expect(db.rows.get(result.job.job_id)?.status).toBe("completed");
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(telegramFetch).toHaveBeenCalledOnce();
  });

  it("reuses a saved audit after transient Telegram failure", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 7861,
    });
    const telegramFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":false}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"message_id":56}}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const { engine, fetchPage } = fixtureAuditEngine();
    const first = fakeQueueMessage(queue.messages[0], 1);

    await consumeAuditQueue({ queue: "kaseobot-audit-jobs", messages: [first.message] }, { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN }, engine);
    expect(first.retry).toHaveBeenCalledWith({ delaySeconds: 2 });
    expect(db.rows.get(result.job.job_id)?.status).toBe("running");
    expect(db.audits.size).toBe(1);

    const retry = fakeQueueMessage(queue.messages[0], 2);
    await consumeAuditQueue({ queue: "kaseobot-audit-jobs", messages: [retry.message] }, { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN }, engine);
    expect(retry.ack).toHaveBeenCalledOnce();
    expect(db.rows.get(result.job.job_id)?.status).toBe("completed");
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(telegramFetch).toHaveBeenCalledTimes(2);
  });

  it("delivers a Kimi report as MarkdownV2 and reuses it without a second model call after retry", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 7863,
    });
    const telegramFetch = vi.fn()
      .mockResolvedValueOnce(new Response('{"ok":false}', { status: 503 }))
      .mockResolvedValueOnce(new Response('{"ok":true,"result":{"message_id":57}}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const { engine, fetchPage } = fixtureAuditEngine();
    const kimiReport = "*Kimi priority report*";
    const reportGenerator = vi.fn(async () => ({
      markdown: "# Kimi priority report",
      markdownV2: kimiReport,
      ai: {
        provider: "nvidia" as const,
        model: "moonshotai/kimi-k3",
        used: true,
        requestId: "nvcf-request-57",
        error: null,
        reportMarkdown: "# Kimi priority report",
        reportMarkdownV2: kimiReport,
      },
    }));
    const first = fakeQueueMessage(queue.messages[0], 1);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [first.message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
      engine,
      reportGenerator,
    );
    expect(first.retry).toHaveBeenCalledOnce();
    const persisted = JSON.parse(db.audits.get(result.job.audit_id)!.normalized_result);
    expect(persisted.ai).toMatchObject({ used: true, requestId: "nvcf-request-57", reportMarkdownV2: kimiReport });

    const retry = fakeQueueMessage(queue.messages[0], 2);
    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [retry.message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
      engine,
      reportGenerator,
    );

    expect(retry.ack).toHaveBeenCalledOnce();
    expect(reportGenerator).toHaveBeenCalledOnce();
    expect(fetchPage).toHaveBeenCalledOnce();
    expect(db.rows.get(result.job.job_id)?.status).toBe("completed");
    expect(telegramFetch).toHaveBeenCalledTimes(2);
    const [, init] = telegramFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(init.body))).toMatchObject({ text: kimiReport, parse_mode: "MarkdownV2" });
  });

  it("persists permanent target errors as failed and notifies the owner", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/missing",
      updateId: 7862,
    });
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const engine = { auditPage: vi.fn().mockRejectedValue(new AuditEngineError("The website returned HTTP 404.", false)) };
    const queued = fakeQueueMessage(queue.messages[0]);

    await consumeAuditQueue({ queue: "kaseobot-audit-jobs", messages: [queued.message] }, { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN }, engine);

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(db.rows.get(result.job.job_id)?.status).toBe("failed");
    expect(db.rows.get(result.job.job_id)?.error).toContain("HTTP 404");
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain("HTTP 404");
  });

  it("processes a GEO job, persists the aggregated page metadata, and delivers a distinct SEO/GEO report", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const created = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 7864,
      type: "geo_audit",
    });
    const homeHtml = `<html><head><title>Example</title></head><body><main><h1>Home</h1><p>${"This page describes useful information for visitors. ".repeat(20)}</p><a href="/about">About</a></main></body></html>`;
    const aboutHtml = `<html><head><title>About</title></head><body><main><h1>About</h1><p>${"This page describes useful information for visitors. ".repeat(20)}</p></main></body></html>`;
    const telegramFetch = vi.fn(async (resource: RequestInfo | URL, _init?: RequestInit) => {
      const url = String(resource);
      if (url.includes("api.telegram.org")) {
        return new Response('{"ok":true,"result":{"message_id":91}}', { status: 200 });
      }
      return new Response(new URL(url).pathname === "/about" ? aboutHtml : homeHtml, {
        status: 200,
        headers: { "content-type": "text/html; charset=utf-8" },
      });
    });
    vi.stubGlobal("fetch", telegramFetch);
    const { engine, fetchPage } = fixtureAuditEngine();
    const queued = fakeQueueMessage(queue.messages[0]);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [queued.message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN, GEO_MAX_PAGES: "2" },
      engine,
    );

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(created.job.type).toBe("geo_audit");
    expect(queue.messages[0].type).toBe("geo_audit");
    expect(fetchPage).toHaveBeenCalledTimes(2);
    const persisted = JSON.parse(db.audits.get(created.job.audit_id)!.normalized_result);
    expect(persisted).toMatchObject({
      type: "geo_audit",
      geo: { pagesRequested: 2, pagesAudited: 2, pagesFailed: 0 },
    });
    expect(db.rows.get(created.job.job_id)?.status).toBe("completed");
    const telegramCall = telegramFetch.mock.calls.find(([resource]) => String(resource).includes("api.telegram.org"));
    expect(telegramCall).toBeDefined();
    const init = telegramCall?.[1];
    expect(init).toBeDefined();
    const sent = JSON.parse(String(init?.body));
    expect(sent.parse_mode).toBe("MarkdownV2");
    expect(sent.text).toContain("SEO findings:");
    expect(sent.text).toContain("GEO findings:");
  });

  it("acknowledges already-canceled jobs without running them", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 787,
    });
    await cancelAuditJob(db, result.job.job_id, 42);
    const queued = fakeQueueMessage(queue.messages[0]);

    await consumeAuditQueue({ queue: "kaseobot-audit-jobs", messages: [queued.message] }, { DB: db });

    expect(queued.ack).toHaveBeenCalledOnce();
    expect(queued.retry).not.toHaveBeenCalled();
    expect(db.rows.get(result.job.job_id)?.status).toBe("canceled");
  });

  it("marks exhausted jobs failed and sends a best-effort owner notice from the dead-letter queue", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 788,
    });
    db.rows.get(result.job.job_id)!.status = "running";
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const exhausted = fakeQueueMessage(queue.messages[0]);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-dead-letter", messages: [exhausted.message] },
      { DB: db, TELEGRAM_BOT_TOKEN: env.TELEGRAM_BOT_TOKEN },
    );

    expect(exhausted.ack).toHaveBeenCalledOnce();
    expect(exhausted.retry).not.toHaveBeenCalled();
    expect(db.rows.get(result.job.job_id)?.status).toBe("failed");
    expect(db.rows.get(result.job.job_id)?.error).toContain("after several retries");
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain(result.job.job_id);
  });

  it("retries transient D1 failures with exponential delay and acknowledges malformed messages", async () => {
    const db = new FakeD1();
    db.failNextRead = true;
    const transient = fakeQueueMessage({
      jobId: "valid-job-id",
      auditId: "valid-audit-id",
      telegramUserId: "42",
      chatId: "42",
      type: "seo_audit",
      url: "https://example.com/",
      attempt: 1,
    }, 2);
    const malformed = fakeQueueMessage({ jobId: null });

    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [transient.message, malformed.message] },
      { DB: db },
    );

    expect(transient.retry).toHaveBeenCalledWith({ delaySeconds: 4 });
    expect(transient.ack).not.toHaveBeenCalled();
    expect(malformed.ack).toHaveBeenCalledOnce();
    expect(malformed.retry).not.toHaveBeenCalled();
  });
});

describe("webhook audit command", () => {
  it("validates, creates, enqueues, and responds with the same job ID", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = createContext();

    const response = await worker.fetch(
      webhookRequest(update(42, "/audit https://example.com/path#part", "private", 788)),
      runtimeEnv(db, queue),
      context,
    );
    expect(response.status).toBe(200);
    await Promise.all(context.pending);

    expect(db.rows.size).toBe(1);
    const job = [...db.rows.values()][0];
    expect(job.url).toBe("https://example.com/path");
    expect(job.status).toBe("queued");
    expect(queue.messages).toHaveLength(1);
    expect(queue.messages[0].jobId).toBe(job.job_id);
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain(`Job ID: ${job.job_id}`);
  });

  it("routes /geo into a geo_audit job and acknowledges its configured page cap", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = createContext();
    const configured = runtimeEnv(db, queue);
    configured.GEO_MAX_PAGES = "3";

    const response = await worker.fetch(
      webhookRequest(update(42, "/geo https://example.com/site", "private", 7881)),
      configured,
      context,
    );
    expect(response.status).toBe(200);
    await Promise.all(context.pending);

    expect(db.rows.size).toBe(1);
    const job = [...db.rows.values()][0];
    expect(job.type).toBe("geo_audit");
    expect(queue.messages[0].type).toBe("geo_audit");
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain("Crawling up to 3 same-origin pages.");
  });

  it("replies with a validation message and creates no job for private URLs", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);
    const context = createContext();

    const response = await worker.fetch(
      webhookRequest(update(42, "/audit http://127.0.0.1/", "private", 789)),
      runtimeEnv(db, queue),
      context,
    );
    expect(response.status).toBe(200);
    await Promise.all(context.pending);

    expect(db.rows.size).toBe(0);
    expect(queue.messages).toHaveLength(0);
    const [, init] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(init.body)).text).toContain("publicly accessible");
  });

  it("routes owner-scoped /status and /cancel commands", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    const result = await createAuditJob(runtimeEnv(db, queue), {
      telegramUserId: 42,
      chatId: 42,
      url: "https://example.com/",
      updateId: 790,
    });
    const telegramFetch = vi.fn().mockResolvedValue(new Response('{"ok":true}', { status: 200 }));
    vi.stubGlobal("fetch", telegramFetch);

    const statusContext = createContext();
    const statusResponse = await worker.fetch(
      webhookRequest(update(42, `/status ${result.job.job_id}`, "private", 791)),
      runtimeEnv(db, queue),
      statusContext,
    );
    expect(statusResponse.status).toBe(200);
    await Promise.all(statusContext.pending);
    const [, statusInit] = telegramFetch.mock.calls[0] as [string, RequestInit];
    expect(JSON.parse(String(statusInit.body)).text).toContain("Status: queued");

    const cancelContext = createContext();
    const cancelResponse = await worker.fetch(
      webhookRequest(update(42, `/cancel ${result.job.job_id}`, "private", 792)),
      runtimeEnv(db, queue),
      cancelContext,
    );
    expect(cancelResponse.status).toBe(200);
    await Promise.all(cancelContext.pending);
    const [, cancelInit] = telegramFetch.mock.calls[1] as [string, RequestInit];
    expect(JSON.parse(String(cancelInit.body)).text).toBe("Job canceled.");
    expect(db.rows.get(result.job.job_id)?.status).toBe("canceled");
  });
});

describe("health check", () => {
  it("returns a healthy service response without Telegram configuration", async () => {
    const response = await worker.fetch(
      new Request("https://kaseobot.test/healthz"),
      {},
      createContext(),
    );

    expect(response.status).toBe(200);
    expect(await response.json()).toEqual({ ok: true, service: "kaseobot" });
  });
});
