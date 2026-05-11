#!/usr/bin/env bun
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  loadPersona,
  listBuiltinPersonas,
  listCuratedPersonas,
} from "./persona/loader.ts";
import { runPersona } from "./runner/browser.ts";
import { runFlow } from "./runner/flow-runner.ts";
import { DEFAULT_MODEL, pickProvider } from "./ai/index.ts";
import { configureAiCache } from "./ai/cache.ts";
import { readProject } from "./init/project-reader.ts";
import { loadTemplates } from "./persona/templates.ts";
import {
  generateCandidates,
  type PersonaCandidate,
} from "./init/persona-generator.ts";
import { curate, listCuratedIds } from "./init/curate.ts";
import { generateFlows } from "./init/flow-generator.ts";
import { curateFlows } from "./init/curate-flows.ts";
import { listFlows, loadFlowsForPersona } from "./flow/loader.ts";

interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const rest = args.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const values: string[] = [];
        while (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) {
          values.push(rest[++i]!);
        }
        flags[key] = values.length === 1 ? values[0]! : values.join(",");
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { command, positional, flags };
}

async function cmdRun(args: ParsedArgs): Promise<void> {
  const url = args.positional[0];
  if (!url) {
    console.error("error: missing URL");
    console.error("usage: gauntlet run <url> --personas mary [devon ...]");
    process.exit(2);
  }

  const personaArg = args.flags.personas;
  if (!personaArg || personaArg === true) {
    console.error("error: --personas required");
    console.error("available:", (await listBuiltinPersonas()).join(", "));
    process.exit(2);
  }

  const personaIds = String(personaArg)
    .split(",")
    .map((s: string) => s.trim())
    .filter((s: string): s is string => Boolean(s));
  const headless = args.flags.headless !== "false" && args.flags.headed !== true;
  const maxSteps = args.flags.steps ? Number(args.flags.steps) : 1;
  const cacheEnabled = args.flags["no-cache"] !== true;
  const model =
    typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const forceLegacy = args.flags["no-flows"] === true;

  const cwd = process.cwd();
  configureAiCache({ enabled: cacheEnabled, cwd });

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(cwd, ".gauntlet", "runs", ts);
  await mkdir(baseDir, { recursive: true });

  console.log(`gauntlet run -> ${url}`);
  console.log(`personas: ${personaIds.join(", ")}`);
  console.log(`run dir: ${baseDir}`);

  let providerLazy: ReturnType<typeof pickProvider> | undefined;
  const getProvider = (): ReturnType<typeof pickProvider> => {
    if (!providerLazy) providerLazy = pickProvider(model);
    return providerLazy;
  };

  for (const id of personaIds) {
    if (!id) continue;
    const persona = await loadPersona(id, cwd);
    const flows = forceLegacy ? [] : await loadFlowsForPersona(id, cwd);

    if (flows.length === 0) {
      const runDir = join(baseDir, persona.id);
      console.log(
        `\n[${persona.id}] ${persona.character.name} -> ${url} (no flows; legacy single-step capture)`,
      );
      const result = await runPersona({ url, persona, runDir, maxSteps, headless });
      console.log(
        `[${persona.id}] done. steps=${result.steps} failures=${result.failures.length} duration=${result.durationMs}ms`,
      );
      continue;
    }

    console.log(
      `\n[${persona.id}] ${persona.character.name} -> ${url} (${flows.length} flow${flows.length === 1 ? "" : "s"})`,
    );
    for (const flow of flows) {
      const runDir = join(baseDir, persona.id, flow.id);
      console.log(`  flow: ${flow.id} (${flow.steps.length} steps) - ${flow.title}`);
      const result = await runFlow({
        url,
        persona,
        flow,
        provider: getProvider(),
        runDir,
        headless,
      });
      const stepSummary = result.steps
        .map((s) => `${s.stepIndex + 1}:${s.verdict.status[0]}`)
        .join(" ");
      console.log(
        `    outcome=${result.outcome} steps=[${stepSummary}] failures=${result.failures.length} duration=${result.durationMs}ms`,
      );
      if (result.outcomeReason) console.log(`    why: ${result.outcomeReason}`);
      if (result.failures.length > 0) {
        for (const f of result.failures.slice(0, 3)) {
          console.log(`      - ${f.reason}: ${f.message.slice(0, 140)}`);
        }
      }
    }
  }

  console.log(`\nartifacts: ${baseDir}`);
}

async function cmdList(): Promise<void> {
  const curated = await listCuratedPersonas();
  if (curated.length > 0) {
    console.log("curated personas (.gauntlet/personas/):");
    for (const id of curated) {
      const p = await loadPersona(id);
      const flows = await loadFlowsForPersona(id);
      const flowSuffix = flows.length > 0 ? `  [${flows.length} flow${flows.length === 1 ? "" : "s"}]` : "";
      console.log(
        `  ${id.padEnd(28)} ${p.character.name} (${p.character.age ?? "?"})${flowSuffix}`,
      );
    }
  }
  const allFlows = await listFlows();
  if (allFlows.length === 0 && curated.length > 0) {
    console.log("\nno flows yet. run `gauntlet flows` to design test flows per persona.");
  }
  const builtin = await listBuiltinPersonas();
  if (builtin.length > 0) {
    if (curated.length > 0) console.log("");
    console.log("built-in personas (docs / examples):");
    for (const id of builtin) {
      const p = await loadPersona(id);
      console.log(
        `  ${id.padEnd(28)} ${p.character.name} (${p.character.age ?? "?"}) - ${p.character.context.split("\n")[0]}`,
      );
    }
  }
  if (curated.length === 0) {
    console.log("\nno curated roster yet. run `gauntlet init` to build one.");
  }
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const url = typeof args.flags.url === "string" ? args.flags.url : undefined;
  const model =
    typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const requested = args.flags.count ? Number(args.flags.count) : 10;
  const cacheEnabled = args.flags["no-cache"] !== true;

  console.log(`gauntlet init`);
  console.log(`  cwd:    ${cwd}`);
  console.log(`  model:  ${model}`);
  console.log(`  cache:  ${cacheEnabled ? "on (.gauntlet/cache/ai/)" : "off"}`);
  if (url) console.log(`  url:    ${url}`);

  configureAiCache({ enabled: cacheEnabled, cwd });
  const provider = pickProvider(model);

  console.log("\n[Phase A] reading project context...");
  const project = await readProject({ cwd, ...(url ? { url } : {}) });
  console.log(
    `  project=${project.projectName ?? "(unknown)"} frameworks=[${project.frameworks.join(", ")}] readme=${project.readmeExcerpt ? "yes" : "no"} landing=${project.landing ? "yes" : "no"} bytes=${project.totalBytes}`,
  );

  const templates = await loadTemplates();
  console.log(`  templates loaded: ${templates.length}`);

  const existingIds = await listCuratedIds(cwd);
  if (existingIds.length > 0) {
    console.log(
      `  already-curated (${existingIds.length}): ${existingIds.join(", ")}`,
    );
  }

  console.log("\n[Phase B] asking AI for candidate personas...");
  const candidates = await generateCandidates({
    provider,
    project,
    templates,
    count: requested,
    existing: existingIds,
  });
  console.log(`  got ${candidates.length} unique candidates.`);

  const result = await curate(candidates, {
    cwd,
    regenerate: async (slotId: string): Promise<PersonaCandidate | undefined> => {
      console.log(`regenerating slot ${slotId}...`);
      const fresh = await generateCandidates({
        provider,
        project,
        templates,
        count: 1,
        existing: [...existingIds, ...result.accepted.map((p) => p.id)],
      });
      return fresh[0];
    },
  });

  console.log(
    `\ndone. accepted=${result.accepted.length} rejected=${result.rejected.length} edited=${result.edited.length}`,
  );
  if (result.accepted.length > 0) {
    console.log(`personas written to ${join(cwd, ".gauntlet/personas")}/`);
    console.log(
      "next: `gauntlet flows --personas " +
        result.accepted.map((p) => p.id).join(",") +
        "` to design test flows per persona.",
    );
  }
}

async function cmdFlows(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const model =
    typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const url = typeof args.flags.url === "string" ? args.flags.url : undefined;
  const count = args.flags.count ? Number(args.flags.count) : 3;
  const cacheEnabled = args.flags["no-cache"] !== true;

  const personaArg = args.flags.personas;
  let personaIds: string[];
  if (!personaArg || personaArg === true) {
    personaIds = await listCuratedIds(cwd);
    if (personaIds.length === 0) {
      console.error("error: no curated personas. run `gauntlet init` first.");
      process.exit(2);
    }
  } else {
    personaIds = String(personaArg).split(",").map((s) => s.trim()).filter(Boolean);
  }

  console.log(`gauntlet flows`);
  console.log(`  cwd:      ${cwd}`);
  console.log(`  model:    ${model}`);
  console.log(`  personas: ${personaIds.join(", ")}`);
  console.log(`  cache:    ${cacheEnabled ? "on" : "off"}`);

  configureAiCache({ enabled: cacheEnabled, cwd });
  const provider = pickProvider(model);

  console.log("\n[Phase A] reading project context...");
  const project = await readProject({ cwd, ...(url ? { url } : {}) });
  console.log(
    `  project=${project.projectName ?? "(unknown)"} bytes=${project.totalBytes}`,
  );

  const summary: { persona: string; accepted: number; rejected: number }[] = [];

  for (const id of personaIds) {
    const persona = await loadPersona(id, cwd);
    console.log(`\n[Phase C] ${persona.id} (${persona.character.name})`);
    const flows = await generateFlows({ provider, project, persona, count });
    console.log(`  AI proposed ${flows.length} flow${flows.length === 1 ? "" : "s"}`);

    const result = await curateFlows(flows, {
      cwd,
      regenerate: async () => {
        console.log("regenerating flows for this persona...");
        return generateFlows({ provider, project, persona, count });
      },
    });

    summary.push({
      persona: persona.id,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
    });
  }

  console.log("\nflows summary:");
  for (const s of summary) {
    console.log(`  ${s.persona.padEnd(28)} accepted=${s.accepted} rejected=${s.rejected}`);
  }
  console.log(`\nflows written to ${join(cwd, ".gauntlet/flows")}/`);
}

function cmdHelp(): void {
  console.log(`gauntlet - persona-driven UX failure discovery

usage:
  gauntlet init [--url <url>] [--model <id>] [--count N]
  gauntlet flows [--personas <id[,id...]>] [--model <id>] [--count N] [--url <url>]
  gauntlet run <url> --personas <id[,id...]> [--steps N] [--headed]
  gauntlet list
  gauntlet help

init flags:
  --url <url>        landing page to fetch for product context (optional)
  --model <id>       AI model for persona generation (default ${DEFAULT_MODEL})
  --count <n>        candidate count to request from AI (default 10)
  --no-cache         disable AI response cache (default: cache on)

flows flags:
  --personas <ids>   curated persona ids to design flows for (default: all)
  --model <id>       AI model for flow generation (default ${DEFAULT_MODEL})
  --count <n>        flows per persona to propose (default 3)
  --url <url>        landing page to include in product context (optional)
  --no-cache         disable AI response cache

run flags:
  --personas <ids>   comma-separated persona ids
  --steps <n>        legacy single-step capture step count (default 1)
  --headed           run browser visibly (default headless)
  --model <id>       AI model for in-flow actions (default ${DEFAULT_MODEL})
  --no-cache         disable AI response cache
  --no-flows         force legacy single-step capture even if flows exist
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "run":
      await cmdRun(args);
      break;
    case "init":
      await cmdInit(args);
      break;
    case "flows":
      await cmdFlows(args);
      break;
    case "list":
      await cmdList();
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      console.error(`unknown command: ${args.command}`);
      cmdHelp();
      process.exit(2);
  }
}

main().catch((err) => {
  console.error("fatal:", err);
  process.exit(1);
});
