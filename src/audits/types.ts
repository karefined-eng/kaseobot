import type { JobType } from "../jobs";

export interface AuditPageInput {
  url: string;
  timeoutMs: number;
  includeJavaScriptRendering: false;
  includeCoreWebVitals: false;
}

export interface RawAuditResult {
  engineName: string;
  engineVersion: string;
  output: unknown;
}

export interface AuditEngine {
  auditPage(input: AuditPageInput): Promise<RawAuditResult>;
}

export type AuditSeverity = "info" | "low" | "medium" | "high" | "critical";
export type AuditFindingStatus = "pass" | "warn" | "fail" | "skipped";

export interface AuditFinding {
  id: string;
  title: string;
  severity: AuditSeverity;
  status: AuditFindingStatus;
  pageUrl: string;
  evidence: string;
  recommendation: string;
  docsUrl: string | null;
}

export interface AuditCategory {
  id: string;
  name: string;
  score: number | null;
  findings: AuditFinding[];
}

export interface KaseobotAuditResult {
  auditId: string;
  jobId: string;
  type: JobType;
  url: string;
  requestedBy: string;
  startedAt: string;
  completedAt: string | null;
  engine: {
    name: string;
    version: string;
  };
  status: "queued" | "running" | "completed" | "failed" | "canceled";
  overallScore: number | null;
  summary: {
    passed: number;
    warnings: number;
    failed: number;
    skipped: number;
  };
  categories: AuditCategory[];
  raw: unknown;
  /** Page counts and deterministic GEO signal scores for multi-page crawls. */
  geo?: {
    pagesRequested: number;
    pagesAudited: number;
    pagesFailed: number;
    scores: {
      citability: number | null;
      crawlerAccess: number | null;
      schema: number | null;
      contentQuality: number | null;
    };
  };
  /** Optional Kimi provider and report metadata persisted for queue idempotency. */
  ai?: {
    provider: string;
    model: string;
    used: boolean;
    requestId: string | null;
    error: string | null;
    /** Final MarkdownV2 report for idempotent queue redelivery. */
    reportMarkdownV2?: string;
    /** Complete source Markdown, retained for long-report document delivery. */
    reportMarkdown?: string;
  };
  /** Diff against the previous audit of the same URL + user ("did my fix work?"). */
  diff?: {
    categories: Array<{
      categoryId: string;
      categoryName: string;
      previousScore: number | null;
      currentScore: number | null;
      scoreChange: number | null;
    }>;
    findings: Array<{
      categoryId: string;
      categoryName: string;
      findingId: string;
      findingTitle: string;
      previousStatus: AuditFindingStatus | null;
      currentStatus: AuditFindingStatus;
      pageUrl: string;
    }>;
    hasChanges: boolean;
  };
}

export class AuditEngineError extends Error {
  readonly retryable: boolean;

  constructor(message: string, retryable: boolean) {
    super(message);
    this.name = "AuditEngineError";
    this.retryable = retryable;
  }
}

export interface FetchedHtmlPage {
  url: string;
  html: string;
  status: number;
}

export interface StaticHtmlFetcher {
  fetch(input: { url: string; timeoutMs: number }): Promise<FetchedHtmlPage>;
}
