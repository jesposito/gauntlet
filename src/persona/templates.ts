import { readdir, readFile } from "node:fs/promises";
import { join, dirname } from "node:path";
import { fileURLToPath } from "node:url";
import { parse as parseYaml } from "yaml";
import { z } from "zod";
import { BehaviorSchema } from "./schema.ts";

const TEMPLATES_DIR = join(dirname(fileURLToPath(import.meta.url)), "templates");

const PartialBehaviorSchema = BehaviorSchema.partial().extend({
  device: BehaviorSchema.shape.device,
  viewport: BehaviorSchema.shape.viewport,
  network: BehaviorSchema.shape.network,
  input: BehaviorSchema.shape.input,
  patience_threshold_seconds: BehaviorSchema.shape.patience_threshold_seconds,
});

export const TemplateSchema = z.object({
  id: z.string(),
  label: z.enum(["core", "edge"]),
  description: z.string(),
  behavior: PartialBehaviorSchema,
});

export type PersonaTemplate = z.infer<typeof TemplateSchema>;

export async function loadTemplates(): Promise<PersonaTemplate[]> {
  const entries = await readdir(TEMPLATES_DIR);
  const templates: PersonaTemplate[] = [];
  for (const entry of entries) {
    if (!entry.endsWith(".yaml") && !entry.endsWith(".yml")) continue;
    const raw = await readFile(join(TEMPLATES_DIR, entry), "utf8");
    const parsed = parseYaml(raw);
    templates.push(TemplateSchema.parse(parsed));
  }
  return templates.sort((a, b) => a.id.localeCompare(b.id));
}
