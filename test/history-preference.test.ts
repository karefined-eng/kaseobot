import { describe, expect, it, vi } from "vitest";
import { createAuditJob, type AuditJobMessage } from "../src/jobs";
import {
  cleanupExpiredHistory,
  forgetUserHistory,
  getHistoryPreference,
  setHistoryPreference,
} from "../src/history";
import { getUserHistory } from "../src/history";
import { consumeAuditQueue, type QueueMessageLike } from "../src/queue-consumer";
import { FakeD1, FakeQueue } from "./fakes";

// These tests intentionally avoid constructing a Telegram bot env, so the file
// contains no bot-credential keys at all (workspace write-guard policy).
// Covered here: preference mechanics, sticky opt-out through /forget and the
// daily cleanup, the 24-hour backstop, and both purge guards in the queue
// consumer. The webhook-level behaviors (the /history off-state reply, the
// hist:off button purge, and the completion-path purge after a successful
// delivery) are listed as follow-ups in docs/handoff/milestone-9-history-preference.md.

function makeJobEnv(db: FakeD1, queue: FakeQueue) {
  return {
    DB: db,
    AUDIT_QUEUE: queue,
    MAX_AUDITS_PER_USER_PER_HOUR: "10",
    MAX_CONCURRENT_AUDITS_PER_USER: "2",
  };
}

async function createJob(db: FakeD1, queue: FakeQueue, url: string, updateId: number) {
  return createAuditJob(makeJobEnv(db, queue), {
    telegramUserId: 42,
    chatId: 42,
    url,
    updateId,
  });
}

function fakeMessage(body: AuditJobMessage) {
  return {
    body,
    attempts: 1,
    ack: vi.fn(),
    retry: vi.fn(),
  } satisfies QueueMessageLike<AuditJobMessage>;
}

describe("History preference", () => {
  it("defaults to enabled and toggles without resetting created_at", async () => {
    const db = new FakeD1();
    expect(await getHistoryPreference(db, "42")).toBe(true);

    await setHistoryPreference(db, "42", false);
    expect(await getHistoryPreference(db, "42")).toBe(false);
    const createdAt = db.users.get("42")!.created_at;

    await setHistoryPreference(db, "42", true);
    expect(await getHistoryPreference(db, "42")).toBe(true);
    expect(db.users.get("42")!.created_at).toBe(createdAt);
    expect(db.users.get("42")!.history_enabled).toBe(1);
  });

  it("keeps a disabled history preference after /forget", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    await setHistoryPreference(db, "42", false);
    const job = await createJob(db, queue, "https://own.example/", 6020);

    await forgetUserHistory(db, "42");

    expect(db.rows.has(job.job.job_id)).toBe(false);
    expect(await getHistoryPreference(db, "42")).toBe(false);
    expect(db.users.get("42")?.history_enabled).toBe(0);
  });

  it("cleanup keeps opted-out preference rows and removes enabled orphan rows", async () => {
    const db = new FakeD1();
    const stale = new Date(Date.now() - 40 * 24 * 60 * 60 * 1000).toISOString();
    db.users.set("42", { telegram_user_id: "42", created_at: stale, history_enabled: 0 });
    db.users.set("7", { telegram_user_id: "7", created_at: stale, history_enabled: 1 });

    await cleanupExpiredHistory(db, Date.now());

    expect(db.users.has("42")).toBe(true);
    expect(db.users.has("7")).toBe(false);
  });

  it("cleanup removes leftover opted-out records after the 24-hour grace period", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    await setHistoryPreference(db, "42", false);
    const created = await createJob(db, queue, "https://late.example/", 6050);
    const stale = new Date(Date.now() - 25 * 60 * 60 * 1000).toISOString();
    const row = db.rows.get(created.job.job_id)!;
    row.status = "failed";
    row.completed_at = stale;
    db.audits.set("audit-late", {
      audit_id: "audit-late",
      job_id: created.job.job_id,
      telegram_user_id: "42",
      url: created.job.url,
      type: created.job.type,
      overall_score: 40,
      normalized_result: "{}",
      raw_result: "{}",
      created_at: stale,
      expires_at: new Date(Date.now() + 5 * 24 * 60 * 60 * 1000).toISOString(),
    });
    db.snapshots.set("snap-late", {
      snapshot_id: "snap-late",
      telegram_user_id: "42",
      url: created.job.url,
      type: created.job.type,
      overall_score: 40,
      normalized_result: "{}",
      created_at: stale,
    });

    await cleanupExpiredHistory(db, Date.now());

    expect(db.rows.has(created.job.job_id)).toBe(false);
    expect(db.audits.has("audit-late")).toBe(false);
    expect(db.snapshots.has("snap-late")).toBe(false);
    expect(db.users.get("42")?.history_enabled).toBe(0);
  });
});

describe("History opt-out retention in the queue consumer", () => {
  it("purges a dead-lettered job once the failure path runs while history is off", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    await setHistoryPreference(db, "42", false);
    const created = await createJob(db, queue, "https://dead.example/", 6040);
    const message = fakeMessage(queue.messages[0]);

    await consumeAuditQueue(
      { queue: "kaseobot-audit-dead-letter", messages: [message] },
      { DB: db },
    );

    expect(message.ack).toHaveBeenCalledOnce();
    expect(db.rows.has(created.job.job_id)).toBe(false);
    expect(await getUserHistory(db, "42")).toEqual([]);
  });

  it("does not purge a job whose report was never delivered", async () => {
    const db = new FakeD1();
    const queue = new FakeQueue();
    await setHistoryPreference(db, "42", false);
    const created = await createJob(db, queue, "https://undelivered.example/", 6060);
    const message = fakeMessage(queue.messages[0]);
    const engine = {
      auditPage: vi.fn(async ({ url }: { url: string }) => ({
        engineName: "history-test",
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
    const markdown = "# Report\n\nShort report.";
    const reportGenerator = vi.fn(async () => ({
      markdown,
      markdownV2: markdown,
      ai: {
        provider: "nvidia" as const,
        model: "moonshotai/kimi-k3",
        used: false,
        requestId: null,
        error: null,
        reportMarkdown: markdown,
        reportMarkdownV2: markdown,
      },
    }));

    // No bot token is configured, so report delivery cannot succeed. The
    // opt-out purge must happen only after a confirmed delivery.
    await consumeAuditQueue(
      { queue: "kaseobot-audit-jobs", messages: [message] },
      { DB: db },
      engine,
      reportGenerator,
    );

    expect(message.ack).not.toHaveBeenCalled();
    expect(message.retry).toHaveBeenCalled();
    expect(db.rows.get(created.job.job_id)?.status).toBe("running");
    expect(db.audits.size).toBe(1);
    expect(db.rows.has(created.job.job_id)).toBe(true);
  });
});
