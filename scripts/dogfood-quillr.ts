/* eslint-disable no-console */
// One-shot dogfood: discover surfaces, generate + auto-accept personas + flows.
import { pickProvider } from "../src/ai/index.ts";
import { configureAiCache } from "../src/ai/cache.ts";
import { readProject } from "../src/init/project-reader.ts";
import { loadTemplates } from "../src/persona/templates.ts";
import {
  generateCandidates,
  candidateToPersona,
} from "../src/init/persona-generator.ts";
import { generateFlows } from "../src/init/flow-generator.ts";
import { generateSurfaces } from "../src/init/surface-generator.ts";
import { writeFlow } from "../src/flow/loader.ts";
import { writeSurface } from "../src/surface/loader.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

const cwd = process.argv[2] ?? process.cwd();
const url = process.argv[3] ?? "http://100.110.251.103:3000/";
const numPersonas = Number(process.argv[4] ?? 4);

configureAiCache({ enabled: true, cwd });
const provider = pickProvider("claude-opus-4-7");

console.log(`dogfood: cwd=${cwd} url=${url} personas=${numPersonas}`);

console.log("\nPhase A: reading project + discovering surfaces...");
const project = await readProject({ cwd, url });
console.log(`  ${project.projectName} | bytes=${project.totalBytes} landing=${project.landing ? "yes" : "no"}`);

const surfaces = await generateSurfaces({ provider, project });
console.log(`  ${surfaces.length} surface(s) proposed:`);
for (const s of surfaces) {
  console.log(`    - ${s.id} (${s.name}) base_url=${s.base_url ?? "(unset)"}`);
}
for (const s of surfaces) {
  const p = await writeSurface(s, cwd);
  console.log(`    wrote ${p}`);
}

const templates = await loadTemplates();
console.log(`  templates: ${templates.length}`);

console.log("\nPhase B: generating personas (split across surfaces)...");
const candidates = await generateCandidates({
  provider,
  project,
  templates,
  surfaces,
  count: Math.max(numPersonas * 2, 8),
});
console.log(`  got ${candidates.length} candidates`);

// Pick numPersonas, distributed across surfaces.
const bySurface = new Map<string, typeof candidates>();
for (const c of candidates) {
  const sid = c.surface ?? "(unassigned)";
  if (!bySurface.has(sid)) bySurface.set(sid, []);
  bySurface.get(sid)!.push(c);
}
const picked: typeof candidates = [];
for (const [, group] of bySurface) {
  if (group[0]) picked.push(group[0]);
  if (picked.length >= numPersonas) break;
}
// fill remaining slots round-robin
let idx = 0;
while (picked.length < numPersonas && idx < candidates.length) {
  const c = candidates[idx]!;
  if (!picked.includes(c)) picked.push(c);
  idx++;
}
console.log(`  picked: ${picked.map((p) => `${p.id} [${p.label}/${p.surface ?? "?"}]`).join(", ")}`);

await mkdir(join(cwd, ".gauntlet", "personas"), { recursive: true });
for (const c of picked) {
  const persona = candidateToPersona(c);
  await writeFile(
    join(cwd, ".gauntlet", "personas", `${persona.id}.yaml`),
    stringifyYaml({ ...persona, surface: c.surface }),
    "utf8",
  );
  console.log(`  wrote .gauntlet/personas/${persona.id}.yaml (surface=${c.surface ?? "none"})`);
}

console.log("\nPhase C: generating flows...");
for (const c of picked) {
  const persona = candidateToPersona(c);
  const surface = surfaces.find((s) => s.id === c.surface);
  const flowOpts: Parameters<typeof generateFlows>[0] = { provider, project, persona, count: 2 };
  if (surface) flowOpts.surface = surface;
  const flows = await generateFlows(flowOpts);
  console.log(`  ${persona.id} (surface=${c.surface ?? "none"}): ${flows.length} flow${flows.length === 1 ? "" : "s"}`);
  for (const f of flows) {
    const p = await writeFlow(f, cwd);
    console.log(`    wrote ${p}`);
  }
}

console.log("\nseed complete.");
