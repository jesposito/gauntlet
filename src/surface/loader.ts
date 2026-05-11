import { mkdir, readdir, readFile, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { parse as parseYaml, stringify as stringifyYaml } from "yaml";
import { SurfaceSchema, type Surface } from "./schema.ts";

const SURFACES_DIR_NAME = ".gauntlet/surfaces";

export function surfacesDir(cwd: string = process.cwd()): string {
  return join(cwd, SURFACES_DIR_NAME);
}

export async function listSurfaces(cwd: string = process.cwd()): Promise<string[]> {
  try {
    const entries = await readdir(surfacesDir(cwd));
    return entries
      .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
      .map((f) => f.replace(/\.ya?ml$/, ""))
      .sort();
  } catch {
    return [];
  }
}

export async function loadSurface(id: string, cwd: string = process.cwd()): Promise<Surface> {
  const path = join(surfacesDir(cwd), `${id}.yaml`);
  const raw = await readFile(path, "utf8");
  return SurfaceSchema.parse(parseYaml(raw));
}

export async function loadAllSurfaces(cwd: string = process.cwd()): Promise<Surface[]> {
  const ids = await listSurfaces(cwd);
  const out: Surface[] = [];
  for (const id of ids) {
    try {
      out.push(await loadSurface(id, cwd));
    } catch {
      continue;
    }
  }
  return out;
}

export async function writeSurface(s: Surface, cwd: string = process.cwd()): Promise<string> {
  const dir = surfacesDir(cwd);
  await mkdir(dir, { recursive: true });
  const path = join(dir, `${s.id}.yaml`);
  await writeFile(path, stringifyYaml(s), "utf8");
  return path;
}
