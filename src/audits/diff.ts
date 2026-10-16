import type {
  AuditCategory,
  AuditFinding,
  AuditFindingStatus,
  KaseobotAuditResult,
} from "./types";

export interface CategoryDelta {
  categoryId: string;
  categoryName: string;
  previousScore: number | null;
  currentScore: number | null;
  scoreChange: number | null;
}

export interface FindingDelta {
  categoryId: string;
  categoryName: string;
  findingId: string;
  findingTitle: string;
  previousStatus: AuditFindingStatus | null;
  currentStatus: AuditFindingStatus;
  pageUrl: string;
}

export interface AuditDiff {
  categories: CategoryDelta[];
  findings: FindingDelta[];
  hasChanges: boolean;
}

function findCategory(
  categories: AuditCategory[],
  id: string,
): AuditCategory | undefined {
  return categories.find((category) => category.id === id);
}

function findFinding(
  findings: AuditFinding[],
  id: string,
): AuditFinding | undefined {
  return findings.find((finding) => finding.id === id);
}

export function compareAuditToPrevious(
  current: KaseobotAuditResult,
  previous: KaseobotAuditResult | null,
): AuditDiff {
  const categories: CategoryDelta[] = [];
  const findings: FindingDelta[] = [];

  for (const currentCategory of current.categories) {
    const previousCategory = previous
      ? findCategory(previous.categories, currentCategory.id)
      : undefined;
    const previousScore = previousCategory?.score ?? null;
    const currentScore = currentCategory.score ?? null;
    let scoreChange: number | null = null;
    if (previousScore !== null && currentScore !== null) {
      scoreChange = currentScore - previousScore;
    }
    categories.push({
      categoryId: currentCategory.id,
      categoryName: currentCategory.name,
      previousScore,
      currentScore,
      scoreChange,
    });

    for (const currentFinding of currentCategory.findings) {
      const previousFinding = previousCategory
        ? findFinding(previousCategory.findings, currentFinding.id)
        : undefined;
      const previousStatus = previousFinding?.status ?? null;
      if (previousStatus !== currentFinding.status) {
        findings.push({
          categoryId: currentCategory.id,
          categoryName: currentCategory.name,
          findingId: currentFinding.id,
          findingTitle: currentFinding.title,
          previousStatus,
          currentStatus: currentFinding.status,
          pageUrl: currentFinding.pageUrl,
        });
      }
    }
  }

  return {
    categories,
    findings,
    hasChanges:
      categories.some((delta) => delta.scoreChange !== null) ||
      findings.length > 0,
  };
}

export function formatDiffSummary(diff: AuditDiff): string {
  const lines: string[] = ["Changes since last audit:"];

  for (const delta of diff.categories) {
    if (delta.scoreChange === null) continue;
    const direction =
      delta.scoreChange > 0 ? "improved" : delta.scoreChange < 0 ? "dropped" : "unchanged";
    lines.push(
      `- ${delta.categoryName} score: ${delta.previousScore ?? "not measured"} → ${delta.currentScore ?? "not measured"} (${direction}, ${Math.abs(delta.scoreChange)} points)`,
    );
  }

  for (const finding of diff.findings.slice(0, 5)) {
    const previous =
      finding.previousStatus === null
        ? "not measured"
        : finding.previousStatus;
    lines.push(
      `- ${finding.findingTitle} (${finding.categoryName}): ${previous} → ${finding.currentStatus}`,
    );
  }

  if (!diff.hasChanges) {
    lines.push("No measured change since your last audit of this site.");
  }

  return lines.join("\n");
}
