import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { FlowSchema, type Flow } from "./schema.ts";

const FLOWS_DIR_NAME = ".gauntlet/flows";

export function flowsDir(cwd: string = process.cwd()): string {
  return join(cwd, FLOWS_DIR_NAME);
}

export async function listFlows(cwd: string = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(flowsDir(cwd));
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export async function loadFlow(id: string, cwd: string = process.cwd()): Promise<Flow> {
  const path = join(flowsDir(cwd), `${id}.yaml`);
  const raw = await readFile(path, "utf8");
  return FlowSchema.parse(parseYaml(raw));
}

export async function loadFlowsForPersona(
  personaId: string,
  cwd: string = process.cwd(),
): Promise<Flow[]> {
  const ids = await listFlows(cwd);
  const flows: Flow[] = [];
  for (const id of ids) {
    let flow: Flow;
    try {
      flow = await loadFlow(id, cwd);
    } catch {
      continue;
    }
    if (flow.persona_id === personaId) flows.push(flow);
  }
  return flows;
}

export async function writeFlow(flow: Flow, cwd: string = process.cwd()): Promise<string> {
  const dir = flowsDir(cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${flow.id}.yaml`);
  await writeFile(path, stringifyYaml(flow), "utf8");
  return path;
}
