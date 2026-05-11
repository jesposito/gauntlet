/**
 * Render a run report into a GitHub PR comment body. Compact: top findings,
 * persona quotes, links to artifacts. Designed to fit in a single PR comment
 * (~3KB) without scrolling for the reviewer.
 *
 * Public output is markdown. We deliberately do NOT inline screenshots
 * here — gauntlet has no public artifact host yet, so we link by relative
 * path that the consumer can resolve against a hosting URL (gh-pages,
 * S3, etc) if they want. See `--artifact-base` flag.
 */
import type { Finding, RunReport, Severity } from "../report/schema.ts";

export interface RenderCommentOptions {
  report: RunReport;
  artifactBase?: string; // prepended to relative artifact paths to make links work
  maxFindings?: number; // default 5
  surfaceId?: string;
  surfaceName?: string;
  prNumber?: number;
  runUrl?: string;
}

const SEVERITY_RANK: Record<Severity, number> = {
  critical: 0,
  serious: 1,
  moderate: 2,
  minor: 3,
};

const SEVERITY_LABEL: Record<Severity, string> = {
  critical: "🟥 CRITICAL",
  serious: "🟧 SERIOUS",
  moderate: "🟨 moderate",
  minor: "⬜ minor",
};

function pickTopFindings(report: RunReport, max: number): Finding[] {
  const all: Finding[] = [];
  for (const p of report.personas) all.push(...p.findings);
  return all
    .sort((a, b) => SEVERITY_RANK[a.severity] - SEVERITY_RANK[b.severity])
    .slice(0, max);
}

function personaQuote(report: RunReport, finding: Finding): string | undefined {
  const persona = report.personas.find((p) => p.personaId === finding.personaId);
  if (!persona) return undefined;
  return persona.personaName;
}

function artifactLink(base: string | undefined, relative: string | undefined): string | undefined {
  if (!relative) return undefined;
  if (!base) return undefined;
  const cleanBase = base.replace(/\/$/, "");
  const cleanRel = relative.replace(/^\//, "");
  return `${cleanBase}/${cleanRel}`;
}

export function renderPrComment(opts: RenderCommentOptions): string {
  const max = opts.maxFindings ?? 5;
  const top = pickTopFindings(opts.report, max);
  const totals = opts.report.totals;
  const persona = (id: string): string =>
    opts.report.personas.find((p) => p.personaId === id)?.personaName ?? id;

  const surfaceLine = opts.surfaceId
    ? ` on **${opts.surfaceName ?? opts.surfaceId}**`
    : "";

  const lines: string[] = [];
  lines.push(`### 🎯 Gauntlet${surfaceLine}: ${totals.findings} finding${totals.findings === 1 ? "" : "s"}`);
  lines.push("");

  if (totals.findings === 0) {
    lines.push(`No findings on this run. Personas: ${opts.report.personas.map((p) => p.personaName).join(", ")}.`);
    lines.push("");
    return lines.join("\n");
  }

  // Per-persona outcome roll-up (so reviewers see who abandoned where).
  lines.push(`**Personas run:**`);
  for (const p of opts.report.personas) {
    const flowSummary = p.flows
      .map((f) => `${f.flowId.split("--")[1] ?? f.flowId}=${f.outcome}`)
      .join(", ");
    lines.push(`- **${p.personaName}** — ${flowSummary || "no flows"}`);
  }
  lines.push("");

  // Top findings table.
  lines.push(`**Top ${top.length} findings:**`);
  lines.push("");
  lines.push(`| Severity | What | Where | Who saw it |`);
  lines.push(`|---|---|---|---|`);
  for (const f of top) {
    const sev = SEVERITY_LABEL[f.severity];
    const what = f.title.replace(/\|/g, "\\|").slice(0, 100);
    let where = "";
    try {
      where = `\`${new URL(f.url).pathname || "/"}\``;
    } catch {
      where = `\`${f.url}\``;
    }
    const screenshotUrl = artifactLink(opts.artifactBase, f.artifacts.screenshot);
    const whereCell = screenshotUrl ? `${where} · [screenshot](${screenshotUrl})` : where;
    const who = persona(f.personaId);
    lines.push(`| ${sev} | ${what} | ${whereCell} | ${who} |`);
  }
  lines.push("");

  // Persona abandons get a callout — these are the unique "gauntlet" findings.
  const abandons = top.filter((f) => f.reason === "abandoned_by_persona");
  if (abandons.length > 0) {
    lines.push(`**Persona quit at:**`);
    for (const f of abandons.slice(0, 3)) {
      lines.push(`- _${personaQuote(opts.report, f) ?? f.personaId}_: ${f.title.replace(/^Persona abandoned:\s*/i, "")}`);
    }
    lines.push("");
  }

  // Footer.
  if (totals.findings > top.length) {
    lines.push(`+ ${totals.findings - top.length} more finding${totals.findings - top.length === 1 ? "" : "s"} not shown.`);
  }
  if (opts.runUrl) {
    lines.push(`[full report](${opts.runUrl}) · driven by [gauntlet](https://github.com/jesposito/gauntlet)`);
  } else {
    lines.push(`driven by [gauntlet](https://github.com/jesposito/gauntlet)`);
  }
  return lines.join("\n");
}
