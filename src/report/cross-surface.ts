import { readFile, readdir, stat, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { chromium } from "playwright";
import { runAxe } from "../runner/axe-scan.ts";
import { loadAllSurfaces, loadSurface } from "../surface/loader.ts";
import { resolveAuthStatePath } from "../auth/capture.ts";
import type { RunReport } from "./schema.ts";
import { findLatestRunDir } from "./build.ts";

export interface SurfaceRun {
  surfaceId: string;
  runDir: string;
  report: RunReport;
}

export interface CrossSurfaceVetting {
  status: "verified" | "regressed" | "subjective" | "could_not_replay" | "unverified";
  surfacesReplayed: number;
  surfacesRePassed: number;
  note: string;
}

export interface CrossSurfacePattern {
  signature: string;
  title: string;
  surfaces: string[]; // surface ids the signature occurred on
  totalCount: number; // total findings across all surfaces matching this signature
  personas: string[]; // distinct personas across all surfaces
  vetting?: CrossSurfaceVetting;
}

export interface CrossSurfaceReport {
  surfaces: { surfaceId: string; runDir: string; findings: number; personas: string[] }[];
  patterns: CrossSurfacePattern[]; // signatures present on >=2 surfaces
  surfaceUnique: { surfaceId: string; findings: number }[]; // findings unique to one surface
  totalUniqueSignatures: number;
}

/**
 * Path family: first 2 path segments. Two URLs are in the same family iff
 * their first two segments match. e.g.
 *   /admin/blog/posts/123  ->  /admin/blog/*
 *   /admin/blog/edit       ->  /admin/blog/*
 *   /admin/settings        ->  /admin/settings/*
 * Used for cross-surface signature so console errors on /admin/blog and
 * console errors on /admin/settings don't collapse into one "systemic" pattern.
 */
function pathFamily(url: string): string {
  try {
    const u = new URL(url);
    const segs = u.pathname.split("/").filter(Boolean).slice(0, 2);
    if (segs.length === 0) return "/";
    return "/" + segs.join("/") + (segs.length > 0 ? "/*" : "");
  } catch {
    return "/";
  }
}

/**
 * Normalize a console-error / abandon message into a stable key. Strips
 * absolute URLs, dynamic IDs, and trailing punctuation so two messages
 * about the same underlying problem collapse but two genuinely-different
 * messages don't.
 */
function normalizeMessage(message: string): string {
  return message
    .replace(/https?:\/\/[^\s'"`)]+/gi, "<url>")
    .replace(/\b[0-9a-f]{8,}\b/gi, "<hash>")
    .replace(/\b\d{3,}\b/g, "<n>")
    .replace(/\s+/g, " ")
    .trim()
    .slice(0, 80);
}

function signatureOf(
  reason: string,
  axeRuleId: string | undefined,
  url: string,
  message: string,
): string {
  if (axeRuleId) return `axe:${axeRuleId}`;
  // Non-axe: include normalized message + url path family so unrelated
  // console errors on different surface routes don't get treated as one
  // systemic pattern.
  return `${reason} @ ${pathFamily(url)} :: ${normalizeMessage(message)}`;
}

export function buildCrossSurface(runs: SurfaceRun[]): CrossSurfaceReport {
  // signature -> { surfaces, totalCount, personas, title }
  const byKey = new Map<
    string,
    { title: string; surfaces: Set<string>; personas: Set<string>; total: number }
  >();
  for (const r of runs) {
    for (const persona of r.report.personas) {
      for (const f of persona.findings) {
        const key = signatureOf(f.reason, f.axeRuleId, f.url, f.title);
        let entry = byKey.get(key);
        if (!entry) {
          entry = { title: f.title, surfaces: new Set(), personas: new Set(), total: 0 };
          byKey.set(key, entry);
        }
        entry.surfaces.add(r.surfaceId);
        entry.personas.add(persona.personaId);
        entry.total += 1;
      }
    }
  }

  const patterns: CrossSurfacePattern[] = [];
  const surfaceUniqueCounts = new Map<string, number>();
  for (const [signature, entry] of byKey) {
    if (entry.surfaces.size >= 2) {
      patterns.push({
        signature,
        title: entry.title,
        surfaces: Array.from(entry.surfaces).sort(),
        totalCount: entry.total,
        personas: Array.from(entry.personas).sort(),
      });
    } else if (entry.surfaces.size === 1) {
      const s = entry.surfaces.values().next().value as string;
      surfaceUniqueCounts.set(s, (surfaceUniqueCounts.get(s) ?? 0) + entry.total);
    }
  }
  patterns.sort((a, b) => b.surfaces.length - a.surfaces.length || b.totalCount - a.totalCount);

  return {
    surfaces: runs.map((r) => ({
      surfaceId: r.surfaceId,
      runDir: r.runDir,
      findings: r.report.totals.findings,
      personas: r.report.personas.map((p) => p.personaId),
    })),
    patterns,
    surfaceUnique: Array.from(surfaceUniqueCounts.entries())
      .map(([surfaceId, findings]) => ({ surfaceId, findings }))
      .sort((a, b) => b.findings - a.findings),
    totalUniqueSignatures: byKey.size,
  };
}

interface FlowResultMeta {
  surface?: string;
  persona?: string;
}

async function detectSurfaceForRun(runDir: string, cwd?: string): Promise<string | undefined> {
  // 1. Walk run dir, find any flow-result.json with a surface field.
  // 2. Fallback for pre-surface runs: look at the run's persona dirs, then
  //    read .gauntlet/personas/<id>.yaml for its surface attribute.
  let personaIdFromRun: string | undefined;
  try {
    const personas = await readdir(runDir);
    for (const p of personas) {
      if (p.includes(".") || p.toUpperCase() === p) continue; // skip REPORT.md, report.json
      const personaDir = join(runDir, p);
      const st = await stat(personaDir).catch(() => undefined);
      if (!st?.isDirectory()) continue;
      if (!personaIdFromRun) personaIdFromRun = p;
      let flows: string[];
      try {
        flows = await readdir(personaDir);
      } catch {
        continue;
      }
      for (const f of flows) {
        const direct = join(personaDir, f, "flow-result.json");
        try {
          const raw = await readFile(direct, "utf8");
          const meta = JSON.parse(raw) as FlowResultMeta;
          if (meta.surface) return meta.surface;
        } catch {
          /* try next */
        }
      }
    }
  } catch {
    return undefined;
  }
  if (cwd && personaIdFromRun) {
    try {
      const yamlPath = join(cwd, ".gauntlet/personas", `${personaIdFromRun}.yaml`);
      const raw = await readFile(yamlPath, "utf8");
      const m = raw.match(/^surface:\s*([a-z0-9-]+)\s*$/im);
      if (m?.[1]) return m[1];
    } catch {
      /* ignore */
    }
  }
  return undefined;
}

export interface DiscoverLatestOptions {
  cwd: string;
  surfaceIds?: string[]; // explicit subset; default = every curated surface
}

export async function discoverLatestRunsPerSurface(
  opts: DiscoverLatestOptions,
): Promise<SurfaceRun[]> {
  const runsRoot = join(opts.cwd, ".gauntlet", "runs");
  let allRuns: string[];
  try {
    allRuns = (await readdir(runsRoot))
      .map((d) => join(runsRoot, d))
      .sort()
      .reverse(); // newest first
  } catch {
    return [];
  }

  const targetSurfaceIds = opts.surfaceIds ?? (await loadAllSurfaces(opts.cwd)).map((s) => s.id);
  const surfaceSet = new Set(targetSurfaceIds);

  const result: SurfaceRun[] = [];
  const claimed = new Set<string>();
  for (const runDir of allRuns) {
    if (claimed.size === surfaceSet.size) break;
    const surfaceId = await detectSurfaceForRun(runDir, opts.cwd);
    if (!surfaceId) continue;
    if (!surfaceSet.has(surfaceId)) continue;
    if (claimed.has(surfaceId)) continue;
    const reportPath = join(runDir, "report.json");
    try {
      const raw = await readFile(reportPath, "utf8");
      const report = JSON.parse(raw) as RunReport;
      result.push({ surfaceId, runDir, report });
      claimed.add(surfaceId);
    } catch {
      // no report.json — skip
    }
  }
  return result;
}

function badgeFor(status: CrossSurfaceVetting["status"]): string {
  switch (status) {
    case "verified":
      return "**[VERIFIED]**";
    case "regressed":
      return "_[regressed]_";
    case "subjective":
      return "_[subjective]_";
    case "could_not_replay":
      return "_[could_not_replay]_";
    case "unverified":
      return "_[unverified]_";
  }
}

export function renderCrossSurfaceMarkdown(report: CrossSurfaceReport): string {
  const lines: string[] = [];
  lines.push(`# Cross-surface gauntlet report`);
  lines.push("");
  lines.push(
    `Aggregated ${report.surfaces.length} surface${report.surfaces.length === 1 ? "" : "s"} | ${report.patterns.length} cross-surface pattern${report.patterns.length === 1 ? "" : "s"} | ${report.totalUniqueSignatures} unique signature${report.totalUniqueSignatures === 1 ? "" : "s"}`,
  );
  lines.push("");

  lines.push(`## Surfaces in scope`);
  lines.push("");
  lines.push(`| Surface | Findings | Personas | Run |`);
  lines.push(`|---|---:|---|---|`);
  for (const s of report.surfaces) {
    lines.push(
      `| \`${s.surfaceId}\` | ${s.findings} | ${s.personas.join(", ")} | \`${s.runDir}\` |`,
    );
  }
  lines.push("");

  lines.push(`## Cross-surface patterns (highest leverage to fix)`);
  lines.push("");
  if (report.patterns.length === 0) {
    lines.push(`_No signature spans multiple surfaces. Each surface has its own bug shape._`);
  } else {
    lines.push(`| Signature | Surfaces | Total | Personas | Vetting |`);
    lines.push(`|---|---|---:|---|---|`);
    for (const p of report.patterns) {
      const vet = p.vetting
        ? `${badgeFor(p.vetting.status)} ${p.vetting.surfacesRePassed}/${p.vetting.surfacesReplayed}`
        : "_unverified_";
      lines.push(
        `| \`${p.signature}\` <br/> ${p.title.replace(/\|/g, "\\|").slice(0, 80)} | ${p.surfaces.join(", ")} | ${p.totalCount} | ${p.personas.join(", ")} | ${vet} |`,
      );
    }
  }
  lines.push("");

  if (report.surfaceUnique.length > 0) {
    lines.push(`## Surface-unique findings`);
    lines.push("");
    lines.push(`| Surface | Unique findings |`);
    lines.push(`|---|---:|`);
    for (const s of report.surfaceUnique) {
      lines.push(`| \`${s.surfaceId}\` | ${s.findings} |`);
    }
    lines.push("");
  }

  lines.push(`## How to read this`);
  lines.push("");
  lines.push(
    `- **Cross-surface patterns** are the highest-leverage fixes. A signature like \`axe:color-contrast\` appearing on marketing + tenant-portfolio + tenant-admin almost always points at a design-system token, not three separate bugs.`,
  );
  lines.push(
    `- **Surface-unique findings** are typically scoped to that surface's specific UX (e.g. only the admin has a "Generate summary" button missing).`,
  );
  lines.push(
    `- Per-surface drill-down: each row in **Surfaces in scope** links to a \`.gauntlet/runs/.../REPORT.md\` with the full per-finding detail (artifact paths, screenshots, axe rule URLs).`,
  );
  return lines.join("\n") + "\n";
}

export interface BuildCrossSurfaceOptions {
  cwd: string;
  surfaceIds?: string[];
  runDirs?: string[]; // override: use these explicit run dirs
  vet?: boolean; // also run vetCrossSurfacePatterns() to verify top axe patterns
  vetTopN?: number;
}

export interface BuildCrossSurfaceResult {
  markdownPath: string;
  jsonPath: string;
  report: CrossSurfaceReport;
}

export async function buildCrossSurfaceReport(
  opts: BuildCrossSurfaceOptions,
): Promise<BuildCrossSurfaceResult> {
  let runs: SurfaceRun[];
  if (opts.runDirs && opts.runDirs.length > 0) {
    runs = [];
    for (const runDir of opts.runDirs) {
      const surfaceId = (await detectSurfaceForRun(runDir, opts.cwd)) ?? "(unknown)";
      try {
        const raw = await readFile(join(runDir, "report.json"), "utf8");
        const report = JSON.parse(raw) as RunReport;
        runs.push({ surfaceId, runDir, report });
      } catch {
        // skip
      }
    }
  } else {
    runs = await discoverLatestRunsPerSurface({
      cwd: opts.cwd,
      ...(opts.surfaceIds ? { surfaceIds: opts.surfaceIds } : {}),
    });
  }
  const report = buildCrossSurface(runs);
  if (opts.vet) {
    report.patterns = await vetCrossSurfacePatterns(report.patterns, {
      cwd: opts.cwd,
      ...(opts.vetTopN !== undefined ? { topN: opts.vetTopN } : {}),
    });
  }
  const md = renderCrossSurfaceMarkdown(report);
  const outDir = join(opts.cwd, ".gauntlet");
  const mdPath = join(outDir, "CROSS-REPORT.md");
  const jsonPath = join(outDir, "cross-report.json");
  await writeFile(mdPath, md, "utf8");
  await writeFile(jsonPath, JSON.stringify(report, null, 2), "utf8");
  return { markdownPath: mdPath, jsonPath, report };
}

export interface VetCrossSurfaceOptions {
  cwd: string;
  topN?: number; // limit how many patterns to vet (cost control). Default 8.
  headless?: boolean;
  timeoutMs?: number;
}

/**
 * Cross-surface vetting: for each axe pattern in the rollup, visit each
 * surface's base_url once, run axe, check whether the axe rule still fires.
 * Tags the pattern verified iff it re-fires on a majority of surfaces.
 * Non-axe patterns (console_error, abandoned_by_persona, etc) are tagged
 * subjective since they need flow-replay or persona judgment.
 */
export async function vetCrossSurfacePatterns(
  patterns: CrossSurfacePattern[],
  opts: VetCrossSurfaceOptions,
): Promise<CrossSurfacePattern[]> {
  const topN = opts.topN ?? 8;
  const headless = opts.headless ?? true;
  const timeoutMs = opts.timeoutMs ?? 20_000;
  const targets = patterns.slice(0, topN);
  if (targets.length === 0) return patterns;

  // Resolve every surface mentioned across the top patterns.
  const surfaceIds = new Set<string>();
  for (const p of targets) for (const s of p.surfaces) surfaceIds.add(s);
  const surfaceMeta: { id: string; baseUrl: string; storageState?: string }[] = [];
  for (const id of surfaceIds) {
    try {
      const s = await loadSurface(id, opts.cwd);
      if (!s.base_url) continue;
      const auth = resolveAuthStatePath(opts.cwd, s.auth_state);
      surfaceMeta.push({
        id,
        baseUrl: s.base_url,
        ...(auth ? { storageState: auth } : {}),
      });
    } catch {
      /* surface yaml missing; skip */
    }
  }

  if (surfaceMeta.length === 0) {
    return patterns.map((p) => ({
      ...p,
      vetting: {
        status: "could_not_replay",
        surfacesReplayed: 0,
        surfacesRePassed: 0,
        note: "no surface yamls with base_url found",
      },
    }));
  }

  // Visit every surface once, collect axe-rule sets.
  const axeRulesBySurface = new Map<string, Set<string>>();
  const navFailures = new Map<string, string>();
  const browser = await chromium.launch({ headless });
  try {
    for (const s of surfaceMeta) {
      const context = await browser.newContext(
        s.storageState ? { storageState: s.storageState } : {},
      );
      const page = await context.newPage();
      try {
        await page.goto(s.baseUrl, { waitUntil: "domcontentloaded", timeout: timeoutMs });
        await page.waitForLoadState("networkidle", { timeout: 8_000 }).catch(() => undefined);
        const axe = await runAxe(page);
        axeRulesBySurface.set(s.id, new Set(axe.violations.map((v) => v.id)));
      } catch (err) {
        navFailures.set(s.id, err instanceof Error ? err.message : String(err));
      } finally {
        await context.close().catch(() => undefined);
      }
    }
  } finally {
    await browser.close().catch(() => undefined);
  }

  // Stamp every pattern.
  const vetted = patterns.map((p) => ({ ...p }));
  for (let i = 0; i < vetted.length; i++) {
    const p = vetted[i]!;
    if (i >= topN) {
      p.vetting = {
        status: "unverified",
        surfacesReplayed: 0,
        surfacesRePassed: 0,
        note: `not in top ${topN} patterns; skipped`,
      };
      continue;
    }
    if (!p.signature.startsWith("axe:")) {
      p.vetting = {
        status: "subjective",
        surfacesReplayed: 0,
        surfacesRePassed: 0,
        note: "non-axe pattern; cross-surface vetting needs flow_replay (not yet implemented)",
      };
      continue;
    }
    const ruleId = p.signature.replace(/^axe:/, "");
    let surfacesReplayed = 0;
    let surfacesRePassed = 0;
    const notes: string[] = [];
    for (const sid of p.surfaces) {
      if (navFailures.has(sid)) {
        notes.push(`${sid}: nav failed (${navFailures.get(sid)})`);
        continue;
      }
      const rules = axeRulesBySurface.get(sid);
      if (!rules) {
        notes.push(`${sid}: no surface base_url`);
        continue;
      }
      surfacesReplayed += 1;
      if (rules.has(ruleId)) surfacesRePassed += 1;
    }
    const majority = surfacesReplayed > 0 && surfacesRePassed * 2 >= surfacesReplayed;
    p.vetting = {
      status:
        surfacesReplayed === 0
          ? "could_not_replay"
          : majority
            ? "verified"
            : "regressed",
      surfacesReplayed,
      surfacesRePassed,
      note: notes.length > 0 ? notes.join("; ") : `${surfacesRePassed}/${surfacesReplayed} surfaces re-fired`,
    };
  }
  return vetted;
}

// Re-export findLatestRunDir for consumers that want to mix-and-match.
export { findLatestRunDir };
