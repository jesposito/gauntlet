import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { basename, join } from "node:path";
import { buildPersonaReport, listPersonasInRun } from "./generator.ts";
import { rollUp } from "./rollup.ts";
import { renderRunReport } from "./render-markdown.ts";
import { vetAll } from "./vetter.ts";
import { nullEmitter, type EventEmitter } from "../events.ts";
import type { PersonaReport, RunReport } from "./schema.ts";

export interface BuildReportOptions {
  runDir: string;
  vet?: boolean;
  vetHeadless?: boolean;
  /**
   * Per-finding wallclock budget (ms) forwarded to vetAll's perFindingBudgetMs.
   * Undefined = let vetAll use its built-in default. Set via the `--vet-timeout`
   * CLI flag for heavy SPAs whose axe scan needs more (or less) than 60s.
   */
  vetTimeoutMs?: number;
  /**
   * Optional event emitter forwarded to the vetter so the report-build phase
   * narrates itself in real time. Defaults to nullEmitter (silent), so
   * existing call sites keep working unchanged.
   */
  emit?: EventEmitter;
}

export interface BuildReportResult {
  runDir: string;
  markdownPath: string;
  jsonPath: string;
  report: RunReport;
}

async function inferRunMeta(runDir: string, personaReports: PersonaReport[]): Promise<{
  url: string;
  startedAt: number;
  finishedAt: number;
}> {
  let url = "";
  let startedAt = Number.POSITIVE_INFINITY;
  let finishedAt = 0;
  for (const pr of personaReports) {
    for (const f of pr.findings) {
      if (!url) url = f.url;
    }
    for (const f of pr.flows) {
      const flowDir = join(runDir, pr.personaId, f.flowId);
      try {
        const fr = JSON.parse(await readFile(join(flowDir, "flow-result.json"), "utf8"));
        if (typeof fr.startedAt === "number") startedAt = Math.min(startedAt, fr.startedAt);
        if (typeof fr.finishedAt === "number") finishedAt = Math.max(finishedAt, fr.finishedAt);
        if (!url && typeof fr.url === "string") url = fr.url;
      } catch {
        /* skip */
      }
    }
    // Legacy single-step runs (browser.ts runPersona) write no flow-result.json
    // — only meta.json directly under the persona dir. Without this fallback
    // url/startedAt/finishedAt stay empty and REPORT.md shows a blank "- URL:".
    try {
      const meta = JSON.parse(await readFile(join(runDir, pr.personaId, "meta.json"), "utf8"));
      if (typeof meta.startedAt === "number") startedAt = Math.min(startedAt, meta.startedAt);
      if (typeof meta.finishedAt === "number") finishedAt = Math.max(finishedAt, meta.finishedAt);
      if (!url && typeof meta.url === "string") url = meta.url;
    } catch {
      /* not a legacy run, or no meta.json */
    }
  }
  if (!isFinite(startedAt)) startedAt = Date.now();
  if (finishedAt === 0) finishedAt = startedAt;
  return { url, startedAt, finishedAt };
}

export async function buildReport(opts: BuildReportOptions): Promise<BuildReportResult> {
  const personaIds = await listPersonasInRun(opts.runDir);
  const personaReports: PersonaReport[] = [];
  for (const id of personaIds) {
    personaReports.push(await buildPersonaReport(opts.runDir, id));
  }

  if (opts.vet !== false) {
    const emit = opts.emit ?? nullEmitter;
    for (const pr of personaReports) {
      pr.findings = await vetAll(pr.findings, {
        headless: opts.vetHeadless ?? true,
        ...(opts.vetTimeoutMs !== undefined ? { perFindingBudgetMs: opts.vetTimeoutMs } : {}),
        emit,
      });
    }
  }

  const totals = { findings: 0, verified: 0, subjective: 0, couldNotReplay: 0, regressed: 0, unverified: 0 };
  for (const pr of personaReports) {
    for (const f of pr.findings) {
      totals.findings += 1;
      switch (f.vetting.status) {
        case "verified":
          totals.verified += 1;
          break;
        case "subjective":
          totals.subjective += 1;
          break;
        case "could_not_replay":
          totals.couldNotReplay += 1;
          break;
        case "regressed":
          totals.regressed += 1;
          break;
        case "unverified":
          totals.unverified += 1;
          break;
      }
    }
  }

  const meta = await inferRunMeta(opts.runDir, personaReports);
  const patterns = rollUp(personaReports);

  const report: RunReport = {
    runId: basename(opts.runDir),
    runDir: opts.runDir,
    url: meta.url,
    startedAt: meta.startedAt,
    finishedAt: meta.finishedAt,
    personas: personaReports,
    patterns,
    totals,
  };

  const markdownPath = join(opts.runDir, "REPORT.md");
  const jsonPath = join(opts.runDir, "report.json");
  await writeFile(markdownPath, renderRunReport(report), "utf8");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");

  return { runDir: opts.runDir, markdownPath, jsonPath, report };
}

export async function findLatestRunDir(cwd: string = process.cwd()): Promise<string | undefined> {
  const runsDir = join(cwd, ".gauntlet", "runs");
  try {
    const entries = await readdir(runsDir);
    const dated: { name: string; mtime: number }[] = [];
    for (const e of entries) {
      const st = await stat(join(runsDir, e)).catch(() => undefined);
      if (st?.isDirectory()) dated.push({ name: e, mtime: st.mtimeMs });
    }
    dated.sort((a, b) => b.mtime - a.mtime);
    if (dated.length === 0) return undefined;
    return join(runsDir, dated[0]!.name);
  } catch {
    return undefined;
  }
}
