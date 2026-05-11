import { z } from "zod";
import type { AiProvider } from "../ai/provider.ts";
import { PersonaSchema, type Persona } from "../persona/schema.ts";
import type { PersonaTemplate } from "../persona/templates.ts";
import { type ProjectContext, summarizeProject } from "./project-reader.ts";

export const PersonaCandidateSchema = PersonaSchema.extend({
  label: z.enum(["core", "edge"]),
  template_id: z.string().optional(),
  rationale: z.string().describe("One sentence: why this persona for this product."),
});
export type PersonaCandidate = z.infer<typeof PersonaCandidateSchema>;

const CandidateSetSchema = z.object({
  candidates: z.array(PersonaCandidateSchema).min(4).max(16),
});

const SYSTEM_PROMPT = `You are a UX research lead helping a developer pick a roster of personas to stress-test their product with.

You will be given:
- A product context (name, description, keywords, frameworks, optional landing page snapshot, README excerpt)
- A library of behavior templates (universal skeletons like "keyboard-only", "low-digital-confidence", etc.)

Produce a mix of CORE personas (realistic, high-frequency target users) and EDGE personas (low-frequency users who break interesting assumptions). Edge personas should each map to a template_id when one fits. Core personas can also use a template_id if relevant, or invent fresh behavior.

Rules:
- 8-12 candidates total
- At least 3 core, at least 3 edge
- Each persona must have a concrete name, age, context (1-2 sentences about who they are and what they want from THIS product specifically), and voice
- behavior.goals must be specific to THIS product, not generic
- ids must be lowercase kebab-case, unique
- rationale: one sentence explaining why this persona is a useful stress test for this product
- Output only the JSON object matching the schema; no prose.`;

export interface GenerateOptions {
  provider: AiProvider;
  project: ProjectContext;
  templates: PersonaTemplate[];
  count?: number;
  existing?: string[];
}

function templatesToPrompt(templates: PersonaTemplate[]): string {
  return templates
    .map(
      (t) =>
        `### ${t.id} (${t.label})\n${t.description.trim()}\nbehavior defaults: device=${t.behavior.device}, network=${t.behavior.network}, input=${t.behavior.input}, patience=${t.behavior.patience_threshold_seconds}s`,
    )
    .join("\n\n");
}

export async function generateCandidates(
  opts: GenerateOptions,
): Promise<PersonaCandidate[]> {
  const userPrompt = [
    `## Product context\n${summarizeProject(opts.project)}`,
    `## Behavior templates available\n${templatesToPrompt(opts.templates)}`,
    opts.existing && opts.existing.length > 0
      ? `## Already-curated persona ids (do not duplicate)\n${opts.existing.join(", ")}`
      : "",
    `## Task\nPropose ${opts.count ?? 10} persona candidates for this product. Mix core and edge as described.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await opts.provider.propose({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    schema: CandidateSetSchema,
    schemaName: "PersonaCandidateSet",
    schemaDescription:
      "Object with 'candidates' array. Each candidate has id, character{name,age,context,voice}, behavior{...}, label ('core'|'edge'), optional template_id, and rationale.",
    maxTokens: 8000,
    temperature: 0.8,
  });

  const seen = new Set(opts.existing ?? []);
  const unique: typeof result.candidates = [];
  for (const c of result.candidates) {
    if (seen.has(c.id)) continue;
    seen.add(c.id);
    unique.push(c);
  }
  return unique as PersonaCandidate[];
}

export function candidateToPersona(c: PersonaCandidate): Persona {
  return {
    id: c.id,
    character: c.character,
    behavior: c.behavior,
    ...(c.analytics_grounding !== undefined
      ? { analytics_grounding: c.analytics_grounding }
      : {}),
  };
}
