import { readFile, writeFile, unlink } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { stringify as stringifyYaml, parse as parseYaml } from "yaml";
import { FlowSchema, type Flow } from "../flow/schema.ts";
import { writeFlow } from "../flow/loader.ts";

export interface FlowCurationResult {
  accepted: Flow[];
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

async function editorEdit(flow: Flow): Promise<Flow | undefined> {
  const editor = process.env.EDITOR ?? process.env.VISUAL ?? "vi";
  const tmp = join(tmpdir(), `gauntlet-flow-${flow.id}-${Date.now()}.yaml`);
  await writeFile(tmp, stringifyYaml(flow), "utf8");
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
    return FlowSchema.parse(parseYaml(raw));
  } catch (err) {
    console.error(`invalid YAML or schema: ${(err as Error).message}`);
    return undefined;
  }
}

function printFlow(f: Flow, idx: number, total: number): void {
  console.log(`\n--- flow ${idx + 1}/${total} ${f.id} ---`);
  console.log(`title: ${f.title}`);
  console.log(`goal:  ${f.goal.trim()}`);
  if (f.starting_url_hint) console.log(`start: ${f.starting_url_hint}`);
  console.log(`steps (${f.steps.length}):`);
  for (const [i, s] of f.steps.entries()) {
    console.log(`  ${i + 1}. ${s.intent}`);
    if (s.observation_target) console.log(`     looking for: ${s.observation_target}`);
    console.log(`     succeeds when: ${s.success_criteria}`);
    if (s.give_up_criteria.length > 0)
      console.log(`     gives up if: ${s.give_up_criteria.join("; ")}`);
  }
  console.log(`rationale: ${f.rationale}`);
}

export interface FlowCurationContext {
  cwd: string;
  regenerate: () => Promise<Flow[]>;
}

export async function curateFlows(
  flows: Flow[],
  ctx: FlowCurationContext,
): Promise<FlowCurationResult> {
  const accepted: Flow[] = [];
  const rejected: string[] = [];
  const edited: string[] = [];

  console.log(`\n${flows.length} flow${flows.length === 1 ? "" : "s"} to curate.`);
  console.log("actions: [a]ccept [r]eject [e]dit [g]enerate-again [s]kip-rest");

  const queue = [...flows];
  let idx = 0;
  const total = queue.length;

  while (queue.length > 0) {
    const f = queue.shift()!;
    printFlow(f, idx++, total);
    let decided = false;
    while (!decided) {
      const action = (await readLine("\n[a/r/e/g/s]? ")).toLowerCase();
      switch (action) {
        case "a":
        case "accept": {
          const path = await writeFlow(f, ctx.cwd);
          accepted.push(f);
          console.log(`accepted -> ${path}`);
          decided = true;
          break;
        }
        case "r":
        case "reject":
          rejected.push(f.id);
          console.log(`rejected ${f.id}`);
          decided = true;
          break;
        case "e":
        case "edit": {
          const edit = await editorEdit(f);
          if (edit) {
            const path = await writeFlow(edit, ctx.cwd);
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
          const fresh = await ctx.regenerate();
          if (fresh.length > 0) {
            queue.unshift(...fresh);
            idx--;
            console.log(`regenerated ${fresh.length} flow${fresh.length === 1 ? "" : "s"}.`);
            decided = true;
          } else {
            console.log("regenerate returned nothing; choose again.");
          }
          break;
        }
        case "s":
        case "skip":
          console.log("skipping remaining flows for this persona.");
          return { accepted, rejected, edited };
        default:
          console.log("unknown action. try a/r/e/g/s.");
      }
    }
  }

  return { accepted, rejected, edited };
}
