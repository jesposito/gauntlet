import type { Finding, RunReport } from "./schema.ts";

const SEVERITY_ORDER: Record<Finding["severity"], number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

const SEVERITY_BADGE: Record<Finding["severity"], string> = {
  critical: "CRITICAL",
  serious: "serious",
  moderate: "moderate",
  minor: "minor",
};

const VETTING_BADGE: Record<Finding["vetting"]["status"], string> = {
  verified: "VERIFIED",
  unverified: "unverified",
  subjective: "subjective",
  could_not_replay: "could-not-replay",
  regressed: "regressed (replay did not re-hit; likely stale)",
};

// Make the persona-abandonment classification visible in the report so a
// reader can tell at a glance whether a finding is a real defect, polish
// work, product-backlog signal, or noise. Bug = engineering defect;
// confusing_ux = polish; feature_gap = product; not_a_bug = noise (already
// down-severity'd by the generator).
const CATEGORY_BADGE: Record<NonNullable<Finding["category"]>, string> = {
  bug: "BUG",
  confusing_ux: "confusing-ux",
  feature_gap: "feature-gap",
  not_a_bug: "not-a-bug",
};

function sortFindings(findings: Finding[]): Finding[] {
  return [...findings].sort((a, b) => {
    const s = SEVERITY_ORDER[a.severity] - SEVERITY_ORDER[b.severity];
    if (s !== 0) return s;
    return a.title.localeCompare(b.title);
  });
}

function renderFinding(f: Finding): string {
  const lines: string[] = [];
  const categoryBadge = f.category ? ` [${CATEGORY_BADGE[f.category]}]` : "";
  lines.push(`#### \`${f.id}\` [${SEVERITY_BADGE[f.severity]}] [${VETTING_BADGE[f.vetting.status]}]${categoryBadge} ${f.title}`);
  lines.push("");
  lines.push(`- URL: ${f.url}`);
  if (f.flowId) lines.push(`- Flow: \`${f.flowId}\`${f.stepIndex !== undefined ? ` step ${f.stepIndex + 1}` : ""}`);
  lines.push(`- Reason: \`${f.reason}\``);
  if (f.axeRuleId) lines.push(`- axe rule: \`${f.axeRuleId}\`${f.helpUrl ? ` ([help](${f.helpUrl}))` : ""}`);
  lines.push(`- Replay: \`${f.replayStrategy}\``);
  if (f.vetting.note) lines.push(`- Vetting: ${f.vetting.note}`);
  lines.push("");
  lines.push(`> ${f.detail.replace(/\n/g, " ")}`);
  const artLines: string[] = [];
  if (f.artifacts.screenshot) artLines.push(`screenshot \`${f.artifacts.screenshot}\``);
  if (f.artifacts.axeJson) artLines.push(`axe \`${f.artifacts.axeJson}\``);
  if (f.artifacts.domHtml) artLines.push(`dom \`${f.artifacts.domHtml}\``);
  if (f.artifacts.axTree) artLines.push(`ax-tree \`${f.artifacts.axTree}\``);
  if (f.artifacts.flowResult) artLines.push(`flow-result \`${f.artifacts.flowResult}\``);
  if (f.artifacts.video) artLines.push(`video \`${f.artifacts.video}\``);
  if (artLines.length > 0) {
    lines.push("");
    lines.push(`Artifacts: ${artLines.join(", ")}.`);
  }
  return lines.join("\n");
}

export function renderRunReport(report: RunReport): string {
  const startedIso = new Date(report.startedAt).toISOString();
  const durationS = Math.round((report.finishedAt - report.startedAt) / 1000);
  const sections: string[] = [];

  sections.push(`# Gauntlet run report`);
  sections.push("");
  sections.push(`- Run: \`${report.runId}\``);
  sections.push(`- URL: ${report.url}`);
  sections.push(`- Started: ${startedIso}`);
  sections.push(`- Duration: ${durationS}s`);
  sections.push(`- Personas: ${report.personas.length}`);
  sections.push("");

  const t = report.totals;
  sections.push(`## Totals`);
  sections.push("");
  sections.push(`| Metric | Count |`);
  sections.push(`|---|---|`);
  sections.push(`| Findings | ${t.findings} |`);
  sections.push(`| Verified by replay | ${t.verified} |`);
  sections.push(`| Subjective (flagged for human triage) | ${t.subjective} |`);
  sections.push(`| Regressed (replay did not re-hit; likely stale) | ${t.regressed} |`);
  sections.push(`| Could not replay | ${t.couldNotReplay} |`);
  sections.push(`| Unverified | ${t.unverified} |`);
  sections.push("");

  if (report.patterns.length > 0) {
    sections.push(`## Cross-persona patterns`);
    sections.push("");
    sections.push(`Findings seen by multiple personas — high signal.`);
    sections.push("");
    sections.push(`| Signature | Personas | Title |`);
    sections.push(`|---|---|---|`);
    for (const p of report.patterns) {
      sections.push(`| \`${p.signature}\` | ${p.count} (${p.personas.join(", ")}) | ${p.title} |`);
    }
    sections.push("");
  }

  for (const pr of report.personas) {
    sections.push(`## ${pr.personaName} (\`${pr.personaId}\`)`);
    sections.push("");
    if (pr.flows.length > 0) {
      sections.push(`Flows:`);
      sections.push("");
      sections.push(`| Flow | Outcome | Steps | Duration |`);
      sections.push(`|---|---|---|---|`);
      for (const f of pr.flows) {
        const reason = f.outcomeReason ? ` (${f.outcomeReason.slice(0, 80)})` : "";
        sections.push(`| \`${f.flowId}\` | ${f.outcome}${reason} | ${f.steps} | ${Math.round(f.durationMs / 1000)}s |`);
      }
      sections.push("");
    }
    const sorted = sortFindings(pr.findings);
    if (sorted.length === 0) {
      sections.push(`No findings.`);
      sections.push("");
      continue;
    }
    sections.push(`### Findings (${sorted.length})`);
    sections.push("");
    for (const f of sorted) {
      sections.push(renderFinding(f));
      sections.push("");
    }
  }

  sections.push(`---`);
  sections.push("");
  sections.push(
    `Vetting layer: every finding is replayed before this report ships. \`VERIFIED\` means the replay re-hit the same condition. \`regressed\` means the replay did not re-hit — likely flaky or stale. \`subjective\` means the replay strategy cannot deterministically verify this category (yet) and the finding is flagged for human triage.`,
  );

  return sections.join("\n");
}
