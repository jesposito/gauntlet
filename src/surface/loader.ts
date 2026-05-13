import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { ZodError } from "zod";
import { SurfaceSchema, type Surface } from "./schema.ts";

const SURFACES_DIR_NAME = ".gauntlet/surfaces";

export function surfacesDir(cwd: string = process.cwd()): string {
  return join(cwd, SURFACES_DIR_NAME);
}

/**
 * Diagnostic returned for a surface yaml that exists on disk but failed to
 * parse or validate. See FlowLoadDiagnostic — same rationale.
 */
export interface SurfaceLoadDiagnostic {
  type: "surface-load-error";
  surfaceId: string;
  path: string;
  reason: string;
}

export async function listSurfaces(cwd: string = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(surfacesDir(cwd));
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    // Directory missing = legitimate empty state (fresh project).
    return [];
  }
}

export async function loadSurface(id: string, cwd: string = process.cwd()): Promise<Surface> {
  const path = join(surfacesDir(cwd), `${id}.yaml`);
  const raw = await readFile(path, "utf8");
  return SurfaceSchema.parse(parseYaml(raw));
}

/**
 * Format a Zod or yaml-parse failure into a single human-readable line.
 * Operators editing yaml by hand need the field path to find their typo.
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
 * Load every surface yaml. Failures are surfaced as structured diagnostics
 * rather than swallowed — callers can decide whether to warn or hard-fail.
 *
 * Behavior:
 * - Missing directory → `{ surfaces: [], diagnostics: [] }` (silent).
 * - Each yaml file is parsed; failures become diagnostics, not throws.
 */
export async function loadAllSurfaces(cwd: string = process.cwd()): Promise<Surface[]> {
  const { surfaces } = await loadAllSurfacesWithDiagnostics(cwd);
  return surfaces;
}

export async function loadAllSurfacesWithDiagnostics(
  cwd: string = process.cwd(),
): Promise<{ surfaces: Surface[]; diagnostics: SurfaceLoadDiagnostic[] }> {
  const ids = await listSurfaces(cwd);
  const surfaces: Surface[] = [];
  const diagnostics: SurfaceLoadDiagnostic[] = [];
  for (const id of ids) {
    try {
      surfaces.push(await loadSurface(id, cwd));
    } catch (err) {
      diagnostics.push({
        type: "surface-load-error",
        surfaceId: id,
        path: join(surfacesDir(cwd), `${id}.yaml`),
        reason: formatLoadError(err),
      });
      continue;
    }
  }
  return { surfaces, diagnostics };
}

export async function writeSurface(s: Surface, cwd: string = process.cwd()): Promise<string> {
  const dir = surfacesDir(cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${s.id}.yaml`);
  await writeFile(path, stringifyYaml(s), "utf8");
  return path;
}
