import type { AuditFinding, KaseobotAuditResult } from "../audits/types";

export interface FilteredKimiFinding {
  category: string;
  id: string;
  title: string;
  severity: string;
  status: "fail" | "warn";
  evidence: string;
  recommendation: string;
}

export interface FilteredKimiAuditInput {
  auditType: string;
  overallScore: number | null;
  summary: KaseobotAuditResult["summary"];
  categories: Array<{ id: string; name: string; score: number | null }>;
  findings: FilteredKimiFinding[];
  findingsTruncated: boolean;
  geo?: KaseobotAuditResult["geo"];
}

const MAX_FINDINGS = 25;
const MAX_EVIDENCE_LENGTH = 300;
const MAX_RECOMMENDATION_LENGTH = 300;

export function buildFilteredAuditInput(
  audit: KaseobotAuditResult,
  maxFindings = MAX_FINDINGS,
  maxEvidenceLength = MAX_EVIDENCE_LENGTH,
): FilteredKimiAuditInput {
  const findingLimit = Number.isSafeInteger(maxFindings) && maxFindings > 0
    ? Math.min(maxFindings, MAX_FINDINGS)
    : MAX_FINDINGS;
  const evidenceLimit = Number.isSafeInteger(maxEvidenceLength) && maxEvidenceLength > 0
    ? Math.min(maxEvidenceLength, MAX_EVIDENCE_LENGTH)
    : MAX_EVIDENCE_LENGTH;
  const eligible = audit.categories.flatMap((category) => category.findings
    .filter(isActionableFinding)
    .map((finding) => ({ category: category.name, finding })));

  const severityRank: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3, info: 4 };
  const prioritized = [...eligible].sort((left, right) => {
    const statusRank = (status: string) => status === "fail" ? 0 : 1;
    return statusRank(left.finding.status) - statusRank(right.finding.status)
      || (severityRank[left.finding.severity] ?? 5) - (severityRank[right.finding.severity] ?? 5);
  });
  const findings = prioritized.slice(0, findingLimit).map(({ category, finding }) => ({
    category: truncate(category, 100),
    id: truncate(finding.id, 120),
    title: truncate(finding.title, 200),
    severity: finding.severity,
    status: finding.status,
    evidence: truncate(finding.evidence, evidenceLimit),
    recommendation: truncate(finding.recommendation, Math.min(evidenceLimit, MAX_RECOMMENDATION_LENGTH)),
  }));

  return {
    auditType: audit.type,
    overallScore: audit.overallScore,
    summary: { ...audit.summary },
    categories: audit.categories.map((category) => ({
      id: truncate(category.id, 120),
      name: truncate(category.name, 100),
      score: category.score,
    })),
    findings,
    findingsTruncated: eligible.length > findings.length,
    ...(audit.geo ? { geo: { ...audit.geo, scores: { ...audit.geo.scores } } } : {}),
  };
}

function isActionableFinding(finding: AuditFinding): finding is AuditFinding & { status: "fail" | "warn" } {
  return finding.status === "fail" || finding.status === "warn";
}

function truncate(value: string, maximum: number): string {
  const compact = value.replace(/[\r\n\t]+/g, " ").replace(/\s{2,}/g, " ").trim();
  return compact.length > maximum ? `${compact.slice(0, maximum - 1)}…` : compact;
}
