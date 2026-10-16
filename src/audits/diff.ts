import type { AuditCategory, AuditFinding, KaseobotAuditResult } from "./types";

export interface DiffChange {
  category: string;
  categoryId: string;
  finding: string;
  from: string | null;
  to: string | null;
  statusChanged: boolean;
}

export function diffAudits(previous: KaseobotAuditResult | null, current: KaseobotAuditResult): DiffChange[] {
  if (!previous) return [];

  const byId = new Map<string, AuditFinding>();
  for (const category of previous.categories) {
    for (const finding of category.findings) {
      byId.set(`${category.id}::${finding.id}`, finding);
    }
  }

  const changes: DiffChange[] = [];
  for (const category of current.categories) {
    for (const finding of category.findings) {
      const key = `${category.id}::${finding.id}`;
      const before = byId.get(key);
      if (!before) continue; // new finding (not part of same-site regression on static checks)

      if (before.status !== finding.status) {
        changes.push({
          category: category.name,
          categoryId: category.id,
          finding: finding.title,
          from: before.status,
          to: finding.status,
          statusChanged: true,
        });
      } else if (before.evidence !== finding.evidence) {
        changes.push({
          category: category.name,
          categoryId: category.id,
          finding: finding.title,
          from: before.evidence.slice(0, 120),
          to: finding.evidence.slice(0, 120),
          statusChanged: false,
        });
      }
    }
  }

  // Sort: status flips first, then evidence changes
  changes.sort((a, b) => Number(b.statusChanged) - Number(a.statusChanged) || a.finding.localeCompare(b.finding));
  return changes.slice(0, 8);
}

export function formatDiff(changes: DiffChange[]): string {
  if (changes.length === 0) return "No changed checks since your last audit of this site.";
  const lines = ["Checks that changed since your last audit of this site:"];
  for (const change of changes) {
    const arrow = change.statusChanged
      ? `${change.from ?? "skipped"} → ${change.to ?? "skipped"}`
      : `evidence updated`;
    lines.push(`- ${change.category} · ${change.finding}: ${arrow}`);
  }
  return lines.join("\n");
}
