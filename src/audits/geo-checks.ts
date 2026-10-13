import type { AuditCategory, AuditFinding, AuditFindingStatus } from "./types";

export interface GeoPageSignals {
  categories: AuditCategory[];
  scores: {
    citability: number;
    schema: number;
    contentQuality: number;
  };
}

export function analyzeGeoPage(html: string, pageUrl: string): GeoPageSignals {
  const cleaned = html
    .replace(/<!--[\s\S]*?-->/g, "")
    .replace(/<head\b[^>]*>[\s\S]*?<\/head\s*>/gi, " ")
    .replace(/<(script|style|noscript)\b[^>]*>[\s\S]*?<\/\1\s*>/gi, " ");
  const text = decodeHtmlText(cleaned.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
  const paragraphs = [...cleaned.matchAll(/<p\b[^>]*>([\s\S]*?)<\/p\s*>/gi)]
    .map((match) => stripText(match[1]));
  const answerParagraph = paragraphs[0]?.length >= 120 ? paragraphs[0] : null;
  const subheadingCount = (cleaned.match(/<h[23]\b[^>]*>/gi) ?? []).length;
  const wordCount = text ? text.split(/\s+/u).filter(Boolean).length : 0;
  const hasSemanticContainer = /<(?:main|article)\b/i.test(cleaned);
  const schemaTypes = findSchemaTypes(html);

  const citabilityFindings = [
    makeFinding(
      "geo-answer-ready-summary",
      "Answer-ready introductory text",
      answerParagraph ? "pass" : "warn",
      "medium",
      answerParagraph
        ? `A page paragraph with ${answerParagraph.length} characters can serve as a concise answer or summary.`
        : "No paragraph of at least 120 characters was found by the static text check.",
      "Add a concise, directly stated answer or summary near the relevant heading.",
      pageUrl,
    ),
    makeFinding(
      "geo-descriptive-subheadings",
      "Descriptive section headings",
      subheadingCount >= 2 ? "pass" : "warn",
      "low",
      `Found ${subheadingCount} H2/H3 section heading${subheadingCount === 1 ? "" : "s"}.`,
      "Use clear H2/H3 headings to make the page's topic structure easier to scan.",
      pageUrl,
    ),
  ];
  const schemaFindings = [
    makeFinding(
      "geo-schema-org-data",
      "Schema.org structured data",
      schemaTypes.length > 0 ? "pass" : "warn",
      "medium",
      schemaTypes.length > 0
        ? `Found Schema.org type${schemaTypes.length === 1 ? "" : "s"}: ${schemaTypes.slice(0, 5).join(", ")}.`
        : "No valid Schema.org JSON-LD or microdata type was detected in the static HTML.",
      "Add accurate Schema.org JSON-LD or microdata where a supported type describes the visible page content.",
      pageUrl,
    ),
  ];
  const contentFindings = [
    makeFinding(
      "geo-substantive-content-volume",
      "Substantive visible text volume",
      wordCount >= 200 ? "pass" : "warn",
      "medium",
      `The static text extraction found approximately ${wordCount} words.`,
      "Ensure the page contains enough original, useful text to answer its intended audience's questions.",
      pageUrl,
    ),
    makeFinding(
      "geo-semantic-content-container",
      "Semantic main-content container",
      hasSemanticContainer ? "pass" : "warn",
      "low",
      hasSemanticContainer
        ? "A main or article element was found in the static HTML."
        : `No main/article element was found; ${paragraphs.length} paragraph${paragraphs.length === 1 ? "" : "s"} were detected.`,
      "Use a main or article landmark around the primary page content where appropriate.",
      pageUrl,
    ),
  ];

  const categories = [
    category("geo-citability", "GEO — Citability signals", citabilityFindings),
    category("geo-schema", "GEO — Structured data", schemaFindings),
    category("geo-content-quality", "GEO — Content structure", contentFindings),
  ];

  return {
    categories,
    scores: {
      citability: categories[0].score ?? 0,
      schema: categories[1].score ?? 0,
      contentQuality: categories[2].score ?? 0,
    },
  };
}

function category(id: string, name: string, findings: AuditFinding[]): AuditCategory {
  return { id, name, score: scoreFindings(findings), findings };
}

function makeFinding(
  id: string,
  title: string,
  status: AuditFindingStatus,
  severity: AuditFinding["severity"],
  evidence: string,
  recommendation: string,
  pageUrl: string,
): AuditFinding {
  return { id, title, status, severity, evidence, recommendation, pageUrl, docsUrl: null };
}

function scoreFindings(findings: AuditFinding[]): number | null {
  const assessed = findings.filter((finding) => finding.status !== "skipped");
  if (assessed.length === 0) return null;
  const points = assessed.reduce((sum, finding) => sum + (finding.status === "pass" ? 1 : finding.status === "warn" ? 0.5 : 0), 0);
  return Math.round(points * 100 / assessed.length);
}

function findSchemaTypes(html: string): string[] {
  const types = new Set<string>();
  for (const match of html.matchAll(/<script\b([^>]*)>([\s\S]*?)<\/script\s*>/gi)) {
    const typeAttribute = /\btype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/i.exec(match[1]);
    const type = (typeAttribute?.[1] ?? typeAttribute?.[2] ?? typeAttribute?.[3] ?? "").trim().toLowerCase();
    if (type !== "application/ld+json") continue;
    try {
      collectSchemaTypes(JSON.parse(decodeHtmlText(match[2])), types);
    } catch {
      // Invalid JSON-LD is not counted as Schema.org data.
    }
  }

  for (const match of html.matchAll(/\bitemtype\s*=\s*(?:"([^"]*)"|'([^']*)'|([^\s>]+))/gi)) {
    const itemType = match[1] ?? match[2] ?? match[3] ?? "";
    collectSchemaTypeUrl(itemType, types);
  }
  return [...types].sort();
}

function collectSchemaTypes(value: unknown, types: Set<string>, inheritedSchemaContext = false): void {
  if (Array.isArray(value)) {
    for (const item of value) collectSchemaTypes(item, types, inheritedSchemaContext);
    return;
  }
  if (typeof value !== "object" || value === null) return;
  const record = value as Record<string, unknown>;
  const context = record["@context"];
  const contextIsSchema = inheritedSchemaContext || (typeof context === "string"
    ? /schema\.org/i.test(context)
    : Array.isArray(context)
      ? context.some((item) => typeof item === "string" && /schema\.org/i.test(item))
      : typeof context === "object" && context !== null && Object.values(context as Record<string, unknown>).some((item) => typeof item === "string" && /schema\.org/i.test(item)));
  const rawType = record["@type"];
  if (contextIsSchema && typeof rawType === "string") types.add(rawType);
  if (contextIsSchema && Array.isArray(rawType)) {
    for (const item of rawType) if (typeof item === "string") types.add(item);
  }
  for (const nested of Object.values(record)) collectSchemaTypes(nested, types, contextIsSchema);
}

function collectSchemaTypeUrl(value: string, types: Set<string>): void {
  if (!/schema\.org\//i.test(value)) return;
  const type = value.trim().split(/[\/#]/).filter(Boolean).pop();
  if (type) types.add(type);
}

function stripText(value: string): string {
  return decodeHtmlText(value.replace(/<[^>]*>/g, " ")).replace(/\s+/g, " ").trim();
}

function decodeHtmlText(value: string): string {
  return value
    .replace(/&amp;/gi, "&")
    .replace(/&lt;/gi, "<")
    .replace(/&gt;/gi, ">")
    .replace(/&quot;/gi, '"')
    .replace(/&#39;|&apos;/gi, "'");
}
