import type { AuditCategory, AuditFinding, KaseobotAuditResult } from "./types";

const MAX_REPORT_LENGTH = 3_600;
const MAX_REPORTED_FINDINGS = 8;

interface ReportIssue {
  category: AuditCategory;
  finding: AuditFinding;
  index: number;
}

export function buildFallbackReport(audit: KaseobotAuditResult): string {
  const issues: ReportIssue[] = audit.categories
    .flatMap((category) => category.findings.map((finding) => ({ category, finding })))
    .filter(({ finding }) => finding.status === "fail" || finding.status === "warn")
    .sort((left, right) => {
      const statusRank = (finding: AuditFinding) => finding.status === "fail" ? 0 : 1;
      const severityRank: Record<AuditFinding["severity"], number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
      return statusRank(left.finding) - statusRank(right.finding)
        || severityRank[left.finding.severity] - severityRank[right.finding.severity]
        || 0;
    })
    .map((issue, index) => ({ ...issue, index }));

  const isGeo = audit.type === "geo_audit";
  const lines = [
    `Kaseobot ${isGeo ? "GEO" : "SEO"} audit`,
    `Website: ${truncate(audit.url, 420)}`,
  ];
  if (isGeo) {
    lines.push(
      `Pages: ${audit.geo?.pagesRequested ?? 0} requested, ${audit.geo?.pagesAudited ?? 0} audited, ${audit.geo?.pagesFailed ?? 0} failed.`,
      `GEO scores: Citability ${formatScore(audit.geo?.scores.citability)}, Crawler access ${formatScore(audit.geo?.scores.crawlerAccess)}, Schema ${formatScore(audit.geo?.scores.schema)}, Content structure ${formatScore(audit.geo?.scores.contentQuality)}.`,
    );
  }
  lines.push(
    `Overall score: ${audit.overallScore === null ? "not available" : `${audit.overallScore}/100`}`,
    `Checks: ${audit.summary.passed} passed, ${audit.summary.warnings} warnings, ${audit.summary.failed} failed, ${audit.summary.skipped} skipped.`,
    "",
  );

  const sections = isGeo
    ? [
        { title: "SEO findings:", items: issues.filter((issue) => !issue.category.id.startsWith("geo-")) },
        { title: "GEO findings:", items: issues.filter((issue) => issue.category.id.startsWith("geo-")) },
      ]
    : [{ title: "Findings:", items: issues }];

  let included = 0;
  for (const section of sections) {
    lines.push(section.title);
    if (section.items.length === 0) {
      lines.push(isGeo ? "No warning or failed findings were returned in this section." : "No warning or failed findings were returned by the static checks.", "");
      continue;
    }

    for (const { category, finding } of section.items) {
      if (included >= MAX_REPORTED_FINDINGS) break;
      const block = [
        `${finding.status.toUpperCase()} — ${truncate(category.name, 80)} — ${truncate(finding.title, 140)}`,
        `Page: ${truncate(finding.pageUrl, 220)}`,
        `Evidence: ${truncate(finding.evidence, 220)}`,
        `Recommendation: ${truncate(finding.recommendation, 220)}`,
      ];
      const candidate = [...lines, ...block, ""].join("\n");
      if (candidate.length > MAX_REPORT_LENGTH) break;
      lines.push(...block, "");
      included += 1;
    }
  }

  if (issues.length > included) lines.push("Additional findings are in the stored audit result.");
  lines.push(`Audit ID: ${audit.auditId}`);
  let report = lines.join("\n").trim();
  if (report.length > MAX_REPORT_LENGTH) report = `${report.slice(0, MAX_REPORT_LENGTH - 1).trimEnd()}…`;
  return report;
}

function formatScore(value: number | null | undefined): string {
  return value === null || value === undefined ? "not measured" : `${value}/100`;
}

function truncate(value: string, maximum: number): string {
  const compact = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}
