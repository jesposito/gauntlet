/* eslint-disable no-console */
// Facet Cloud dogfood: discover surfaces across marketing + tenant + admin,
// auto-curate personas + flows, then tell the user what to capture for auth.
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

const cwd = process.argv[2] ?? "/home/jed/dev/facets-sh";
const urls = [
  "https://get-facet.com",
  "https://jed.facetcloud.io",
  "https://jed.facetcloud.io/admin",
];
const numPersonas = Number(process.argv[3] ?? 6);
const model = process.argv[4] ?? process.env.GAUNTLET_MODEL ?? "claude-opus-4-7";

configureAiCache({ enabled: true, cwd });
const provider = pickProvider(model);
console.log(`model: ${provider.name}/${provider.model}`);

console.log(`dogfood-facet:`);
console.log(`  cwd:      ${cwd}`);
console.log(`  urls:     ${urls.join(", ")}`);
console.log(`  personas: ${numPersonas}`);

console.log("\nPhase A: reading project + fetching all surfaces' landings...");
const project = await readProject({ cwd, urls });
console.log(
  `  ${project.projectName} | bytes=${project.totalBytes} landings=${project.landings.length}`,
);
for (const l of project.landings) {
  const status = l.reachable ? `${l.statusCode}` : `UNREACHABLE${l.statusCode ? ` ${l.statusCode}` : ""}`;
  console.log(`    [${status}] ${l.url}${l.hint ? ` -- ${l.hint}` : ""}`);
}

console.log("\nPhase A2: AI proposing surfaces from all landings...");
const surfaces = await generateSurfaces({ provider, project });
console.log(`  ${surfaces.length} surface(s) proposed:`);
for (const s of surfaces) {
  const auth = s.requires_auth ? " [requires_auth]" : "";
  const login = s.login_url ? ` login=${s.login_url}` : "";
  console.log(`    - ${s.id} (${s.name})${auth}`);
  console.log(`        base_url=${s.base_url ?? "(unset)"}${login}`);
  console.log(`        audience: ${s.audience}`);
  console.log(`        features: ${s.features.join(", ") || "(none)"}`);
}
for (const s of surfaces) {
  const p = await writeSurface(s, cwd);
  console.log(`    wrote ${p}`);
}

const templates = await loadTemplates();

console.log("\nPhase B: generating personas split across surfaces...");
const candidates = await generateCandidates({
  provider,
  project,
  templates,
  surfaces,
  count: Math.max(numPersonas * 2, 10),
});
console.log(`  got ${candidates.length} candidates`);

const bySurface = new Map<string, typeof candidates>();
for (const c of candidates) {
  const sid = c.surface ?? "(unassigned)";
  if (!bySurface.has(sid)) bySurface.set(sid, []);
  bySurface.get(sid)!.push(c);
}

// Round-robin one from each surface until we hit numPersonas.
const picked: typeof candidates = [];
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
console.log(`  picked ${picked.length}:`);
for (const c of picked) console.log(`    - ${c.id} [${c.label} / surface=${c.surface ?? "?"}]`);

await mkdir(join(cwd, ".gauntlet", "personas"), { recursive: true });
for (const c of picked) {
  const persona = candidateToPersona(c);
  await writeFile(
    join(cwd, ".gauntlet", "personas", `${persona.id}.yaml`),
    stringifyYaml({ ...persona, surface: c.surface }),
    "utf8",
  );
}

console.log("\nPhase C: generating flows per persona (surface-aware)...");
for (const c of picked) {
  const persona = candidateToPersona(c);
  const surface = surfaces.find((s) => s.id === c.surface);
  const flowOpts: Parameters<typeof generateFlows>[0] = {
    provider,
    project,
    persona,
    count: 2,
  };
  if (surface) flowOpts.surface = surface;
  const flows = await generateFlows(flowOpts);
  console.log(
    `  ${persona.id} (surface=${c.surface ?? "none"}): ${flows.length} flow${flows.length === 1 ? "" : "s"}`,
  );
  for (const f of flows) await writeFlow(f, cwd);
}

console.log("\n================================================================");
console.log("seed complete.");
console.log("================================================================");

const authNeeded = surfaces.filter((s) => s.requires_auth);
if (authNeeded.length > 0) {
  console.log("\nnext: capture auth for the surfaces that sit behind login.");
  for (const s of authNeeded) {
    const loginUrl = s.login_url ?? s.base_url ?? "(set --url manually)";
    console.log(
      `  cd ${cwd} && bun run /home/jed/dev/gauntlet/src/cli.ts auth ${s.id} --url ${loginUrl}`,
    );
  }
}

console.log("\nthen run gauntlet against each surface:");
for (const s of surfaces) {
  console.log(`  cd ${cwd} && bun run /home/jed/dev/gauntlet/src/cli.ts run --surface ${s.id}`);
}
