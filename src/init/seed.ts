/**
 * Non-interactive seed: run Phase A (project read + surface discovery) +
 * Phase B (persona generation, distributed across surfaces) + Phase C (flows
 * per persona) without the human curate loop. Used by:
 *   - `gauntlet seed` CLI subcommand (any cwd)
 *   - scripts/dogfood-facet.ts and scripts/dogfood-quillr.ts (project-specific)
 *   - `gauntlet bench` benchmark harness (multi-site)
 */
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";
import type { AiProvider } from "../ai/provider.ts";
import { readProject, type ProjectContext } from "./project-reader.ts";
import { loadTemplates } from "../persona/templates.ts";
import { generateCandidates, candidateToPersona, type PersonaCandidate } from "./persona-generator.ts";
import { generateFlows } from "./flow-generator.ts";
import { generateSurfaces } from "./surface-generator.ts";
import { writeFlow } from "../flow/loader.ts";
import { writeSurface } from "../surface/loader.ts";
import type { Surface } from "../surface/schema.ts";
import type { Flow } from "../flow/schema.ts";
import type { Persona } from "../persona/schema.ts";

export interface SeedOptions {
  cwd: string;
  provider: AiProvider;
  urls: string[];
  numPersonas?: number;
  flowsPerPersona?: number;
  /**
   * When false, skip auto-probing common URL paths in project-reader. Use for
   * targeted dogfood scripts that already know the surface URLs.
   */
  probePaths?: boolean;
  log?: (line: string) => void;
}

export interface SeedResult {
  project: ProjectContext;
  surfaces: Surface[];
  personas: Persona[];
  flows: Flow[];
}

const noLog = (): void => undefined;

export async function seedProject(opts: SeedOptions): Promise<SeedResult> {
  const log = opts.log ?? noLog;
  const numPersonas = Math.max(1, opts.numPersonas ?? 4);
  const flowsPerPersona = Math.max(1, opts.flowsPerPersona ?? 2);

  // Phase A.
  log(`[Phase A] reading project + landings (urls=${opts.urls.length})...`);
  const project = await readProject({
    cwd: opts.cwd,
    urls: opts.urls,
    probePaths: opts.probePaths ?? true,
  });
  const reachable = project.landings.filter((l) => l.reachable).length;
  log(
    `  project=${project.projectName ?? "(unknown)"} bytes=${project.totalBytes} ` +
      `landings=${reachable}+${project.landings.length - reachable}`,
  );

  // Phase A2: surfaces.
  log(`[Phase A2] AI proposing surfaces...`);
  const surfaces = await generateSurfaces({ provider: opts.provider, project });
  log(`  ${surfaces.length} surface${surfaces.length === 1 ? "" : "s"} proposed`);
  for (const s of surfaces) {
    const auth = s.requires_auth ? " (requires_auth)" : "";
    log(`    - ${s.id} (${s.name})${auth} base=${s.base_url ?? "(unset)"}`);
    await writeSurface(s, opts.cwd);
  }

  // Phase B: personas distributed across surfaces.
  const templates = await loadTemplates();
  log(`[Phase B] generating ${numPersonas * 2} candidates (target=${numPersonas}) across surfaces...`);
  const candidates = await generateCandidates({
    provider: opts.provider,
    project,
    templates,
    surfaces,
    count: Math.max(numPersonas * 2, 8),
  });
  log(`  got ${candidates.length} candidates`);

  // Round-robin pick one per surface until we reach numPersonas.
  const bySurface = new Map<string, PersonaCandidate[]>();
  for (const c of candidates) {
    const sid = c.surface ?? "(unassigned)";
    let group = bySurface.get(sid);
    if (!group) {
      group = [];
      bySurface.set(sid, group);
    }
    group.push(c);
  }
  const picked: PersonaCandidate[] = [];
  const queues = Array.from(bySurface.values()).map((q) => [...q]);
  while (picked.length < numPersonas) {
    let took = false;
    for (const q of queues) {
      const next = q.shift();
      if (next && !picked.includes(next)) {
        picked.push(next);
        took = true;
        if (picked.length >= numPersonas) break;
      }
    }
    if (!took) break;
  }
  log(`  picked ${picked.length}`);

  // Write personas with their surface tag.
  await mkdir(join(opts.cwd, ".gauntlet", "personas"), { recursive: true });
  const personas: Persona[] = [];
  for (const c of picked) {
    const persona = candidateToPersona(c);
    const yamlPath = join(opts.cwd, ".gauntlet", "personas", `${persona.id}.yaml`);
    await writeFile(
      yamlPath,
      stringifyYaml({ ...persona, surface: c.surface }),
      "utf8",
    );
    personas.push(persona);
  }

  // Phase C: flows per persona (surface-aware).
  log(`[Phase C] generating ${flowsPerPersona} flows per persona...`);
  const allFlows: Flow[] = [];
  for (const c of picked) {
    const persona = candidateToPersona(c);
    const surface = surfaces.find((s) => s.id === c.surface);
    const flowOpts: Parameters<typeof generateFlows>[0] = {
      provider: opts.provider,
      project,
      persona,
      count: flowsPerPersona,
    };
    if (surface) flowOpts.surface = surface;
    const flows = await generateFlows(flowOpts);
    log(`  ${persona.id} (${c.surface ?? "no-surface"}): ${flows.length} flow${flows.length === 1 ? "" : "s"}`);
    for (const f of flows) {
      await writeFlow(f, opts.cwd);
      allFlows.push(f);
    }
  }

  return { project, surfaces, personas, flows: allFlows };
}
