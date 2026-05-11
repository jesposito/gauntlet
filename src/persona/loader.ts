import { readFile, readdir } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { PersonaSchema, type Persona } from "./schema.ts";

const LIBRARY_DIR = join(dirname(fileURLToPath(import.meta.url)), "library");

export async function loadPersona(idOrPath: string): Promise<Persona> {
  const path = idOrPath.endsWith(".yaml") || idOrPath.endsWith(".yml")
    ? idOrPath
    : join(LIBRARY_DIR, `${idOrPath}.yaml`);
  const raw = await readFile(path, "utf8");
  const parsed = parseYaml(raw);
  return PersonaSchema.parse(parsed);
}

export async function listBuiltinPersonas(): Promise<string[]> {
  const entries = await readdir(LIBRARY_DIR);
  return entries
    .filter((f) => f.endsWith(".yaml") || f.endsWith(".yml"))
    .map((f) => f.replace(/\.ya?ml$/, ""))
    .sort();
}
