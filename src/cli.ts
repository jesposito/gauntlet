#!/usr/bin/env bun
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import { loadPersona, listBuiltinPersonas } from "./persona/loader.ts";
import { runPersona } from "./runner/browser.ts";

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

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(process.cwd(), ".gauntlet", "runs", ts);
  await mkdir(baseDir, { recursive: true });

  console.log(`gauntlet run -> ${url}`);
  console.log(`personas: ${personaIds.join(", ")}`);
  console.log(`run dir: ${baseDir}`);

  for (const id of personaIds) {
    if (!id) continue;
    const persona = await loadPersona(id);
    const runDir = join(baseDir, persona.id);
    console.log(`\n[${persona.id}] ${persona.character.name} -> ${url}`);
    const result = await runPersona({ url, persona, runDir, maxSteps, headless });
    console.log(
      `[${persona.id}] done. steps=${result.steps} failures=${result.failures.length} duration=${result.durationMs}ms`,
    );
    if (result.failures.length > 0) {
      console.log(`[${persona.id}] failure summary:`);
      for (const f of result.failures.slice(0, 5)) {
        console.log(`  - ${f.reason}: ${f.message.slice(0, 120)}`);
      }
    }
  }

  console.log(`\nartifacts: ${baseDir}`);
}

async function cmdList(): Promise<void> {
  const ids = await listBuiltinPersonas();
  console.log("built-in personas:");
  for (const id of ids) {
    const p = await loadPersona(id);
    console.log(`  ${id.padEnd(12)} ${p.character.name} (${p.character.age ?? "?"}) - ${p.character.context.split("\n")[0]}`);
  }
}

function cmdHelp(): void {
  console.log(`gauntlet - persona-driven UX failure discovery

usage:
  gauntlet run <url> --personas <id[,id...]> [--steps N] [--headed]
  gauntlet list
  gauntlet help

flags:
  --personas <ids>   comma-separated persona ids (e.g. mary,devon)
  --steps <n>        number of capture steps per persona (default 1)
  --headed           run browser visibly (default headless)
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "run":
      await cmdRun(args);
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
