import { readFile } from "node:fs/promises";
import { afterEach, describe, expect, it, vi } from "vitest";
import { buildFallbackReport } from "../src/audits/fallback-report";
import { normalizeAuditResult, parseStatus } from "../src/audits/normalizer";
import { PublicStaticHtmlFetcher, StaticHtmlAuditEngine } from "../src/audits/static-html-engine";
import { SeomatorAuditEngine } from "../src/audits/seomator-engine";
import { AuditEngineError, type KaseobotAuditResult, type RawAuditResult, type StaticHtmlFetcher } from "../src/audits/types";

const FIXED_TIME = "2026-01-23T16:00:00.000Z";
const FIXTURE_DIRECTORY = new URL("./fixtures/", import.meta.url);
const EXPECTED_DIRECTORY = new URL("./fixtures/expected/", import.meta.url);

function input(url = "https://example.com/") {
  return {
    url,
    timeoutMs: 5_000,
    includeJavaScriptRendering: false as const,
    includeCoreWebVitals: false as const,
  };
}

async function readFixture(name: string): Promise<string> {
  return readFile(new URL(name, FIXTURE_DIRECTORY), "utf8");
}

async function readExpected(name: string): Promise<Record<string, unknown>> {
  return JSON.parse(await readFile(new URL(`${name}.json`, EXPECTED_DIRECTORY), "utf8")) as Record<string, unknown>;
}

async function auditHtml(html: string, url = "https://example.com/", fetcher?: StaticHtmlFetcher): Promise<KaseobotAuditResult> {
  const staticFetcher = fetcher ?? {
    fetch: async () => ({ url, html, status: 200 }),
  };
  const engine = new StaticHtmlAuditEngine(staticFetcher, () => new Date(FIXED_TIME));
  const engineResult = await engine.auditPage(input(url));
  return normalizeAuditResult({
    jobId: "fixture-job-id",
    auditId: "fixture-audit-id",
    type: "seo_audit",
    url,
    requestedBy: "42",
    startedAt: FIXED_TIME,
    now: () => new Date(FIXED_TIME),
    engineResult,
  });
}

function projectResult(audit: KaseobotAuditResult): Record<string, unknown> {
  return {
    status: audit.status,
    overallScore: audit.overallScore,
    summary: audit.summary,
    findingStatuses: Object.fromEntries(
      audit.categories.flatMap((category) => category.findings.map((finding) => [finding.id, finding.status])),
    ),
  };
}

async function makeHtmlResponse(name: string): Promise<Response> {
  return new Response(await readFixture(name), {
    status: 200,
    headers: { "content-type": "text/html; charset=utf-8" },
  });
}

afterEach(() => {
  vi.unstubAllGlobals();
});

describe("static HTML audit fixtures and canonical JSON", () => {
  it.each([
    { fixture: "valid-page", expected: "valid-page" },
    { fixture: "missing-title", expected: "missing-title" },
    { fixture: "missing-meta-description", expected: "missing-meta-description" },
    { fixture: "no-canonical", expected: "no-canonical" },
    { fixture: "multiple-h1", expected: "multiple-h1" },
    { fixture: "images-without-alt", expected: "images-without-alt" },
    { fixture: "redirect-page", expected: "redirect-page" },
  ])("produces expected normalized JSON for $fixture", async ({ fixture, expected }) => {
    const audit = await auditHtml(await readFixture(`${fixture}.html`), fixture === "redirect-page" ? "https://www.example.com/" : undefined);
    expect(projectResult(audit)).toEqual(await readExpected(expected));
    expect(audit.raw).toMatchObject({ crawledPages: 1, categoryResults: expect.any(Array) });
    expect(audit.engine).toEqual({ name: "kaseobot-static-html", version: "1.0.0" });
  });

  it("stores exactly the raw engine output on the normalized result", async () => {
    const html = await readFixture("valid-page.html");
    const engine = new StaticHtmlAuditEngine({ fetch: async () => ({ url: "https://example.com/", html, status: 200 }) }, () => new Date(FIXED_TIME));
    const raw = await engine.auditPage(input());
    const audit = normalizeAuditResult({
      jobId: "job-raw",
      auditId: "audit-raw",
      type: "seo_audit",
      url: "https://example.com/",
      requestedBy: "42",
      startedAt: FIXED_TIME,
      now: () => new Date(FIXED_TIME),
      engineResult: raw,
    });
    expect(audit.raw).toEqual(raw.output);
    expect(audit.completedAt).toBe(FIXED_TIME);
  });
});

describe("public static HTML fetching", () => {
  it("follows a public redirect and audits the final page", async () => {
    const finalPage = await makeHtmlResponse("redirect-page.html");
    const fetchMock = vi.fn()
      .mockResolvedValueOnce(new Response(null, { status: 301, headers: { location: "https://www.example.com/final" } }))
      .mockResolvedValueOnce(finalPage);
    vi.stubGlobal("fetch", fetchMock);

    const audit = await auditHtml("", "https://example.com/start", new PublicStaticHtmlFetcher());
    expect(audit.url).toBe("https://www.example.com/final");
    expect(audit.overallScore).toBe(100);
    expect(fetchMock).toHaveBeenCalledTimes(2);
    expect((fetchMock.mock.calls[0]?.[1] as RequestInit).redirect).toBe("manual");
  });

  it("rejects a redirect to a private address before making the second request", async () => {
    const fetchMock = vi.fn().mockResolvedValue(
      new Response(null, { status: 302, headers: { location: "http://127.0.0.1/latest/meta-data/" } }),
    );
    vi.stubGlobal("fetch", fetchMock);

    await expect(new PublicStaticHtmlFetcher().fetch({ url: "https://example.com/", timeoutMs: 5_000 }))
      .rejects.toMatchObject({ name: "AuditEngineError", retryable: false });
    expect(fetchMock).toHaveBeenCalledOnce();
  });

  it("rejects the private URL fixture without making any network request", async () => {
    const privateUrl = (await readFixture("private-url.txt")).trim();
    const fetchMock = vi.fn();
    vi.stubGlobal("fetch", fetchMock);

    const error = await new PublicStaticHtmlFetcher().fetch({ url: privateUrl, timeoutMs: 5_000 }).catch((reason: unknown) => reason);
    expect(projectError(error)).toEqual(await readExpected("private-url"));
    expect(fetchMock).not.toHaveBeenCalled();
  });

  it("treats a not-found fixture as a permanent error", async () => {
    const notFoundBody = await readFixture("not-found.html");
    const fetchMock = vi.fn().mockResolvedValue(new Response(notFoundBody, {
      status: 404,
      headers: { "content-type": "text/html" },
    }));
    vi.stubGlobal("fetch", fetchMock);

    const error = await new PublicStaticHtmlFetcher().fetch({ url: "https://example.com/missing", timeoutMs: 5_000 }).catch((reason: unknown) => reason);
    expect(projectError(error)).toEqual(await readExpected("not-found"));
  });

  it("does not create browser or JavaScript-rendering dependencies", async () => {
    const html = await readFixture("valid-page.html");
    const audit = await auditHtml(html);
    expect(audit.raw).not.toHaveProperty("renderedHtml");
    expect(audit.raw).not.toHaveProperty("coreWebVitals");
  });
});

describe("canonical normalizer", () => {
  it("maps unrecognized and not-measured states to skipped, preserves evidence, and bounds scores", () => {
    const rawOutput = {
      url: "https://example.com/",
      overallScore: 120,
      timestamp: FIXED_TIME,
      categoryResults: [{
        categoryId: "core",
        name: "Core",
        score: "105",
        results: [
          { id: "ok", status: "passed", severity: "critical", evidence: "Present" },
          { id: "warn", result: "warning", severity: "moderate", details: "Needs review" },
          { id: "not-measured", status: "not-measured" },
          { id: "unknown", status: "future-state" },
        ],
      }],
    };
    const audit = normalizeAuditResult({
      jobId: "job-normalizer",
      auditId: "audit-normalizer",
      type: "seo_audit",
      url: "https://example.com/",
      requestedBy: "42",
      startedAt: FIXED_TIME,
      engineResult: { engineName: "fixture-engine", engineVersion: "2.3", output: rawOutput },
    });

    expect(audit.overallScore).toBe(100);
    expect(audit.categories[0].score).toBe(100);
    expect(audit.categories[0].findings.map((finding) => finding.status)).toEqual(["pass", "warn", "skipped", "skipped"]);
    expect(audit.categories[0].findings[1].evidence).toBe("Needs review");
    expect(audit.summary).toEqual({ passed: 1, warnings: 1, failed: 0, skipped: 2 });
    expect(audit.raw).toEqual(rawOutput);
    expect(parseStatus("never-seen-before")).toBe("skipped");
  });

  it("uses deterministic finding IDs when the engine omits one", () => {
    const audit = normalizeAuditResult({
      jobId: "job-id",
      auditId: "audit-id",
      type: "seo_audit",
      url: "https://example.com/",
      requestedBy: "42",
      engineResult: { engineName: "fixture", engineVersion: "1", output: {
        categoryResults: [{ categoryId: "core", results: [{ status: "ok" }] }],
      } },
    });
    expect(audit.categories[0].findings[0].id).toBe("core-finding-1");
  });
});

describe("deterministic fallback report", () => {
  it("uses only returned non-pass findings and never includes the raw engine payload", async () => {
    const audit = await auditHtml(await readFixture("missing-title.html"));
    audit.raw = { marker: "RAW-ENGINE-PAYLOAD-MUST-NOT-LEAK" };
    const first = buildFallbackReport(audit);
    const second = buildFallbackReport(audit);

    expect(first).toBe(second);
    expect(first).toContain("1 failed");
    expect(first).toContain("Page title is present");
    expect(first).not.toContain("Meta description is present");
    expect(first).not.toContain("RAW-ENGINE-PAYLOAD-MUST-NOT-LEAK");
    expect(first.length).toBeLessThan(4096);
  });
});

describe("SEOmator adapter isolation", () => {
  it("supports the documented createAuditor().audit(url) shape through an injected loader", async () => {
    const audit = vi.fn().mockResolvedValue({ url: "https://example.com/", overallScore: 88, categoryResults: [] });
    const createAuditor = vi.fn().mockReturnValue({ audit });
    const adapter = new SeomatorAuditEngine(async () => ({ createAuditor, version: "fixture" }));

    const result = await adapter.auditPage(input());

    expect(createAuditor).toHaveBeenCalledOnce();
    expect(createAuditor.mock.calls[0][0]).toMatchObject({ measureCwv: false });
    expect(audit).toHaveBeenCalledWith("https://example.com/");
    expect(result.engineName).toBe("seomator");
  });
});

function projectError(error: unknown): Record<string, unknown> {
  return {
    status: "failed",
    error: error instanceof AuditEngineError ? error.message : error instanceof Error ? error.message : String(error),
  };
}
