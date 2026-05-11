import { z } from "zod";
import type { AiProvider } from "../ai/provider.ts";
import { PersonaSchema, type Persona } from "../persona/schema.ts";
import type { PersonaTemplate } from "../persona/templates.ts";
import { type ProjectContext, summarizeProject } from "./project-reader.ts";
import type { Surface } from "../surface/schema.ts";

export const PersonaCandidateSchema = PersonaSchema.extend({
  label: z.enum(["core", "edge"]),
  template_id: z.string().optional(),
  rationale: z.string().describe("One sentence: why this persona for this product."),
});
export type PersonaCandidate = z.infer<typeof PersonaCandidateSchema>;

const CandidateSetSchema = z.object({
  candidates: z.array(PersonaCandidateSchema).min(4).max(16),
});

const SCHEMA_EXAMPLE = `{
  "candidates": [
    {
      "id": "kebab-case-id",
      "label": "core" | "edge",
      "template_id": "low-digital-confidence",
      "surface": "marketing",
      "rationale": "One sentence: why this persona is a useful stress test for this product.",
      "character": {
        "name": "Full Name",
        "age": 34,
        "context": "1-2 sentences: who they are and what they want from THIS product.",
        "voice": "How they talk when frustrated or pleased.",
        "personality": {
          "openness": 60,
          "conscientiousness": 75,
          "extraversion": 40,
          "agreeableness": 65,
          "neuroticism": 55
        }
      },
      "behavior": {
        "goals": ["Concrete task 1 specific to this product", "Concrete task 2"],
        "device": "desktop" | "laptop" | "tablet" | "mobile",
        "viewport": { "width": 1440, "height": 900 },
        "network": "fast-fiber" | "home-wifi" | "slow-3g" | "fast-3g" | "offline-flaky",
        "input": "mouse" | "touch" | "keyboard-only" | "screen-reader",
        "patience_threshold_seconds": 30,
        "reading_level": "3rd_grade" | "6th_grade" | "9th_grade" | "college",
        "avoids": ["modals", "..."],
        "abandons_on": ["..."],
        "prefers": ["..."]
      }
    }
  ]
}`;

const SYSTEM_PROMPT = `You are a UX research lead helping a developer pick a roster of personas to stress-test their product with.

You will be given:
- A product context (name, description, keywords, frameworks, optional landing page snapshot, README excerpt)
- The product's curated SURFACES (marketing page, app, customer-facing tenant pages, admin, etc.) — each with a distinct audience
- A library of behavior templates (universal skeletons like "keyboard-only", "low-digital-confidence", etc.)

Produce a mix of CORE personas (realistic, high-frequency target users) and EDGE personas (low-frequency users who break interesting assumptions). Edge personas should each map to a template_id when one fits. Core personas can also use a template_id if relevant, or invent fresh behavior.

CRITICAL: every persona belongs to exactly ONE surface. Their goals, voice, and behaviors must be consistent with that surface's audience. Do NOT have a "skeptical signup shopper" looking at a customer's portfolio — they belong on the marketing surface.

Rules:
- For each surface, produce 2-4 personas (mix of core + edge as appropriate to the audience)
- Total: 8-12 candidates across all surfaces, with at least 1 edge persona per surface where it makes sense
- Each persona must have a concrete name, age, context (1-2 sentences about who they are and what they want from THIS surface specifically), and voice
- Each persona MUST set the 'surface' field to the id of one of the provided surfaces
- Include a personality (Big Five / OCEAN) profile with each axis 0-100. Make the axes consistent with the persona: e.g. a power-user-fuzzer is high openness + low agreeableness; a low-digital-confidence retiree is low openness + high neuroticism
- behavior.goals must be specific to that SURFACE on this product, not generic
- ids must be lowercase kebab-case, unique
- rationale: one sentence explaining why this persona is a useful stress test for that surface
- Output ONLY a JSON object exactly matching the schema below; no prose, no markdown fences.

CRITICAL: field names must match EXACTLY. Required behavior fields:
goals, device, viewport (with width and height), network, input,
patience_threshold_seconds (NOT "patience_seconds"), reading_level, avoids,
abandons_on, prefers.

Example shape:
${SCHEMA_EXAMPLE}`;

export interface GenerateOptions {
  provider: AiProvider;
  project: ProjectContext;
  templates: PersonaTemplate[];
  surfaces?: Surface[];
  count?: number;
  existing?: string[];
}

function surfacesToPrompt(surfaces: Surface[]): string {
  return surfaces
    .map(
      (s) =>
        `### ${s.id} — ${s.name}\n  audience: ${s.audience}\n  base_url: ${s.base_url ?? "(unset)"}\n  features: ${s.features.join(", ") || "(none listed)"}\n  excluded_features: ${s.excluded_features.join(", ") || "(none listed)"}`,
    )
    .join("\n\n");
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
  const surfaces = opts.surfaces ?? [];
  const surfaceList = surfaces.length > 0 ? surfaces.map((s) => s.id).join(", ") : "(none)";
  const userPrompt = [
    `## Product context\n${summarizeProject(opts.project)}`,
    surfaces.length > 0 ? `## Surfaces (assign each persona to one)\n${surfacesToPrompt(surfaces)}` : "",
    `## Behavior templates available\n${templatesToPrompt(opts.templates)}`,
    opts.existing && opts.existing.length > 0
      ? `## Already-curated persona ids (do not duplicate)\n${opts.existing.join(", ")}`
      : "",
    surfaces.length > 0
      ? `## Task\nPropose ${opts.count ?? 10} persona candidates. Assign each to one of these surfaces: ${surfaceList}. Distribute across surfaces; do not put them all on one.`
      : `## Task\nPropose ${opts.count ?? 10} persona candidates for this product. Mix core and edge as described.`,
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
    ...(c.surface !== undefined ? { surface: c.surface } : {}),
    ...(c.analytics_grounding !== undefined
      ? { analytics_grounding: c.analytics_grounding }
      : {}),
  };
}
