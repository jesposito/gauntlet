import { readFile, readdir, writeFile, mkdir } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ZodError } from "zod";
import { FlowSchema, type Flow } from "./schema.ts";

const FLOWS_DIR_NAME = ".gauntlet/flows";

export function flowsDir(cwd: string = process.cwd()): string {
  return join(cwd, FLOWS_DIR_NAME);
}

/**
 * Diagnostic returned for a flow yaml that exists on disk but failed to
 * parse or validate. Distinct from "directory missing" (legitimate empty
 * state) — the operator hand-edited a flow and broke it, and they need to
 * know which file + why instead of seeing a silent "no flows".
 */
export interface FlowLoadDiagnostic {
  type: "flow-load-error";
  flowId: string;
  path: string;
  reason: string;
}

export async function listFlows(cwd: string = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(flowsDir(cwd));
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    // Directory missing = legitimate empty state (fresh project).
    return [];
  }
}

export async function loadFlow(id: string, cwd: string = process.cwd()): Promise<Flow> {
  const path = join(flowsDir(cwd), `${id}.yaml`);
  const raw = await readFile(path, "utf8");
  return FlowSchema.parse(parseYaml(raw));
}

/**
 * Format a Zod or yaml-parse failure into a single human-readable line that
 * names the field path and includes the underlying message. Operators
 * editing yaml by hand need this to find their typo.
 */
export function formatLoadError(err: unknown): string {
  if (err instanceof ZodError) {
    const issues = err.issues
      .slice(0, 3)
      .map((i) => `${i.path.join(".") || "<root>"}: ${i.message}`)
      .join("; ");
    const more = err.issues.length > 3 ? ` (+${err.issues.length - 3} more)` : "";
    return `schema validation failed — ${issues}${more}`;
  }
  if (err instanceof Error) return err.message;
  return String(err);
}

/**
 * Load every flow whose file exists in the flows directory and whose
 * `persona_id` matches. Returns the structured diagnostic list separately so
 * the CLI can decide whether to print warnings or fail the command (e.g.
 * when the operator targeted a specific broken flow with `--flows`).
 *
 * Behavior:
 * - Missing directory → `{ flows: [], diagnostics: [] }` (silent — not an error).
 * - Each yaml file is parsed; failures become diagnostics, not throws.
 */
export async function loadFlowsForPersona(
  personaId: string,
  cwd: string = process.cwd(),
): Promise<Flow[]> {
  const { flows } = await loadFlowsForPersonaWithDiagnostics(personaId, cwd);
  return flows;
}

export async function loadFlowsForPersonaWithDiagnostics(
  personaId: string,
  cwd: string = process.cwd(),
): Promise<{ flows: Flow[]; diagnostics: FlowLoadDiagnostic[] }> {
  const ids = await listFlows(cwd);
  const flows: Flow[] = [];
  const diagnostics: FlowLoadDiagnostic[] = [];
  for (const id of ids) {
    let flow: Flow;
    try {
      flow = await loadFlow(id, cwd);
    } catch (err) {
      diagnostics.push({
        type: "flow-load-error",
        flowId: id,
        path: join(flowsDir(cwd), `${id}.yaml`),
        reason: formatLoadError(err),
      });
      continue;
    }
    if (flow.persona_id === personaId) flows.push(flow);
  }
  return { flows, diagnostics };
}

export async function writeFlow(flow: Flow, cwd: string = process.cwd()): Promise<string> {
  const dir = flowsDir(cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${flow.id}.yaml`);
  await writeFile(path, stringifyYaml(flow), "utf8");
  return path;
}
