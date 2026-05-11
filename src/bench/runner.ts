/**
 * WebVoyager-style benchmark harness. Loop over a fixed list of public
 * SaaS landing pages and produce a single aggregate report. Used to:
 *   - track Gauntlet's bug-finding capacity over time (regression alarm)
 *   - generate a public leaderboard / README badge ("Gauntlet found X bugs
 *     across N landing pages on YYYY-MM-DD")
 *
 * Each site gets its own scratch `.gauntlet/` under `cwd/bench-tmp/<name>/`,
 * so the bench doesn't pollute the gauntlet repo's own `.gauntlet/` or any
 * user project's. Re-runnable with cache on for fast comparisons.
 */
import { readFile, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import type { AiProvider } from "../ai/provider.ts";
import { seedProject } from "../init/seed.ts";
import { runFlow } from "../runner/flow-runner.ts";
import { loadFlowsForPersona } from "../flow/loader.ts";
import { loadPersona, listCuratedPersonas } from "../persona/loader.ts";
import { buildReport } from "../report/build.ts";

export interface BenchSite {
  name: string;
  url: string;
}

export interface BenchSitesFile {
  version: number;
  description?: string;
  sites: BenchSite[];
}

export interface BenchSiteResult {
  site: BenchSite;
  status: "ok" | "error";
  errorMessage?: string;
  surfaces: number;
  personas: number;
  flows: number;
  findings: number;
  durationMs: number;
  benchDir: string;
  reportMarkdown?: string;
}

export interface BenchRunResult {
  startedAt: number;
  finishedAt: number;
  sites: BenchSiteResult[];
  totals: {
    sitesOk: number;
    sitesError: number;
    findings: number;
  };
}

export async function loadSitesFile(path: string): Promise<BenchSitesFile> {
  const raw = await readFile(path, "utf8");
  const parsed = JSON.parse(raw) as BenchSitesFile;
  if (!parsed.sites || !Array.isArray(parsed.sites)) {
    throw new Error(`bench sites file at ${path} missing "sites" array`);
  }
  return parsed;
}

export interface RunBenchOptions {
  provider: AiProvider;
  sites: BenchSite[];
  benchRoot: string; // where each site's scratch .gauntlet/ lives
  personasPerSite?: number;
  flowsPerPersona?: number;
  log?: (line: string) => void;
}

const noLog = (): void => undefined;

export async function runBench(opts: RunBenchOptions): Promise<BenchRunResult> {
  const log = opts.log ?? noLog;
  const startedAt = Date.now();
  const results: BenchSiteResult[] = [];

  for (const site of opts.sites) {
    const siteStartedAt = Date.now();
    const benchDir = join(opts.benchRoot, site.name);
    await mkdir(benchDir, { recursive: true });

    log(`\n=== ${site.name} (${site.url}) ===`);
    try {
      // 1. Seed: surfaces + personas + flows.
      const seed = await seedProject({
        cwd: benchDir,
        provider: opts.provider,
        urls: [site.url],
        numPersonas: opts.personasPerSite ?? 2,
        flowsPerPersona: opts.flowsPerPersona ?? 2,
        log: (line) => log(`  ${line}`),
      });

      // 2. Run every persona's flows against the seeded site.
      const ts = new Date().toISOString().replace(/[:.]/g, "-");
      const runDir = join(benchDir, ".gauntlet", "runs", ts);
      await mkdir(runDir, { recursive: true });
      const personaIds = await listCuratedPersonas(benchDir);

      for (const pid of personaIds) {
        const persona = await loadPersona(pid, benchDir);
        const flows = await loadFlowsForPersona(pid, benchDir);
        for (const flow of flows) {
          const flowDir = join(runDir, pid, flow.id);
          try {
            await runFlow({
              url: site.url,
              persona,
              flow,
              provider: opts.provider,
              runDir: flowDir,
              headless: true,
            });
          } catch (err) {
            log(`  [${pid}/${flow.id}] flow crashed: ${err instanceof Error ? err.message : String(err)}`);
          }
        }
      }

      // 3. Build a per-site report (no vet — too slow for bench scale).
      const built = await buildReport({ runDir, vet: false });

      results.push({
        site,
        status: "ok",
        surfaces: seed.surfaces.length,
        personas: seed.personas.length,
        flows: seed.flows.length,
        findings: built.report.totals.findings,
        durationMs: Date.now() - siteStartedAt,
        benchDir,
        reportMarkdown: built.markdownPath,
      });
      log(`  done. surfaces=${seed.surfaces.length} personas=${seed.personas.length} flows=${seed.flows.length} findings=${built.report.totals.findings}`);
    } catch (err) {
      results.push({
        site,
        status: "error",
        errorMessage: err instanceof Error ? err.message : String(err),
        surfaces: 0,
        personas: 0,
        flows: 0,
        findings: 0,
        durationMs: Date.now() - siteStartedAt,
        benchDir,
      });
      log(`  ERROR: ${err instanceof Error ? err.message : String(err)}`);
    }
  }

  const finishedAt = Date.now();
  return {
    startedAt,
    finishedAt,
    sites: results,
    totals: {
      sitesOk: results.filter((r) => r.status === "ok").length,
      sitesError: results.filter((r) => r.status === "error").length,
      findings: results.reduce((n, r) => n + r.findings, 0),
    },
  };
}

export function renderBenchMarkdown(result: BenchRunResult): string {
  const lines: string[] = [];
  const date = new Date(result.startedAt).toISOString().slice(0, 10);
  lines.push(`# Gauntlet benchmark — ${date}`);
  lines.push("");
  lines.push(
    `${result.totals.sitesOk}/${result.totals.sitesOk + result.totals.sitesError} sites OK · **${result.totals.findings} findings** · ${Math.round((result.finishedAt - result.startedAt) / 1000)}s wall clock.`,
  );
  lines.push("");
  lines.push(`| Site | Status | Surfaces | Personas | Flows | Findings | Duration |`);
  lines.push(`|---|---|---:|---:|---:|---:|---:|`);
  for (const r of result.sites) {
    const status = r.status === "ok" ? "ok" : `error: ${r.errorMessage?.slice(0, 50) ?? "?"}`;
    lines.push(
      `| [${r.site.name}](${r.site.url}) | ${status} | ${r.surfaces} | ${r.personas} | ${r.flows} | ${r.findings} | ${(r.durationMs / 1000).toFixed(1)}s |`,
    );
  }
  lines.push("");
  lines.push(`## How this was generated`);
  lines.push("");
  lines.push(
    `Each site was seeded (\`gauntlet seed\` — non-interactive init + flows) then run end-to-end. Findings come from axe-core + persona-judge abandonment events. Reports are unvetted at bench scale; per-site REPORT.md files live under \`bench-tmp/<site>/.gauntlet/runs/<ts>/\`.`,
  );
  return lines.join("\n") + "\n";
}

export interface SaveBenchOptions {
  outDir: string;
  result: BenchRunResult;
}

export async function saveBenchReport(opts: SaveBenchOptions): Promise<{ markdownPath: string; jsonPath: string }> {
  await mkdir(opts.outDir, { recursive: true });
  const date = new Date(opts.result.startedAt).toISOString().slice(0, 10);
  const markdownPath = join(opts.outDir, `bench-${date}.md`);
  const jsonPath = join(opts.outDir, `bench-${date}.json`);
  await writeFile(markdownPath, renderBenchMarkdown(opts.result), "utf8");
  await writeFile(jsonPath, JSON.stringify(opts.result, null, 2), "utf8");
  return { markdownPath, jsonPath };
}
