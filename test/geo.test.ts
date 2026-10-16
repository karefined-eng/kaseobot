import { describe, expect, it, vi } from "vitest";
import { buildFilteredAuditInput } from "../src/ai/filtered-audit-input";
import { buildFallbackReport } from "../src/audits/fallback-report";
import { analyzeGeoPage } from "../src/audits/geo-checks";
import { CachedStaticHtmlFetcher, runGeoAudit } from "../src/audits/geo";
import { extractInternalLinks } from "../src/audits/geo-links";
import { normalizeAuditResult } from "../src/audits/normalizer";
import { AuditEngineError, type AuditEngine, type RawAuditResult, type StaticHtmlFetcher } from "../src/audits/types";

const FIXED_TIME = "2026-10-13T00:00:00.000Z";
const GEO_INPUT = { url: "https://example.com/", maxPages: 5, timeoutMs: 5_000 };

function pageHtml(links = ""): string {
  const longParagraph = "Kaseobot evaluates the visible information on this page and reports measurable technical signals for people and automated systems. ".repeat(10);
  return `<!doctype html><html lang="en"><head><title>Example</title><script type="application/ld+json">{"@context":"https://schema.org","@graph":[{"@type":"Organization"}]}</script></head><body><main><h1>Example overview</h1><p>${longParagraph}</p><h2>Details</h2><p>${longParagraph}</p><h2>More information</h2><p>${longParagraph}</p>${links}</main></body></html>`;
}

function engineResult(url: string): RawAuditResult {
  return {
    engineName: "fixture-seo-engine",
    engineVersion: "1.0.0",
    output: {
      url,
      timestamp: FIXED_TIME,
      overallScore: 80,
      categoryResults: [{
        categoryId: "technical",
        categoryName: "Technical SEO",
        score: 80,
        results: [{
          id: "title-present",
          title: "Page title is present",
          status: "passed",
          severity: "high",
          evidence: "The page has a title.",
          recommendation: "Keep the title descriptive.",
          pageUrl: url,
        }],
      }],
    },
  };
}

function makeFetcher(pages: Map<string, string>): StaticHtmlFetcher & { fetch: ReturnType<typeof vi.fn> } {
  const fetch = vi.fn(async ({ url }: { url: string; timeoutMs: number }) => {
    const html = pages.get(url);
    if (html === undefined) throw new AuditEngineError(`Missing fixture page: ${url}`, false);
    return { url, html, status: 200 };
  });
  return { fetch };
}

function makeEngine(shouldFail?: (url: string) => boolean): AuditEngine & { auditPage: ReturnType<typeof vi.fn> } {
  const auditPage = vi.fn(async ({ url }: { url: string; timeoutMs: number; includeJavaScriptRendering: false; includeCoreWebVitals: false }) => {
    if (shouldFail?.(url)) throw new AuditEngineError("Fixture page failed.", false);
    return engineResult(url);
  });
  return { auditPage };
}

function normalizeGeo(raw: RawAuditResult) {
  return normalizeAuditResult({
    jobId: "geo-job-test",
    auditId: "geo-audit-test",
    type: "geo_audit",
    url: GEO_INPUT.url,
    requestedBy: "test-user",
    startedAt: FIXED_TIME,
    now: () => new Date(FIXED_TIME),
    engineResult: raw,
  });
}

describe("GEO link discovery", () => {
  it("keeps only validated same-origin HTTP(S) HTML links, removes fragments/duplicates, and obeys the hard cap", () => {
    const html = `<a href="/about#team">About</a>
      <a href="https://example.com/about">Duplicate</a>
      <a href="/search?q=geo&amp;page=2">Search</a>
      <a href="https://outside.org/article">External</a>
      <a href="http://127.0.0.1/admin">Private</a>
      <a href="javascript:alert(1)">Script</a>
      <a href="/paper.pdf">PDF</a>
      <a href="/team">Team</a>
      <a href="/company">Company</a>
      <a href="/contact">Contact</a>`;

    expect(extractInternalLinks(html, "https://example.com/", 99)).toEqual([
      "https://example.com/",
      "https://example.com/about",
      "https://example.com/search?q=geo&page=2",
      "https://example.com/team",
      "https://example.com/company",
    ]);
  });

  it("rejects malformed, non-public, and cross-origin seed URLs before discovery", () => {
    expect(extractInternalLinks("<a href='/ok'>", "http://127.0.0.1/", 5)).toEqual([]);
    expect(extractInternalLinks("<a href='/ok'>", "not a URL", 5)).toEqual([]);
  });
});

describe("GEO static signals", () => {
  it("reports transparent citability, Schema.org, and content-structure scores", () => {
    const signals = analyzeGeoPage(pageHtml(), "https://example.com/");
    expect(signals.scores).toEqual({ citability: 100, schema: 100, contentQuality: 100 });
    expect(signals.categories.map((category) => category.id)).toEqual([
      "geo-citability",
      "geo-schema",
      "geo-content-quality",
    ]);
    expect(signals.categories[1].findings[0].evidence).toContain("Organization");
  });

  it("treats absent signals as warnings, not failed checks", () => {
    const signals = analyzeGeoPage("<html><body><p>Short page.</p></body></html>", "https://example.com/");
    expect(signals.categories.flatMap((category) => category.findings).every((finding) => finding.status === "warn")).toBe(true);
  });
});

describe("bounded GEO crawl and aggregation", () => {
  it("crawls breadth-first on one origin, hard-caps at five pages, and aggregates SEO and GEO findings", async () => {
    const pages = new Map([
      ["https://example.com/", pageHtml('<a href="/about">About</a><a href="/pricing">Pricing</a><a href="/team">Team</a><a href="/faq">FAQ</a><a href="/contact">Contact</a><a href="https://outside.org/out">External</a>')],
      ["https://example.com/about", pageHtml('<a href="/team">Team</a>')],
      ["https://example.com/pricing", pageHtml()],
      ["https://example.com/team", pageHtml()],
      ["https://example.com/faq", pageHtml()],
      ["https://example.com/contact", pageHtml()],
    ]);
    const fetcher = makeFetcher(pages);
    const engine = makeEngine();
    const raw = await runGeoAudit({ ...GEO_INPUT, maxPages: 100 }, {
      engine,
      fetcher,
      now: () => new Date(FIXED_TIME),
    });
    const audit = normalizeGeo(raw);

    expect(fetcher.fetch).toHaveBeenCalledTimes(5);
    expect(engine.auditPage).toHaveBeenCalledTimes(5);
    expect(audit.geo).toEqual({
      pagesRequested: 5,
      pagesAudited: 5,
      pagesFailed: 0,
      scores: { citability: 100, crawlerAccess: null, schema: 100, contentQuality: 100 },
    });
    expect(audit.categories.map((category) => category.id)).toEqual([
      "seo-technical",
      "geo-citability",
      "geo-schema",
      "geo-content-quality",
    ]);
    expect(audit.categories[0].findings).toHaveLength(5);
    expect(audit.summary.passed).toBeGreaterThan(0);
    expect(audit.raw).toEqual(raw.output);

    const report = buildFallbackReport(audit);
    expect(report).toContain("kaseomator GEO audit");
    expect(report).toContain("Pages: 5 requested, 5 audited, 0 failed.");
    expect(report).toContain("SEO findings:");
    expect(report).toContain("GEO findings:");
  });

  it("keeps successful pages and reports a failed subpage without failing the whole job", async () => {
    const pages = new Map([
      ["https://example.com/", pageHtml('<a href="/ok">OK</a><a href="/broken">Broken</a>')],
      ["https://example.com/ok", pageHtml()],
      ["https://example.com/broken", pageHtml()],
    ]);
    const raw = await runGeoAudit(GEO_INPUT, {
      engine: makeEngine((url) => url.endsWith("/broken")),
      fetcher: makeFetcher(pages),
      now: () => new Date(FIXED_TIME),
    });
    const audit = normalizeGeo(raw);

    expect(audit.geo).toMatchObject({ pagesRequested: 3, pagesAudited: 2, pagesFailed: 1 });
    expect((raw.output as { pageErrors: unknown[] }).pageErrors).toHaveLength(1);
    expect(audit.status).toBe("completed");
  });

  it("rejects an internal page redirect outside the site origin before auditing or discovering its links", async () => {
    const fetch = vi.fn(async ({ url }: { url: string; timeoutMs: number }) => url === "https://example.com/"
      ? { url, html: pageHtml('<a href="/redirect">Redirect</a>'), status: 200 }
      : { url: "https://outside.org/final", html: pageHtml('<a href="/another">Another</a>'), status: 200 });
    const engine = makeEngine();
    const raw = await runGeoAudit(GEO_INPUT, {
      engine,
      fetcher: { fetch },
      now: () => new Date(FIXED_TIME),
    });
    const audit = normalizeGeo(raw);

    expect(engine.auditPage).toHaveBeenCalledOnce();
    expect(audit.geo).toMatchObject({ pagesRequested: 2, pagesAudited: 1, pagesFailed: 1 });
    expect((raw.output as { pageResults: Array<{ url: string }> }).pageResults[1].url)
      .toBe("https://example.com/redirect");
  });

  it("exposes aggregated SEO/GEO findings and page metrics in the filtered Kimi input", async () => {
    const pages = new Map([
      ["https://example.com/", pageHtml('<a href="/about">About</a>').replace(/<script[^>]*>[\s\S]*?<\/script>/i, "")],
      ["https://example.com/about", pageHtml().replace(/<script[^>]*>[\s\S]*?<\/script>/i, "")],
    ]);
    const raw = await runGeoAudit({ ...GEO_INPUT, maxPages: 2 }, {
      engine: makeEngine(),
      fetcher: makeFetcher(pages),
      now: () => new Date(FIXED_TIME),
    });
    const filtered = buildFilteredAuditInput(normalizeGeo(raw));

    expect(filtered.auditType).toBe("geo_audit");
    expect(filtered.geo).toMatchObject({ pagesRequested: 2, pagesAudited: 2, pagesFailed: 0 });
    expect(filtered.categories.some((category) => category.id === "seo-technical")).toBe(true);
    expect(filtered.categories.some((category) => category.id === "geo-schema")).toBe(true);
    expect(filtered.findings.some((finding) => finding.category.startsWith("GEO — Structured data"))).toBe(true);
    expect(JSON.stringify(filtered)).not.toContain("pageResults");
  });

  it("marks an all-pages-failed crawl as retryable when the page failures are transient", async () => {
    const pages = new Map([
      ["https://example.com/", pageHtml('<a href="/second">Second</a>')],
      ["https://example.com/second", pageHtml()],
    ]);
    const engine: AuditEngine = {
      auditPage: vi.fn(async () => { throw new AuditEngineError("Temporary engine outage.", true); }),
    };

    await expect(runGeoAudit(GEO_INPUT, {
      engine,
      fetcher: makeFetcher(pages),
      now: () => new Date(FIXED_TIME),
    })).rejects.toMatchObject({ name: "AuditEngineError", retryable: true });
  });

  it("caches the homepage fetch so discovery and the default static engine can reuse it", async () => {
    const fetcher = makeFetcher(new Map([["https://example.com/", pageHtml()]]));
    const cached = new CachedStaticHtmlFetcher(fetcher);
    await cached.fetch({ url: "https://example.com/", timeoutMs: 5_000 });
    await cached.fetch({ url: "https://example.com/", timeoutMs: 5_000 });
    expect(fetcher.fetch).toHaveBeenCalledOnce();
  });
});
