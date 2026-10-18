import type {
  AuditJobMessage,
  AuditQueueLike,
  D1DatabaseLike,
  D1PreparedStatementLike,
  D1ResultLike,
  JobRow,
} from "../src/jobs";

interface FakeAuditRow {
  audit_id: string;
  job_id: string;
  telegram_user_id: string;
  url: string;
  type: string;
  overall_score: number | null;
  normalized_result: string;
  raw_result: string;
  created_at: string;
  expires_at: string;
}

interface FakeSnapshotRow {
  snapshot_id: string;
  telegram_user_id: string;
  url: string;
  type: string;
  overall_score: number | null;
  normalized_result: string;
  created_at: string;
}

interface FakeUserRow {
  telegram_user_id: string;
  created_at: string;
  history_enabled: number;
}

interface FakeUserStateRow {
  state: string;
  updated_at: string;
}

export class FakeD1 implements D1DatabaseLike {
  readonly rows = new Map<string, JobRow>();
  readonly audits = new Map<string, FakeAuditRow>();
  readonly snapshots = new Map<string, FakeSnapshotRow>();
  readonly users = new Map<string, FakeUserRow>();
  readonly userStates = new Map<string, { state: string; updated_at: string }>();
  failNextRead = false;
  failNextWrite = false;

  prepare(query: string): D1PreparedStatementLike {
    return new FakeStatement(this, query);
  }

  async batch<T = unknown>(statements: D1PreparedStatementLike[]): Promise<D1ResultLike<T>[]> {
    const results: D1ResultLike[] = [];
    for (const statement of statements) {
      if (!(statement instanceof FakeStatement)) throw new Error("FakeD1.batch only accepts FakeStatement instances.");
      results.push(await this.run(statement.query, statement.values));
    }
    return results as D1ResultLike<T>[];
  }

  async first(query: string, values: unknown[]): Promise<unknown | null> {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("transient test database error");
    }
    const normalized = normalize(query);
    if (normalized.includes("count(*) as count")) {
      const userId = String(values[0]);
      const matching = [...this.rows.values()].filter((job) => job.telegram_user_id === userId);
      const count = normalized.includes("created_at >=")
        ? matching.filter((job) => job.created_at >= String(values[1])).length
        : matching.filter((job) => ["queued", "running", "cancel_requested"].includes(job.status)).length;
      return { count };
    }

    if (normalized.includes("from audits where audit_id = ?")) {
      const row = this.audits.get(String(values[0]));
      return row ? { normalized_result: row.normalized_result, raw_result: row.raw_result } : null;
    }

    if (normalized.includes("from audit_snapshots where telegram_user_id = ?")) {
      const [userId, url] = values.map(String);
      const rows = [...this.snapshots.values()].filter(
        (s) => s.telegram_user_id === userId && s.url === url,
      ).sort((left, right) => right.created_at.localeCompare(left.created_at));
      if (rows.length === 0) return null;
      return { normalized_result: rows[0].normalized_result };
    }

    if (normalized.includes("select state from user_state where telegram_user_id = ?")) {
      const [userId] = values.map(String);
      const row = this.userStates.get(userId);
      return row ? { state: row.state } : null;
    }

    if (normalized.includes("select history_enabled from users where telegram_user_id = ?")) {
      const row = this.users.get(String(values[0]));
      return row ? { history_enabled: row.history_enabled } : null;
    }

    if (normalized.includes("where source_update_id = ?")) {
      const [updateId, userId] = values.map(String);
      const row = [...this.rows.values()].find(
        (job) => job.source_update_id === updateId && job.telegram_user_id === userId,
      );
      return row ? { ...row } : null;
    }

    if (normalized.includes("where job_id = ? and telegram_user_id = ?")) {
      const [jobId, userId] = values.map(String);
      const row = this.rows.get(jobId);
      return row?.telegram_user_id === userId ? { ...row } : null;
    }

    if (normalized.includes("where job_id = ?")) {
      const row = this.rows.get(String(values[0]));
      return row ? { ...row } : null;
    }

    throw new Error(`Unsupported FakeD1 read query: ${normalized}`);
  }

  async all(query: string, values: unknown[]): Promise<D1ResultLike> {
    if (this.failNextRead) {
      this.failNextRead = false;
      throw new Error("transient test database error");
    }
    const normalized = normalize(query);
    if (normalized.includes("from jobs where telegram_user_id = ? and status in") && normalized.includes("order by created_at desc")) {
      const [userId] = values.map(String);
      const statuses = values.slice(1, 4).map(String);
      const rows = [...this.rows.values()]
        .filter((job) => job.telegram_user_id === userId)
        .filter((job) => statuses.includes(job.status))
        .sort((left, right) => right.created_at.localeCompare(left.created_at))
        .map((job) => ({
          job_id: job.job_id,
          url: job.url,
          type: job.type,
          status: job.status,
          created_at: job.created_at,
        }));
      return { success: true, results: rows };
    }
    if (!normalized.includes("from jobs j left join audits a on a.job_id = j.job_id")) {
      throw new Error(`Unsupported FakeD1 list query: ${normalized}`);
    }
    const [userId, cutoff, now, limit] = values.map(String);
    const rows = [...this.rows.values()]
      .filter((job) => job.telegram_user_id === userId)
      .filter((job) => ["completed", "failed", "canceled"].includes(job.status))
      .filter((job) => job.created_at >= cutoff)
      .filter((job) => {
        const audit = [...this.audits.values()].find((item) => item.job_id === job.job_id);
        return !audit || audit.expires_at > now;
      })
      .sort((left, right) => right.created_at.localeCompare(left.created_at))
      .slice(0, Number(limit))
      .map((job) => {
        const audit = [...this.audits.values()].find((item) => item.job_id === job.job_id);
        return {
          job_id: job.job_id,
          url: job.url,
          type: job.type,
          status: job.status,
          created_at: job.created_at,
          overall_score: audit?.overall_score ?? null,
        };
      });
    return { success: true, results: rows };
  }

  async run(query: string, values: unknown[]): Promise<D1ResultLike> {
    if (this.failNextWrite) {
      this.failNextWrite = false;
      throw new Error("transient test database error");
    }
    const normalized = normalize(query);

    if (normalized.startsWith("insert or ignore into users")) {
      const [userId, createdAt] = values;
      const existing = this.users.has(String(userId));
      if (!existing) {
        this.users.set(String(userId), {
          telegram_user_id: String(userId),
          created_at: String(createdAt),
          history_enabled: 1,
        });
      }
      return result(0);
    }

    if (normalized.startsWith("insert into users")) {
      const [userId, createdAt, enabled] = values;
      const existing = this.users.get(String(userId));
      if (existing) {
        existing.history_enabled = Number(enabled);
        return result(1);
      }
      this.users.set(String(userId), {
        telegram_user_id: String(userId),
        created_at: String(createdAt),
        history_enabled: Number(enabled),
      });
      return result(1);
    }

    if (normalized.startsWith("insert into user_state")) {
      const [userId, state, updatedAt] = values;
      this.userStates.set(String(userId), { state: String(state), updated_at: String(updatedAt) });
      return result(1);
    }

    if (normalized.startsWith("delete from user_state where telegram_user_id = ?")) {
      const userId = String(values[0]);
      const existed = this.userStates.has(userId);
      this.userStates.delete(userId);
      return result(existed ? 1 : 0);
    }

    if (normalized.startsWith("insert or ignore into jobs")) {
      const [jobId, auditId, userId, chatId, type, url, createdAt, sourceUpdateId,
        hourlyUserId, hourAgo, hourlyLimit, activeUserId, activeLimit] = values;
      const updateDuplicate = sourceUpdateId !== null && [...this.rows.values()].some(
        (job) => job.source_update_id === String(sourceUpdateId),
      );
      if (this.rows.has(String(jobId)) || updateDuplicate) return result(0);
      const hourlyCount = [...this.rows.values()].filter(
        (job) => job.telegram_user_id === String(hourlyUserId) && job.created_at >= String(hourAgo),
      ).length;
      const activeCount = [...this.rows.values()].filter(
        (job) => job.telegram_user_id === String(activeUserId) && ["queued", "running", "cancel_requested"].includes(job.status),
      ).length;
      if (hourlyCount >= Number(hourlyLimit) || activeCount >= Number(activeLimit)) return result(0);
      this.rows.set(String(jobId), {
        job_id: String(jobId),
        audit_id: String(auditId),
        telegram_user_id: String(userId),
        chat_id: String(chatId),
        type: type === "geo_audit" ? "geo_audit" : "seo_audit",
        url: String(url),
        status: "queued",
        created_at: String(createdAt),
        started_at: null,
        completed_at: null,
        error: null,
        result_summary_message_id: null,
        source_update_id: sourceUpdateId === null ? null : String(sourceUpdateId),
      });
      return result(1);
    }

    if (normalized.startsWith("insert into audit_snapshots")) {
      const [snapshotId, userId, url, type, overallScore, normalizedResult,
        createdAt] = values;
      this.snapshots.set(String(snapshotId), {
        snapshot_id: String(snapshotId),
        telegram_user_id: String(userId),
        url: String(url),
        type: String(type),
        overall_score: typeof overallScore === "number" ? overallScore : null,
        normalized_result: String(normalizedResult),
        created_at: String(createdAt),
      });
      return result(1);
    }

    if (normalized.startsWith("insert into audits")) {
      const [auditId, jobId, userId, url, type, overallScore, normalizedResult,
        rawResult, createdAt, expiresAt, guardJobId, guardUserId] = values;
      const job = this.rows.get(String(guardJobId));
      if (!job || job.telegram_user_id !== String(guardUserId) || job.status !== "running") return result(0);
      this.audits.set(String(auditId), {
        audit_id: String(auditId),
        job_id: String(jobId),
        telegram_user_id: String(userId),
        url: String(url),
        type: String(type),
        overall_score: typeof overallScore === "number" ? overallScore : null,
        normalized_result: String(normalizedResult),
        raw_result: String(rawResult),
        created_at: String(createdAt),
        expires_at: String(expiresAt),
      });
      return result(1);
    }

    if (normalized.startsWith("delete from audits where job_id = ?")) {
      const jobId = String(values[0]);
      const before = this.audits.size;
      for (const [auditId, row] of this.audits) if (row.job_id === jobId) this.audits.delete(auditId);
      return result(before - this.audits.size);
    }

    if (normalized.startsWith("delete from audits where telegram_user_id in (select telegram_user_id from users where history_enabled = 0)")) {
      const cutoff = String(values[0]);
      const optedOut = new Set([...this.users.values()].filter((user) => user.history_enabled === 0).map((user) => user.telegram_user_id));
      const before = this.audits.size;
      for (const [auditId, row] of this.audits) {
        if (optedOut.has(row.telegram_user_id) && row.created_at <= cutoff) this.audits.delete(auditId);
      }
      return result(before - this.audits.size);
    }

    if (normalized.startsWith("delete from audits where telegram_user_id = ?")) {
      const userId = String(values[0]);
      const before = this.audits.size;
      for (const [auditId, row] of this.audits) if (row.telegram_user_id === userId) this.audits.delete(auditId);
      return result(before - this.audits.size);
    }

    if (normalized.startsWith("delete from audit_snapshots where telegram_user_id = ? and url = ?")) {
      const [userId, url] = values.map(String);
      const before = this.snapshots.size;
      for (const [snapshotId, row] of this.snapshots) {
        if (row.telegram_user_id === userId && row.url === url) this.snapshots.delete(snapshotId);
      }
      return result(before - this.snapshots.size);
    }

    if (normalized.startsWith("delete from audit_snapshots where telegram_user_id in (select telegram_user_id from users where history_enabled = 0)")) {
      const cutoff = String(values[0]);
      const optedOut = new Set([...this.users.values()].filter((user) => user.history_enabled === 0).map((user) => user.telegram_user_id));
      const before = this.snapshots.size;
      for (const [snapshotId, row] of this.snapshots) {
        if (optedOut.has(row.telegram_user_id) && row.created_at <= cutoff) this.snapshots.delete(snapshotId);
      }
      return result(before - this.snapshots.size);
    }

    if (normalized.startsWith("delete from audit_snapshots where telegram_user_id = ?")) {
      const userId = String(values[0]);
      const before = this.snapshots.size;
      for (const [snapshotId, row] of this.snapshots) if (row.telegram_user_id === userId) this.snapshots.delete(snapshotId);
      return result(before - this.snapshots.size);
    }

    if (normalized.startsWith("delete from jobs where telegram_user_id = ? and status in")) {
      const userId = String(values[0]);
      const before = this.rows.size;
      for (const [jobId, row] of this.rows) {
        if (row.telegram_user_id === userId && ["completed", "failed", "canceled"].includes(row.status)) this.rows.delete(jobId);
      }
      return result(before - this.rows.size);
    }

    if (normalized.startsWith("delete from jobs where telegram_user_id in (select telegram_user_id from users where history_enabled = 0)")) {
      const cutoff = String(values[0]);
      const optedOut = new Set([...this.users.values()].filter((user) => user.history_enabled === 0).map((user) => user.telegram_user_id));
      const before = this.rows.size;
      for (const [jobId, row] of this.rows) {
        const terminalAt = row.completed_at ?? row.created_at;
        if (optedOut.has(row.telegram_user_id) && ["completed", "failed", "canceled"].includes(row.status) && terminalAt <= cutoff) this.rows.delete(jobId);
      }
      return result(before - this.rows.size);
    }

    if (normalized.startsWith("delete from jobs where job_id = ?")) {
      return result(this.rows.delete(String(values[0])) ? 1 : 0);
    }

    if (normalized.startsWith("delete from jobs where telegram_user_id = ?")) {
      const userId = String(values[0]);
      const before = this.rows.size;
      for (const [jobId, row] of this.rows) if (row.telegram_user_id === userId) this.rows.delete(jobId);
      return result(before - this.rows.size);
    }

    if (normalized.startsWith("delete from users where telegram_user_id = ?")) {
      return result(this.users.delete(String(values[0])) ? 1 : 0);
    }

    if (normalized.startsWith("delete from jobs where status in")) {
      const [now, cutoff] = values.map(String);
      const before = this.rows.size;
      for (const [jobId, job] of this.rows) {
        if (!["completed", "failed", "canceled"].includes(job.status)) continue;
        const audit = [...this.audits.values()].find((item) => item.job_id === job.job_id);
        const expiredAudit = Boolean(audit && audit.expires_at <= now);
        const oldWithoutAudit = !audit && job.created_at <= cutoff;
        if (expiredAudit || oldWithoutAudit) this.rows.delete(jobId);
      }
      return result(before - this.rows.size);
    }

    if (normalized.startsWith("delete from audits where expires_at <= ?")) {
      const now = String(values[0]);
      const before = this.audits.size;
      for (const [auditId, row] of this.audits) if (row.expires_at <= now) this.audits.delete(auditId);
      return result(before - this.audits.size);
    }

    if (normalized.startsWith("delete from users where created_at <= ?")) {
      const cutoff = String(values[0]);
      const before = this.users.size;
      for (const [userId, user] of this.users) {
        const hasJob = [...this.rows.values()].some((job) => job.telegram_user_id === userId);
        const hasAudit = [...this.audits.values()].some((audit) => audit.telegram_user_id === userId);
        if (user.created_at <= cutoff && user.history_enabled === 1 && !hasJob && !hasAudit) this.users.delete(userId);
      }
      return result(before - this.users.size);
    }

    if (normalized.startsWith("update jobs set status = 'failed'")) {
      const [completedAt, error, jobId] = values.map(String);
      const row = this.rows.get(jobId);
      const allowedStatuses = normalized.includes("status in ('queued', 'running')")
        ? ["queued", "running"]
        : [normalized.includes("status = 'queued'") ? "queued" : "running"];
      if (!row || !allowedStatuses.includes(row.status)) return result(0);
      Object.assign(row, { status: "failed", completed_at: completedAt, error });
      return result(1);
    }

    if (normalized.startsWith("update jobs set status = 'completed'")) {
      const [completedAt, messageId, jobId] = values;
      const row = this.rows.get(String(jobId));
      if (!row || row.status !== "running") return result(0);
      Object.assign(row, {
        status: "completed",
        completed_at: String(completedAt),
        error: null,
        result_summary_message_id: messageId === null ? null : String(messageId),
      });
      return result(1);
    }

    if (normalized.startsWith("update jobs set status = 'canceled'")) {
      const [completedAt, jobId] = values.map(String);
      const row = this.rows.get(jobId);
      if (!row || row.status !== "cancel_requested") return result(0);
      Object.assign(row, { status: "canceled", completed_at: completedAt });
      return result(1);
    }

    if (normalized.startsWith("update jobs set status = 'running'")) {
      const [startedAt, jobId] = values.map(String);
      const row = this.rows.get(jobId);
      if (!row || row.status !== "queued") return result(0);
      Object.assign(row, { status: "running", started_at: startedAt, error: null });
      return result(1);
    }

    if (normalized.startsWith("update jobs set status = ?,")) {
      const [nextStatus, caseStatus, completedAt, jobId, userId, oldStatus] = values.map(String);
      const row = this.rows.get(jobId);
      if (!row || row.telegram_user_id !== userId || row.status !== oldStatus) return result(0);
      Object.assign(row, {
        status: nextStatus,
        completed_at: caseStatus === "canceled" ? completedAt : row.completed_at,
      });
      return result(1);
    }

    throw new Error(`Unsupported FakeD1 write query: ${normalized}`);
  }
}

class FakeStatement implements D1PreparedStatementLike {
  values: unknown[] = [];

  constructor(readonly db: FakeD1, readonly query: string) {}

  bind(...values: unknown[]): D1PreparedStatementLike {
    this.values = values;
    return this;
  }

  async first<T = unknown>(): Promise<T | null> {
    return (await this.db.first(this.query, this.values)) as T | null;
  }

  async run<T = unknown>(): Promise<D1ResultLike<T>> {
    return (await this.db.run(this.query, this.values)) as D1ResultLike<T>;
  }

  async all<T = unknown>(): Promise<D1ResultLike<T>> {
    return (await this.db.all(this.query, this.values)) as D1ResultLike<T>;
  }
}

export class FakeQueue implements AuditQueueLike {
  readonly messages: AuditJobMessage[] = [];
  failNextSend = false;

  async send(message: AuditJobMessage): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("transient test queue error");
    }
    this.messages.push({ ...message });
  }
}

function normalize(query: string): string {
  return query.replace(/\s+/g, " ").trim().toLowerCase();
}

function result(changes: number): D1ResultLike {
  return { success: true, meta: { changes } };
}
