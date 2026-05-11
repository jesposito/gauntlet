/* eslint-disable no-console */
// One-shot dogfood: generate + auto-accept personas + flows for Quillr.
import { pickProvider } from "../src/ai/index.ts";
import { configureAiCache } from "../src/ai/cache.ts";
import { readProject } from "../src/init/project-reader.ts";
import { loadTemplates } from "../src/persona/templates.ts";
import {
  generateCandidates,
  candidateToPersona,
} from "../src/init/persona-generator.ts";
import { generateFlows } from "../src/init/flow-generator.ts";
import { writeFlow } from "../src/flow/loader.ts";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { stringify as stringifyYaml } from "yaml";

const cwd = process.argv[2] ?? process.cwd();
const url = process.argv[3] ?? "http://100.110.251.103:3000/";
const numPersonas = Number(process.argv[4] ?? 2);

configureAiCache({ enabled: true, cwd });
const provider = pickProvider("claude-opus-4-7");

console.log(`dogfood: cwd=${cwd} url=${url} personas=${numPersonas}`);

console.log("\nPhase A: reading project...");
const project = await readProject({ cwd, url });
console.log(`  ${project.projectName} | bytes=${project.totalBytes} landing=${project.landing ? "yes" : "no"}`);

const templates = await loadTemplates();
console.log(`  templates: ${templates.length}`);

console.log("\nPhase B: generating personas...");
const candidates = await generateCandidates({ provider, project, templates, count: 6 });
console.log(`  got ${candidates.length} candidates`);

const cores = candidates.filter((c) => c.label === "core");
const edges = candidates.filter((c) => c.label === "edge");
const picked: typeof candidates = [];
if (numPersonas >= 1 && cores[0]) picked.push(cores[0]);
if (numPersonas >= 2 && edges[0]) picked.push(edges[0]);
if (picked.length < numPersonas) {
  for (const c of candidates) {
    if (picked.includes(c)) continue;
    picked.push(c);
    if (picked.length >= numPersonas) break;
  }
}
console.log(`  picked: ${picked.map((p) => `${p.id} [${p.label}]`).join(", ")}`);

await mkdir(join(cwd, ".gauntlet", "personas"), { recursive: true });
for (const c of picked) {
  const persona = candidateToPersona(c);
  await writeFile(
    join(cwd, ".gauntlet", "personas", `${persona.id}.yaml`),
    stringifyYaml(persona),
    "utf8",
  );
  console.log(`  wrote .gauntlet/personas/${persona.id}.yaml`);
}

console.log("\nPhase C: generating flows...");
for (const c of picked) {
  const persona = candidateToPersona(c);
  const flows = await generateFlows({ provider, project, persona, count: 2 });
  console.log(`  ${persona.id}: ${flows.length} flow${flows.length === 1 ? "" : "s"}`);
  for (const f of flows) {
    const p = await writeFlow(f, cwd);
    console.log(`    wrote ${p}`);
  }
}

console.log("\nseed complete.");
