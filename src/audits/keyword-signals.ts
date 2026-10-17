import type { KaseobotAuditResult } from "./types";

interface KeywordSignals {
  title: string | null;
  titleLength: number | null;
  h1Count: number | null;
  metaDescriptionLength: number | null;
  canonical: string | null;
  lang: string | null;
  https: boolean | null;
  headingLevels: number[];
}

function firstNumber(text: string | null | undefined): number | null {
  if (!text) return null;
  const match = /\d+/.exec(text);
  return match ? Number(match[0]) : null;
}

function extractBetween(text: string | null | undefined, open: string, close: string): string | null {
  if (!text) return null;
  const start = text.indexOf(open);
  if (start === -1) return null;
  const after = text.slice(start + open.length);
  const end = after.indexOf(close);
  if (end === -1) return null;
  const value = after.slice(0, end).trim();
  return value.length > 0 ? value : null;
}

export function buildKeywordSignals(audit: KaseobotAuditResult): KeywordSignals {
  const signals: KeywordSignals = {
    title: null,
    titleLength: null,
    h1Count: null,
    metaDescriptionLength: null,
    canonical: null,
    lang: null,
    https: null,
    headingLevels: [],
  };

  for (const category of audit.categories) {
    for (const finding of category.findings) {
      const evidence = finding.evidence ?? "";
      switch (finding.id) {
        case "title-present": {
          signals.title = extractBetween(evidence, "“", "”");
          signals.titleLength = firstNumber(/characters?/.test(evidence) ? evidence.match(/\((\d+) characters?\)/)?.at(1) ?? null : null) ?? signals.title?.length ?? null;
          break;
        }
        case "h1-presence-and-count": {
          signals.h1Count = firstNumber(evidence.match(/^Found (\d+) H1/)?.at(1) ?? null);
          break;
        }
        case "meta-description-present": {
          signals.metaDescriptionLength = firstNumber((evidence.match(/\\((\\d+) characters?\\)/) ?? [null, null])[1]);
          break;
        }
        case "canonical-link-present": {
          signals.canonical = extractBetween(evidence, "points to ", ".");
          break;
        }
        case "html-lang-attribute": {
          signals.lang = extractBetween(evidence, 'lang="', '"');
          break;
        }
        case "https-enforcement": {
          signals.https = evidence.toLowerCase().includes("https");
          break;
        }
        case "heading-hierarchy": {
          const levels = [...evidence.matchAll(/H([1-6])/g)].map((m) => Number(m[1]));
          if (levels.length > 0) signals.headingLevels = levels;
          break;
        }
      }
    }
  }

  return signals;
}

export function buildKeywordSummary(audit: KaseobotAuditResult): string {
  const s = buildKeywordSignals(audit);
  const lines: string[] = [
    `kaseomator keyword signals`,
    `Website: ${audit.url}`,
    `Overall score: ${audit.overallScore === null ? "not available" : `${audit.overallScore}/100`}`,
    "",
  ];

  if (s.title) {
    lines.push(`Title: ${s.title}`);
    if (s.titleLength) lines.push(`Title length: ${s.titleLength} characters`);
  } else {
    lines.push(`Title: missing`);
  }

  if (s.h1Count === null) {
    lines.push(`H1: not measured`);
  } else if (s.h1Count === 0) {
    lines.push(`H1: missing (add one descriptive H1 heading)`);
  } else if (s.h1Count === 1) {
    lines.push(`H1: present (one heading)`);
  } else {
    lines.push(`H1: multiple (${s.h1Count} headings — consolidate to one)`);
  }

  if (s.metaDescriptionLength === null) {
    lines.push(`Meta description: missing`);
  } else if (s.metaDescriptionLength === 0) {
    lines.push(`Meta description: empty`);
  } else {
    lines.push(`Meta description: ${s.metaDescriptionLength} characters`);
  }

  lines.push(
    s.canonical ? `Canonical: ${s.canonical}` : `Canonical: missing`,
    s.lang ? `Language: ${s.lang}` : `Language: not declared`,
    s.https === true ? `HTTPS: yes` : s.https === false ? `HTTPS: no (serve over HTTPS)` : `HTTPS: not measured`,
  );

  if (s.headingLevels.length > 0) {
    lines.push(`Heading structure: H${s.headingLevels.join(", H")}`);
  }

  lines.push(
    "",
    "These signals are measured from the page's static HTML. Use them to refine page titles, headings, and meta descriptions for search visibility.",
  );

  return lines.join("\n");
}
