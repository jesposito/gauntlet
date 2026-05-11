import { readFile, readdir, stat } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { PersonaSchema, type Persona } from "./schema.ts";

const LIBRARY_DIR = join(dirname(fileURLToPath(import.meta.url)), "library");
const CURATED_DIR_NAME = ".gauntlet/personas";

async function exists(path: string): Promise<boolean> {
  try {
    await stat(path);
    return true;
  } catch {
    return false;
  }
}

async function readAndParse(path: string): Promise<Persona> {
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return PersonaSchema.parse(parsed);
}

export async function loadPersona(idOrPath: string, cwd: string = process.cwd()): Promise<Persona> {
  if (idOrPath.endsWith(".yaml") || idOrPath.endsWith(".yml")) {
    return readAndParse(idOrPath);
  }
  const curated = join(cwd, CURATED_DIR_NAME, `${idOrPath}.yaml`);
  if (await exists(curated)) {
    return readAndParse(curated);
  }
  return readAndParse(join(LIBRARY_DIR, `${idOrPath}.yaml`));
}

export async function listBuiltinPersonas(): Promise<string[]> {
  const entries = await readdir(LIBRARY_DIR);
  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}

export async function listCuratedPersonas(cwd: string = process.cwd()): Promise<string[]> {
  const dir = join(cwd, CURATED_DIR_NAME);
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
