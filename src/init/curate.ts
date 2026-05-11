import { mkdir, readFile, readdir, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { PersonaSchema, type Persona } from "../persona/schema.ts";
import {
  candidateToPersona,
  type PersonaCandidate,
} from "./persona-generator.ts";

export const PERSONAS_DIR_NAME = ".gauntlet/personas";

export interface CurationContext {
  cwd: string;
  regenerate: (slotId: string) => Promise<PersonaCandidate | undefined>;
}

export interface CurationResult {
  accepted: Persona[];
  rejected: string[];
  edited: string[];
}

function readLine(prompt: string): Promise<string> {
  return new Promise((resolve) => {
    process.stdout.write(prompt);
    const onData = (chunk: Buffer): void => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve(chunk.toString("utf8").trim());
    };
    process.stdin.resume();
    process.stdin.once("data", onData);
  });
}

async function editorEdit(persona: Persona): Promise<Persona | undefined> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const tmp = join(tmpdir(), `gauntlet-${persona.id}-${Date.now()}.yaml`);
  await writeFile(tmp, stringifyYaml(persona), "utf8");
  const proc = Bun.spawn([editor, tmp], {
    stdin: "inherit",
    stdout: "inherit",
    stderr: "inherit",
  });
  const code = await proc.exited;
  if (code !== 0) {
    console.log(`editor exited ${code}; discarding edit.`);
    await unlink(tmp).catch(() => undefined);
    return undefined;
  }
  const raw = await readFile(tmp, "utf8");
  await unlink(tmp).catch(() => undefined);
  try {
    const parsed = parseYaml(raw);
    return PersonaSchema.parse(parsed);
  } catch (err) {
    console.error(`invalid YAML or schema: ${(err as Error).message}`);
    return undefined;
  }
}

function printCandidate(c: PersonaCandidate, idx: number, total: number): void {
  const label = c.label === "edge" ? "[edge]" : "[core]";
  console.log(`\n--- candidate ${idx + 1}/${total} ${label} ${c.id} ---`);
  console.log(`${c.character.name}, ${c.character.age ?? "?"}`);
  console.log(`context: ${c.character.context.trim()}`);
  console.log(`voice: ${c.character.voice.trim()}`);
  console.log(
    `device=${c.behavior.device} network=${c.behavior.network} input=${c.behavior.input} viewport=${c.behavior.viewport.width}x${c.behavior.viewport.height}`,
  );
  console.log(`goals:`);
  for (const g of c.behavior.goals) console.log(`  - ${g}`);
  if (c.template_id) console.log(`template: ${c.template_id}`);
  console.log(`rationale: ${c.rationale}`);
}

async function writePersona(cwd: string, persona: Persona): Promise<string> {
  const dir = join(cwd, PERSONAS_DIR_NAME);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${persona.id}.yaml`);
  await writeFile(path, stringifyYaml(persona), "utf8");
  return path;
}

export async function listCuratedIds(cwd: string): Promise<string[]> {
  const dir = join(cwd, PERSONAS_DIR_NAME);
  try {
    const entries = await readdir(dir);
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

async function writeMyOwn(): Promise<Persona | undefined> {
  const id = (await readLine("new persona id (kebab-case): ")).trim();
  if (!id) return undefined;
  const stub: Persona = {
    id,
    character: {
      name: "",
      context: "",
      voice: "",
    },
    behavior: {
      goals: [""],
      device: "laptop",
      viewport: { width: 1440, height: 900 },
      network: "home-wifi",
      input: "mouse",
      patience_threshold_seconds: 30,
      reading_level: "9th_grade",
      avoids: [],
      abandons_on: [],
      prefers: [],
    },
  };
  console.log("opening editor for new persona...");
  return editorEdit(stub);
}

export async function curate(
  candidates: PersonaCandidate[],
  ctx: CurationContext,
): Promise<CurationResult> {
  const accepted: Persona[] = [];
  const rejected: string[] = [];
  const edited: string[] = [];

  console.log(`\ngot ${candidates.length} candidates. curate one at a time.`);
  console.log("actions: [a]ccept [r]eject [e]dit [g]enerate-again [w]rite-my-own [q]uit");

  const queue = [...candidates];
  let idx = 0;
  const total = queue.length;

  while (queue.length > 0) {
    const c = queue.shift()!;
    printCandidate(c, idx++, total);
    let decided = false;
    while (!decided) {
      const action = (await readLine("\n[a/r/e/g/w/q]? ")).toLowerCase();
      switch (action) {
        case "a":
        case "accept": {
          const persona = candidateToPersona(c);
          const path = await writePersona(ctx.cwd, persona);
          accepted.push(persona);
          console.log(`accepted -> ${path}`);
          decided = true;
          break;
        }
        case "r":
        case "reject":
          rejected.push(c.id);
          console.log(`rejected ${c.id}`);
          decided = true;
          break;
        case "e":
        case "edit": {
          const base = candidateToPersona(c);
          const edit = await editorEdit(base);
          if (edit) {
            const path = await writePersona(ctx.cwd, edit);
            accepted.push(edit);
            edited.push(edit.id);
            console.log(`accepted (edited) -> ${path}`);
            decided = true;
          } else {
            console.log("edit cancelled; choose again.");
          }
          break;
        }
        case "g":
        case "regen": {
          const fresh = await ctx.regenerate(c.id);
          if (fresh) {
            queue.unshift(fresh);
            console.log("regenerated; replaces this slot.");
            idx--;
            decided = true;
          } else {
            console.log("regenerate failed; choose again.");
          }
          break;
        }
        case "w":
        case "write": {
          const persona = await writeMyOwn();
          if (persona) {
            const path = await writePersona(ctx.cwd, persona);
            accepted.push(persona);
            console.log(`accepted (custom) -> ${path}`);
          }
          break;
        }
        case "q":
        case "quit":
          console.log("quitting curation; remaining candidates dropped.");
          return { accepted, rejected, edited };
        default:
          console.log("unknown action. try a/r/e/g/w/q.");
      }
    }
  }

  return { accepted, rejected, edited };
}
