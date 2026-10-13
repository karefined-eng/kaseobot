import { normalizeAuditResult } from "./normalizer";
import { PublicStaticHtmlFetcher, StaticHtmlAuditEngine } from "./static-html-engine";
import { analyzeGeoPage, type GeoPageSignals } from "./geo-checks";
import { clampGeoPageLimit, extractInternalLinks } from "./geo-links";
import { validateAndNormalizeUrl } from "../url-validation";
import {
  AuditEngineError,
  type AuditCategory,
  type AuditEngine,
  type AuditFinding,
  type FetchedHtmlPage,
  type KaseobotAuditResult,
  type RawAuditResult,
  type StaticHtmlFetcher,
} from "./types";

export const GEO_AUDIT_ENGINE_NAME = "kaseobot-geo-static-crawl";
export const GEO_AUDIT_ENGINE_VERSION = "1.0.0";

export interface GeoAuditInput {
  url: string;
  maxPages: number;
  timeoutMs: number;
}

export interface GeoAuditDependencies {
  engine?: AuditEngine;
  fetcher?: StaticHtmlFetcher;
  now?: () => Date;
}

interface PageSuccess {
  url: string;
  normalized: KaseobotAuditResult;
  signals: GeoPageSignals;
}

interface PageAttempt {
  url: string;
  status: "audited" | "failed";
  error?: string;
  raw?: unknown;
}

export class CachedStaticHtmlFetcher implements StaticHtmlFetcher {
  private readonly cache = new Map<string, Promise<FetchedHtmlPage>>();

  constructor(private readonly source: StaticHtmlFetcher = new PublicStaticHtmlFetcher()) {}

  async fetch(input: { url: string; timeoutMs: number }): Promise<FetchedHtmlPage> {
    const normalized = validateAndNormalizeUrl(input.url);
    if (!normalized.ok) throw new AuditEngineError(normalized.error, false);
    const key = normalized.url;
    const cached = this.cache.get(key);
    if (cached) return cached;

    const pending = this.source.fetch({ ...input, url: key }).then((page) => {
      this.cache.set(key, Promise.resolve(page));
      const finalUrl = validateAndNormalizeUrl(page.url);
      if (finalUrl.ok) this.cache.set(finalUrl.url, Promise.resolve(page));
      return page;
    }).catch((error: unknown) => {
      this.cache.delete(key);
      throw error;
    });
    this.cache.set(key, pending);
    return pending;
  }
}

export async function runGeoAudit(input: GeoAuditInput, dependencies: GeoAuditDependencies = {}): Promise<RawAuditResult> {
  const start = validateAndNormalizeUrl(input.url);
  if (!start.ok) throw new AuditEngineError(start.error, false);

  const maxPages = clampGeoPageLimit(input.maxPages);
  const now = dependencies.now ?? (() => new Date());
  const fetcher = dependencies.fetcher instanceof CachedStaticHtmlFetcher
    ? dependencies.fetcher
    : new CachedStaticHtmlFetcher(dependencies.fetcher ?? new PublicStaticHtmlFetcher());
  const engine = dependencies.engine ?? new StaticHtmlAuditEngine(fetcher, now);
  const timeoutMs = positiveTimeout(input.timeoutMs);
  const startedAt = now().toISOString();

  // Fetch the homepage once to anchor the crawl and discover its canonical URL.
  const homepage = await fetcher.fetch({ url: start.url, timeoutMs });
  const canonicalHome = validateAndNormalizeUrl(homepage.url);
  if (!canonicalHome.ok) throw new AuditEngineError("The homepage resolved to a non-public URL.", false);
  const rootUrl = canonicalHome.url;
  const rootOrigin = new URL(rootUrl).origin;

  const pending: Array<{ url: string; page?: FetchedHtmlPage }> = [{ url: rootUrl, page: homepage }];
  const discovered = new Set([rootUrl]);
  const attempted: PageAttempt[] = [];
  const successes: PageSuccess[] = [];
  const pageFailures: AuditEngineError[] = [];

  while (pending.length > 0 && attempted.length < maxPages) {
    const next = pending.shift()!;
    let page: FetchedHtmlPage | null = null;
    let discoverablePage: FetchedHtmlPage | null = null;
    const pageIndex = attempted.length + 1;
    try {
      page = next.page ?? await fetcher.fetch({ url: next.url, timeoutMs });
      const fetchedUrl = validateAndNormalizeUrl(page.url);
      if (!fetchedUrl.ok || new URL(fetchedUrl.url).origin !== rootOrigin) {
        throw new AuditEngineError("An internal page redirected outside the homepage origin.", false);
      }
      discoverablePage = page;

      const engineResult = await engine.auditPage({
        url: fetchedUrl.url,
        timeoutMs,
        includeJavaScriptRendering: false,
        includeCoreWebVitals: false,
      });
      const pageOutput = isRecord(engineResult.output) ? engineResult.output : null;
      const reportedUrl = typeof pageOutput?.url === "string" ? validateAndNormalizeUrl(pageOutput.url) : null;
      if (reportedUrl && (!reportedUrl.ok || new URL(reportedUrl.url).origin !== rootOrigin)) {
        throw new AuditEngineError("An internal page resolved outside the homepage origin.", false);
      }

      const normalized = normalizeAuditResult({
        jobId: `geo-page-${pageIndex}`,
        auditId: `geo-page-audit-${pageIndex}`,
        type: "geo_audit",
        url: fetchedUrl.url,
        requestedBy: "kaseobot-worker",
        startedAt,
        now,
        engineResult,
      });
      const signals = analyzeGeoPage(page.html, fetchedUrl.url);
      successes.push({ url: fetchedUrl.url, normalized, signals });
      attempted.push({ url: fetchedUrl.url, status: "audited", raw: engineResult.output });
    } catch (error) {
      const failure = asPageError(error);
      pageFailures.push(failure);
      attempted.push({ url: next.url, status: "failed", error: safeError(failure.message) });
    }

    if (discoverablePage) {
      const links = extractInternalLinks(discoverablePage.html, discoverablePage.url, maxPages);
      for (const url of links.slice(1)) {
        if (discovered.has(url)) continue;
        if (attempted.length + pending.length >= maxPages) break;
        discovered.add(url);
        pending.push({ url });
      }
    }
  }

  if (successes.length === 0) {
    const retryable = pageFailures.some((failure) => failure.retryable);
    throw new AuditEngineError("Every discovered page failed during the GEO audit.", retryable);
  }

  const seoCategories = aggregateSeoCategories(successes);
  const geoCategories = aggregateGeoCategories(successes);
  const categories = [...seoCategories, ...geoCategories];
  const geoScores = {
    citability: mean(successes.map((page) => page.signals.scores.citability)),
    crawlerAccess: null,
    schema: mean(successes.map((page) => page.signals.scores.schema)),
    contentQuality: mean(successes.map((page) => page.signals.scores.contentQuality)),
  };

  return {
    engineName: GEO_AUDIT_ENGINE_NAME,
    engineVersion: GEO_AUDIT_ENGINE_VERSION,
    output: {
      url: rootUrl,
      timestamp: now().toISOString(),
      overallScore: mean(categories.map((category) => category.score).filter((score): score is number => score !== null)),
      crawledPages: successes.length,
      categoryResults: categories.map((category) => ({
        categoryId: category.id,
        categoryName: category.name,
        score: category.score,
        passCount: category.findings.filter((finding) => finding.status === "pass").length,
        warnCount: category.findings.filter((finding) => finding.status === "warn").length,
        failCount: category.findings.filter((finding) => finding.status === "fail").length,
        skippedCount: category.findings.filter((finding) => finding.status === "skipped").length,
        results: category.findings.map(serializeFinding),
      })),
      geo: {
        pagesRequested: attempted.length,
        pagesAudited: successes.length,
        pagesFailed: attempted.length - successes.length,
        scores: geoScores,
      },
      pageResults: attempted,
      pageErrors: pageFailures.map((failure) => ({ retryable: failure.retryable, message: safeError(failure.message) })),
    },
  };
}

function aggregateSeoCategories(pages: PageSuccess[]): AuditCategory[] {
  const categories = new Map<string, { name: string; scores: number[]; findings: AuditFinding[] }>();
  pages.forEach((page, pageIndex) => {
    for (const category of page.normalized.categories) {
      const id = `seo-${category.id}`;
      let aggregate = categories.get(id);
      if (!aggregate) {
        aggregate = { name: `SEO — ${category.name}`, scores: [], findings: [] };
        categories.set(id, aggregate);
      }
      if (category.score !== null) aggregate.scores.push(category.score);
      aggregate.findings.push(...category.findings.map((finding) => ({
        ...finding,
        id: `seo-p${pageIndex + 1}-${finding.id}`,
        pageUrl: page.url,
      })));
    }
  });
  return [...categories.entries()].map(([id, item]) => ({
    id,
    name: item.name,
    score: mean(item.scores),
    findings: item.findings,
  }));
}

function aggregateGeoCategories(pages: PageSuccess[]): AuditCategory[] {
  const groups = new Map<string, { name: string; scores: number[]; findings: AuditFinding[] }>();
  pages.forEach((page, pageIndex) => {
    for (const category of page.signals.categories) {
      let aggregate = groups.get(category.id);
      if (!aggregate) {
        aggregate = { name: category.name, scores: [], findings: [] };
        groups.set(category.id, aggregate);
      }
      if (category.score !== null) aggregate.scores.push(category.score);
      aggregate.findings.push(...category.findings.map((finding) => ({
        ...finding,
        id: `geo-p${pageIndex + 1}-${finding.id}`,
        pageUrl: page.url,
      })));
    }
  });
  return [...groups.entries()].map(([id, item]) => ({
    id,
    name: item.name,
    score: mean(item.scores),
    findings: item.findings,
  }));
}

function serializeFinding(finding: AuditFinding): AuditFinding {
  return { ...finding };
}

function mean(values: number[]): number | null {
  if (values.length === 0) return null;
  return Math.round(values.reduce((sum, value) => sum + value, 0) / values.length);
}

function positiveTimeout(value: number): number {
  return Number.isSafeInteger(value) && value > 0 ? Math.min(value, 60_000) : 20_000;
}

function asPageError(error: unknown): AuditEngineError {
  if (error instanceof AuditEngineError) return error;
  if (error instanceof TypeError) return new AuditEngineError("The audit engine returned an unsupported page result.", false);
  return new AuditEngineError("The page could not be audited due to a temporary error.", true);
}

function safeError(value: string): string {
  return value.replace(/[\r\n\t]+/g, " ").slice(0, 240);
}

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === "object" && value !== null && !Array.isArray(value);
}
