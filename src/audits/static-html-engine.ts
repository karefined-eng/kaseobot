import { validateAndNormalizeUrl } from "../url-validation";
import {
  AuditEngineError,
  type AuditCategory,
  type AuditFinding,
  type AuditFindingStatus,
  type AuditPageInput,
  type AuditSeverity,
  type FetchedHtmlPage,
  type RawAuditResult,
  type StaticHtmlFetcher,
} from "./types";

export const STATIC_HTML_ENGINE_NAME = "kaseobot-static-html";
export const STATIC_HTML_ENGINE_VERSION = "1.0.0";
const MAX_HTML_BYTES = 2_000_000;
const MAX_REDIRECTS = 5;

type Clock = () => Date;

export class StaticHtmlAuditEngine {
  constructor(
    private readonly fetcher: StaticHtmlFetcher = new PublicStaticHtmlFetcher(),
    private readonly clock: Clock = () => new Date(),
  ) {}

  async auditPage(input: AuditPageInput): Promise<RawAuditResult> {
    const page = await this.fetcher.fetch({ url: input.url, timeoutMs: input.timeoutMs });
    const findings = inspectHtml(page.html, page.url);
    const categories = groupFindings(findings);
    const output = {
      url: page.url,
      overallScore: scoreFindings(findings),
      timestamp: this.clock().toISOString(),
      crawledPages: 1,
      categoryResults: categories.map((category) => ({
        categoryId: category.id,
        categoryName: category.name,
        score: category.score,
        passCount: category.findings.filter((finding) => finding.status === "pass").length,
        warnCount: category.findings.filter((finding) => finding.status === "warn").length,
        failCount: category.findings.filter((finding) => finding.status === "fail").length,
        skippedCount: category.findings.filter((finding) => finding.status === "skipped").length,
        results: category.findings.map((finding) => ({
          id: finding.id,
          title: finding.title,
          severity: finding.severity,
          status: finding.status,
          pageUrl: finding.pageUrl,
          evidence: finding.evidence,
          recommendation: finding.recommendation,
          docsUrl: finding.docsUrl,
        })),
      })),
    };

    return {
      engineName: STATIC_HTML_ENGINE_NAME,
      engineVersion: STATIC_HTML_ENGINE_VERSION,
      output,
    };
  }
}

export class PublicStaticHtmlFetcher implements StaticHtmlFetcher {
  async fetch(input: { url: string; timeoutMs: number }): Promise<FetchedHtmlPage> {
    const initial = validateAndNormalizeUrl(input.url);
    if (!initial.ok) throw new AuditEngineError(initial.error, false);

    const timeoutMs = Math.max(1_000, Math.min(60_000, Math.trunc(input.timeoutMs)));
    const deadline = Date.now() + timeoutMs;
    let currentUrl = initial.url;

    for (let redirectCount = 0; redirectCount <= MAX_REDIRECTS; redirectCount += 1) {
      const remaining = deadline - Date.now();
      if (remaining <= 0) throw new AuditEngineError("The website took too long to respond.", true);

      let response: Response;
      try {
        response = await fetch(currentUrl, {
          method: "GET",
          redirect: "manual",
          headers: { accept: "text/html,application/xhtml+xml;q=0.9,*/*;q=0.1" },
          signal: AbortSignal.timeout(remaining),
        });
      } catch (error) {
        const timedOut = error instanceof Error && (error.name === "AbortError" || error.name === "TimeoutError");
        throw new AuditEngineError(
          timedOut ? "The website took too long to respond." : "The website could not be reached from the audit worker.",
          true,
        );
      }

      if (response.status >= 300 && response.status < 400) {
        const location = response.headers.get("location");
        try {
          await response.body?.cancel();
        } catch {
          // A redirect response body is not needed.
        }
        if (!location) throw new AuditEngineError("The website returned an unsupported redirect.", false);
        if (redirectCount === MAX_REDIRECTS) throw new AuditEngineError("The website redirected too many times.", false);

        let destination: string;
        try {
          destination = new URL(location, currentUrl).toString();
        } catch {
          throw new AuditEngineError("The website returned an invalid redirect target.", false);
        }
        const validated = validateAndNormalizeUrl(destination);
        if (!validated.ok) {
          throw new AuditEngineError("The website redirected to a non-public or unsupported URL.", false);
        }
        currentUrl = validated.url;
        continue;
      }

      if (response.status === 408 || response.status === 429 || response.status >= 500) {
        throw new AuditEngineError(`The website returned a temporary HTTP ${response.status} response.`, true);
      }
      if (response.status < 200 || response.status >= 300) {
        throw new AuditEngineError(`The website returned HTTP ${response.status}.`, false);
      }

      const contentType = response.headers.get("content-type")?.split(";")[0].trim().toLowerCase();
      if (contentType && contentType !== "text/html" && contentType !== "application/xhtml+xml") {
        throw new AuditEngineError("The website did not return an HTML page.", false);
      }

      const html = await readLimitedHtml(response);
      if (!html.trim() || (!contentType && !/<(?:!doctype\s+html|html|head|body)\b/i.test(html))) {
        throw new AuditEngineError("The website response did not contain a readable HTML page.", false);
      }
      return { url: currentUrl, html, status: response.status };
    }

    throw new AuditEngineError("The website redirected too many times.", false);
  }
}

async function readLimitedHtml(response: Response): Promise<string> {
  const declaredSize = Number(response.headers.get("content-length"));
  if (Number.isFinite(declaredSize) && declaredSize > MAX_HTML_BYTES) {
    try {
      await response.body?.cancel();
    } catch {
      // The oversized response is rejected regardless of cancellation outcome.
    }
    throw new AuditEngineError("The HTML page is larger than the 2 MB audit limit.", false);
  }

  if (!response.body) return "";
  const reader = response.body.getReader();
  const decoder = new TextDecoder();
  let totalBytes = 0;
  let html = "";
  try {
    while (true) {
      const { done, value } = await reader.read();
      if (done) break;
      totalBytes += value.byteLength;
      if (totalBytes > MAX_HTML_BYTES) {
        await reader.cancel();
        throw new AuditEngineError("The HTML page is larger than the 2 MB audit limit.", false);
      }
      html += decoder.decode(value, { stream: true });
    }
    html += decoder.decode();
  } catch (error) {
    if (error instanceof AuditEngineError) throw error;
    throw new AuditEngineError("The HTML page could not be read completely.", true);
  }
  return html;
}

function inspectHtml(html: string, pageUrl: string): AuditFinding[] {
  const staticMarkup = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, "");
  const findings: AuditFinding[] = [];

  const titleMatch = /<title\b[^>]*>([\s\S]*?)<\/title\s*>/i.exec(staticMarkup);
  const title = titleMatch ? decodeHtmlText(stripTags(titleMatch[1])).trim() : "";
  findings.push(makeFinding(
    "title-present",
    "Page title is present",
    title ? "pass" : "fail",
    "high",
    title ? `A non-empty title was found: “${truncate(title, 160)}”.` : "No non-empty <title> element was found.",
    "Add one concise, descriptive <title> element to the page head.",
    pageUrl,
  ));

  const description = findMetaContent(staticMarkup, "description");
  findings.push(makeFinding(
    "meta-description-present",
    "Meta description is present",
    description ? "pass" : "fail",
    "medium",
    description ? `A meta description was found (${description.length} characters).` : "No meta name=description content was found.",
    "Add a unique meta description that accurately summarizes the page.",
    pageUrl,
  ));

  const canonical = findCanonical(staticMarkup);
  findings.push(makeFinding(
    "canonical-link-present",
    "Canonical link is present",
    canonical ? "pass" : "fail",
    "high",
    canonical ? `A canonical link points to ${canonical}.` : "No link with rel=canonical and an href was found.",
    "Add a canonical link that identifies the preferred URL for this page.",
    pageUrl,
  ));

  const robots = findMetaContent(staticMarkup, "robots");
  const robotsDirectives = (robots ?? "").toLowerCase();
  const blocksIndexing = /(?:^|[,\s])noindex(?:$|[,\s])/.test(robotsDirectives);
  const blocksFollowing = /(?:^|[,\s])nofollow(?:$|[,\s])/.test(robotsDirectives);
  findings.push(makeFinding(
    "robots-meta-directives",
    "Robots indexing directives",
    blocksIndexing || blocksFollowing ? "fail" : "pass",
    blocksIndexing ? "critical" : "medium",
    robots === null
      ? "No robots meta directive was found; default index,follow behavior applies."
      : `Robots meta content is “${truncate(robots, 160)}”.`,
    blocksIndexing || blocksFollowing
      ? "Remove noindex/nofollow only if search engines and users should be able to discover this page."
      : "No blocking robots directive was detected.",
    pageUrl,
  ));

  const viewport = findMetaContent(staticMarkup, "viewport");
  findings.push(makeFinding(
    "viewport-meta-present",
    "Mobile viewport meta tag is present",
    viewport ? "pass" : "warn",
    "medium",
    viewport ? `Viewport content is “${truncate(viewport, 160)}”.` : "No meta name=viewport content was found.",
    "Add a viewport meta tag, commonly width=device-width, initial-scale=1.",
    pageUrl,
  ));

  const h1Count = countTags(staticMarkup, "h1");
  findings.push(makeFinding(
    "h1-presence-and-count",
    "H1 heading presence and count",
    h1Count === 1 ? "pass" : h1Count === 0 ? "fail" : "warn",
    h1Count === 0 ? "high" : "medium",
    `Found ${h1Count} H1 heading${h1Count === 1 ? "" : "s"}.`,
    h1Count === 1
      ? "Keep one descriptive H1 heading that reflects the main page topic."
      : h1Count === 0
        ? "Add one descriptive H1 heading for the main page topic."
        : "Review the multiple H1 headings and use a clear, deliberate heading outline.",
    pageUrl,
  ));

  const images = findTags(staticMarkup, "img");
  const imagesWithoutAlt = images.filter((tag) => !parseAttributes(tag).has("alt")).length;
  findings.push(makeFinding(
    "image-alt-attributes",
    "Image alt attributes",
    imagesWithoutAlt === 0 ? "pass" : "warn",
    "medium",
    images.length === 0
      ? "No image elements were found."
      : `Found ${imagesWithoutAlt} of ${images.length} image element${images.length === 1 ? "" : "s"} without an alt attribute.`,
    imagesWithoutAlt === 0
      ? "No missing image alt attributes were detected."
      : "Add meaningful alt text to informative images; use alt=\"\" for decorative images.",
    pageUrl,
  ));

  const { internal, external } = countLinks(staticMarkup, pageUrl);
  findings.push(makeFinding(
    "internal-links",
    "Internal links",
    internal > 0 ? "pass" : "warn",
    "low",
    `Found ${internal} HTTP(S) internal link${internal === 1 ? "" : "s"}.`,
    internal > 0 ? "No action is required for this count-only check." : "Add useful internal links where they help visitors discover related pages.",
    pageUrl,
  ));
  findings.push(makeFinding(
    "external-links",
    "External links",
    "pass",
    "info",
    `Found ${external} HTTP(S) external link${external === 1 ? "" : "s"}.`,
    "No action is required for this count-only check.",
    pageUrl,
  ));

  const htmlAttrs = firstTagAttributes(staticMarkup, "html");
  const lang = htmlAttrs.get("lang")?.trim() ?? "";
  findings.push(makeFinding(
    "html-lang-attribute",
    "HTML language attribute",
    lang ? "pass" : "warn",
    "low",
    lang ? `The root HTML element declares lang=\"${truncate(lang, 80)}\".` : "The root <html> element has no non-empty lang attribute.",
    "Set the root html lang attribute to the primary language of the page.",
    pageUrl,
  ));

  const isHttps = new URL(pageUrl).protocol === "https:";
  findings.push(makeFinding(
    "https-enforcement",
    "HTTPS is used for the audited page",
    isHttps ? "pass" : "warn",
    "high",
    isHttps ? "The final audited page URL uses HTTPS." : "The final audited page URL uses HTTP rather than HTTPS.",
    isHttps ? "No action is required for this check." : "Serve the page over HTTPS and redirect HTTP requests to the HTTPS URL.",
    pageUrl,
  ));

  const headingLevels = findHeadingLevels(staticMarkup);
  const hierarchyProblem = findHeadingHierarchyProblem(headingLevels);
  findings.push(makeFinding(
    "heading-hierarchy",
    "Heading hierarchy",
    headingLevels.length === 0 ? "skipped" : hierarchyProblem ? "warn" : "pass",
    "low",
    headingLevels.length === 0
      ? "No heading elements were found, so heading hierarchy could not be assessed."
      : hierarchyProblem ?? `Found ${headingLevels.length} headings with no skipped heading levels.`,
    hierarchyProblem ? "Use a logical outline and avoid jumping over heading levels." : "No action is required for this hierarchy check.",
    pageUrl,
  ));

  return findings;
}

function makeFinding(
  id: string,
  title: string,
  status: AuditFindingStatus,
  severity: AuditSeverity,
  evidence: string,
  recommendation: string,
  pageUrl: string,
): AuditFinding {
  return { id, title, severity, status, pageUrl, evidence, recommendation, docsUrl: null };
}

function groupFindings(findings: AuditFinding[]): AuditCategory[] {
  const definitions = [
    { id: "technical", name: "Technical SEO", ids: ["title-present", "meta-description-present", "canonical-link-present", "robots-meta-directives", "html-lang-attribute", "https-enforcement"] },
    { id: "content", name: "Content structure", ids: ["h1-presence-and-count", "heading-hierarchy"] },
    { id: "images", name: "Images and mobile", ids: ["image-alt-attributes", "viewport-meta-present"] },
    { id: "links", name: "Links", ids: ["internal-links", "external-links"] },
  ];
  return definitions.map((definition) => {
    const categoryFindings = findings.filter((finding) => definition.ids.includes(finding.id));
    return { id: definition.id, name: definition.name, score: scoreFindings(categoryFindings), findings: categoryFindings };
  });
}

function scoreFindings(findings: AuditFinding[]): number | null {
  const assessed = findings.filter((finding) => finding.status !== "skipped");
  if (assessed.length === 0) return null;
  const points = assessed.reduce((sum, finding) => sum + (
    finding.status === "pass" ? 1 : finding.status === "warn" ? 0.5 : 0
  ), 0);
  return Math.round(points * 100 / assessed.length);
}

function findMetaContent(html: string, name: string): string | null {
  for (const tag of findTags(html, "meta")) {
    const attrs = parseAttributes(tag);
    if ((attrs.get("name") ?? "").trim().toLowerCase() === name.toLowerCase()) {
      return attrs.get("content")?.trim() ?? "";
    }
  }
  return null;
}

function findCanonical(html: string): string | null {
  for (const tag of findTags(html, "link")) {
    const attrs = parseAttributes(tag);
    const rels = (attrs.get("rel") ?? "").toLowerCase().split(/\s+/);
    const href = attrs.get("href")?.trim();
    if (rels.includes("canonical") && href) return href;
  }
  return null;
}

function countTags(html: string, name: string): number {
  return findTags(html, name).length;
}

function findTags(html: string, name: string): string[] {
  const expression = new RegExp(`<\\s*${name}\\b[^>]*>`, "gi");
  return html.match(expression) ?? [];
}

function firstTagAttributes(html: string, name: string): Map<string, string> {
  const tag = findTags(html, name)[0];
  return tag ? parseAttributes(tag) : new Map();
}

function parseAttributes(tag: string): Map<string, string> {
  const nameMatch = /^<\s*[a-z][\w:-]*/i.exec(tag);
  const attributes = tag.slice(nameMatch?.[0].length ?? 1).replace(/\s*\/?\s*>\s*$/, "");
  const result = new Map<string, string>();
  const expression = /([^\s=/>]+)(?:\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+)))?/g;
  for (const match of attributes.matchAll(expression)) {
    const key = match[1].toLowerCase();
    const value = match[2] ?? match[3] ?? match[4] ?? "";
    if (!result.has(key)) result.set(key, decodeHtmlText(value));
  }
  return result;
}

function countLinks(html: string, baseUrl: string): { internal: number; external: number } {
  let internal = 0;
  let external = 0;
  const origin = new URL(baseUrl).origin;
  for (const tag of findTags(html, "a")) {
    const href = parseAttributes(tag).get("href")?.trim();
    if (!href) continue;
    try {
      const destination = new URL(href, baseUrl);
      if (destination.protocol !== "http:" && destination.protocol !== "https:") continue;
      if (destination.origin === origin) internal += 1;
      else external += 1;
    } catch {
      // Invalid/missing URLs are excluded from link counts.
    }
  }
  return { internal, external };
}

function findHeadingLevels(html: string): number[] {
  const expression = /<\s*h([1-6])\b[^>]*>/gi;
  return [...html.matchAll(expression)].map((match) => Number(match[1]));
}

function findHeadingHierarchyProblem(levels: number[]): string | null {
  if (levels.length === 0) return null;
  if (levels[0] !== 1) return `The first heading is H${levels[0]}, not H1.`;
  for (let index = 1; index < levels.length; index += 1) {
    if (levels[index] > levels[index - 1] + 1) {
      return `Heading order jumps from H${levels[index - 1]} to H${levels[index]}.`;
    }
  }
  return null;
}

function stripTags(value: string): string {
  return value.replace(/<[^>]*>/g, " ");
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'")
    .replace(/&#(\d+);/g, (_match, decimal: string) => decodeCodePoint(Number(decimal)))
    .replace(/&#x([0-9a-f]+);/gi, (_match, hex: string) => decodeCodePoint(Number.parseInt(hex, 16)));
}

function decodeCodePoint(value: number): string {
  if (!Number.isInteger(value) || value < 0 || value > 0x10ffff || (value >= 0xd800 && value <= 0xdfff)) {
    return "\uFFFD";
  }
  return String.fromCodePoint(value);
}

function truncate(value: string, maximum: number): string {
  const compact = value.replace(/\s+/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}
