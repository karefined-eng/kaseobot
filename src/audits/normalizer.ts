import type { JobType } from "../jobs";
import type {
  AuditCategory,
  AuditFinding,
  AuditFindingStatus,
  AuditSeverity,
  KaseobotAuditResult,
  RawAuditResult,
} from "./types";

export interface NormalizeAuditInput {
  jobId: string;
  auditId: string;
  type: JobType;
  url: string;
  requestedBy: string;
  engineResult: RawAuditResult;
  startedAt?: string;
  now?: () => Date;
}

export function normalizeAuditResult(input: NormalizeAuditInput): KaseobotAuditResult {
  const now = input.now ?? (() => new Date());
  const output = asRecord(input.engineResult.output);
  if (!output) throw new TypeError("Audit engine output is not a JSON object.");

  const categories = parseCategories(output.categoryResults, input.url);
  const completedAt = parseIsoDate(output.timestamp) ?? now().toISOString();
  const geo = parseGeoMetadata(output.geo);
  return {
    auditId: input.auditId,
    jobId: input.jobId,
    type: input.type,
    url: parseString(output.url) ?? input.url,
    requestedBy: input.requestedBy,
    startedAt: parseIsoDate(input.startedAt) ?? now().toISOString(),
    completedAt,
    engine: {
      name: input.engineResult.engineName,
      version: input.engineResult.engineVersion,
    },
    status: "completed",
    overallScore: parseScore(output.overallScore),
    summary: calculateSummary(categories),
    categories,
    ...(geo ? { geo } : {}),
    raw: input.engineResult.output,
  };
}

function parseGeoMetadata(value: unknown): KaseobotAuditResult["geo"] | undefined {
  if (!isRecord(value) || !isRecord(value.scores)) return undefined;
  const pagesRequested = parseCount(value.pagesRequested);
  const pagesAudited = parseCount(value.pagesAudited);
  const pagesFailed = parseCount(value.pagesFailed);
  if (pagesRequested === null || pagesAudited === null || pagesFailed === null) return undefined;
  return {
    pagesRequested,
    pagesAudited,
    pagesFailed,
    scores: {
      citability: parseScore(value.scores.citability),
      crawlerAccess: parseScore(value.scores.crawlerAccess),
      schema: parseScore(value.scores.schema),
      contentQuality: parseScore(value.scores.contentQuality),
    },
  };
}

function parseCount(value: unknown): number | null {
  const count = typeof value === "number" ? value : typeof value === "string" ? Number(value) : Number.NaN;
  return Number.isSafeInteger(count) && count >= 0 ? count : null;
}

function parseCategories(value: unknown, pageUrl: string): AuditCategory[] {
  if (!Array.isArray(value)) return [];
  return value.filter(isRecord).map((category, categoryIndex) => {
    const id = parseString(category.categoryId) ?? parseString(category.id) ?? `category-${categoryIndex + 1}`;
    const rawFindings = Array.isArray(category.results) ? category.results : [];
    const findings = rawFindings.filter(isRecord).map((finding, findingIndex) => parseFinding(finding, id, findingIndex, pageUrl));
    return {
      id,
      name: parseString(category.categoryName) ?? parseString(category.name) ?? id,
      score: parseScore(category.score),
      findings,
    };
  });
}

function parseFinding(
  value: Record<string, unknown>,
  categoryId: string,
  index: number,
  fallbackPageUrl: string,
): AuditFinding {
  const id = parseString(value.id) ?? parseString(value.ruleId) ?? parseString(value.rule) ?? `${categoryId}-finding-${index + 1}`;
  const docsUrl = parseHttpUrl(value.docsUrl) ?? parseHttpUrl(value.documentationUrl) ?? parseHttpUrl(value.learnMoreUrl);
  return {
    id,
    title: parseString(value.title) ?? parseString(value.name) ?? parseString(value.message) ?? "Untitled audit finding",
    severity: parseSeverity(value.severity),
    status: parseStatus(value.status ?? value.result),
    pageUrl: parseHttpUrl(value.pageUrl) ?? parseHttpUrl(value.url) ?? fallbackPageUrl,
    evidence: parseEvidence(value),
    recommendation: parseString(value.recommendation) ?? parseString(value.fix) ?? parseString(value.suggestion) ?? "No recommendation was returned by the audit engine.",
    docsUrl,
  };
}

function parseSeverity(value: unknown): AuditSeverity {
  switch (parseString(value)?.toLowerCase()) {
    case "critical": return "critical";
    case "high": return "high";
    case "medium":
    case "moderate": return "medium";
    case "low": return "low";
    case "info":
    case "informational": return "info";
    default: return "medium";
  }
}

export function parseStatus(value: unknown): AuditFindingStatus {
  switch (parseString(value)?.toLowerCase().replace(/[\s-]+/g, "_")) {
    case "pass":
    case "passed":
    case "success":
    case "ok": return "pass";
    case "warn":
    case "warning":
    case "warned": return "warn";
    case "fail":
    case "failed":
    case "error":
    case "not_passed": return "fail";
    case "skip":
    case "skipped":
    case "not_measured":
    case "not_applicable":
    case "n_a": return "skipped";
    default: return "skipped";
  }
}

function parseEvidence(value: Record<string, unknown>): string {
  for (const key of ["evidence", "details", "description"]) {
    const text = parseString(value[key]);
    if (text) return text.slice(0, 2_000);
  }
  for (const key of ["affectedItems", "affectedUrls"]) {
    const items = value[key];
    if (Array.isArray(items)) {
      return items.slice(0, 20).map((item) => stringifyItem(item)).join("; ").slice(0, 2_000);
    }
  }
  return "No detailed evidence was returned by the audit engine.";
}

function calculateSummary(categories: AuditCategory[]): KaseobotAuditResult["summary"] {
  const findings = categories.flatMap((category) => category.findings);
  return {
    passed: findings.filter((finding) => finding.status === "pass").length,
    warnings: findings.filter((finding) => finding.status === "warn").length,
    failed: findings.filter((finding) => finding.status === "fail").length,
    skipped: findings.filter((finding) => finding.status === "skipped").length,
  };
}

function parseScore(value: unknown): number | null {
  const score = typeof value === "number" ? value : typeof value === "string" ? Number.parseFloat(value) : Number.NaN;
  return Number.isFinite(score) ? Math.max(0, Math.min(100, Math.round(score))) : null;
}

function parseString(value: unknown): string | null {
  if (typeof value !== "string") return null;
  const text = value.trim();
  return text.length > 0 ? text : null;
}

function parseIsoDate(value: unknown): string | null {
  const text = parseString(value);
  if (!text) return null;
  const timestamp = Date.parse(text);
  return Number.isFinite(timestamp) ? new Date(timestamp).toISOString() : null;
}

function parseHttpUrl(value: unknown): string | null {
  const text = parseString(value);
  if (!text) return null;
  try {
    const url = new URL(text);
    if ((url.protocol !== "http:" && url.protocol !== "https:") || url.username || url.password) return null;
    return url.toString();
  } catch {
    return null;
  }
}

function stringifyItem(value: unknown): string {
  if (typeof value === "string") return value;
  try {
    return JSON.stringify(value) ?? String(value);
  } catch {
    return String(value);
  }
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}

function asRecord(value: unknown): Record<string, unknown> | null {
  return isRecord(value) ? value : null;
}
