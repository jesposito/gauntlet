import { z } from "zod";
import type { AiProvider } from "../ai/provider.ts";
import type { Persona } from "../persona/schema.ts";
import { FlowSchema, type Flow } from "../flow/schema.ts";
import { type ProjectContext, summarizeProject } from "./project-reader.ts";
import type { Surface } from "../surface/schema.ts";

const FlowSetSchema = z.object({
  flows: z.array(FlowSchema).min(1).max(6),
});

const SCHEMA_EXAMPLE = `{
  "flows": [
    {
      "id": "<persona-id>--kebab-case-flow-id",
      "persona_id": "<persona-id>",
      "title": "Short name",
      "goal": "1-2 sentences in the persona's voice describing what they want.",
      "starting_url_hint": "/pricing" | "homepage" | null,
      "steps": [
        {
          "intent": "What the persona is trying to do at this step, 1 sentence.",
          "observation_target": "What they're looking for on the page before they act.",
          "success_criteria": "Observable signal that this step succeeded.",
          "give_up_criteria": ["condition 1", "condition 2"]
        }
      ],
      "rationale": "One sentence: why this flow stress-tests something useful.",
      "feature": "checkout" | null,
      "tags": ["smoke", "critical"],
      "paths": ["/checkout/*", "/cart"]
    }
  ]
}`;

const SYSTEM_PROMPT = `You are a UX research lead designing test flows for a curated persona.

You will be given:
- A product context (name, description, frameworks, optional landing snapshot, README excerpt)
- A single persona (character + behavior + goals + things they avoid or abandon on)

For this persona, propose 2-4 flows they would realistically attempt on this product. A flow is a short ordered sequence of steps the persona would try. Each step must have:
- intent: what the persona is trying to do, in their own words, one sentence
- observation_target: what they're looking for on the page before acting (used by the runner's observe() primitive)
- success_criteria: an observable signal that the step succeeded
- give_up_criteria: 1-3 OBSERVABLE blocker conditions, not personality grumbles. Good: "form does not accept email without phone number", "no Sign-out link visible after 3 nav levels", "submit button is disabled and no error explains why". Bad: "the page feels cluttered", "the brand voice is corporate", "I am impatient". The step judge requires concrete evidence for give_up — purely subjective criteria are ignored and the persona gets stuck running in_progress until the flow runs out of steps.

Rules:
- ids: kebab-case, prefixed "<persona-id>--<flow-id>" (e.g. "mary--save-chicken-recipe")
- 3-8 steps per flow; favor short focused flows over long ones
- Flow content must reflect the persona's character, voice, and constraints. A keyboard-only persona never says "click"; they say "tab to" or "activate". A low-reading-level persona scans for verbs, not labels.
- Mix flow types where it makes sense: at least one happy-path flow, at least one stress-test flow (the persona tries something this product probably mishandles).
- Set "feature" to exactly one capability the flow exercises. When the surface section lists features, pick from that list. When unsure, omit the field rather than guess.
- "tags" is free-form. Always tag the obvious happy-path as ["smoke"] and the stress-test as ["edge"]. Add "critical" only if a failure here blocks the persona's core goal.
- "paths" is optional URL path patterns the flow plausibly visits. Use globs ("/checkout/*"). Omit if you cannot infer them from the product context.
- Output ONLY a JSON object exactly matching the schema below. No prose, no markdown fences.

Example shape:
${SCHEMA_EXAMPLE}`;

export interface GenerateFlowsOptions {
  provider: AiProvider;
  project: ProjectContext;
  persona: Persona;
  surface?: Surface;
  count?: number;
  /**
   * Optional user-supplied directive. When set, the flows for this persona
   * should over-index on attempting the named area. Persona's goals still
   * lead — focus is a steering hint, not an override.
   */
  focus?: string;
}

function personaToPrompt(persona: Persona): string {
  const lines: string[] = [];
  lines.push(`### Persona: ${persona.id}`);
  lines.push(
    `${persona.character.name}, ${persona.character.age ?? "?"} — ${persona.character.context.trim()}`,
  );
  lines.push(`Voice: ${persona.character.voice.trim()}`);
  if (persona.character.personality) {
    const p = persona.character.personality;
    lines.push(
      `OCEAN: O=${p.openness} C=${p.conscientiousness} E=${p.extraversion} A=${p.agreeableness} N=${p.neuroticism}`,
    );
  }
  lines.push(
    `Behavior: device=${persona.behavior.device}, viewport=${persona.behavior.viewport.width}x${persona.behavior.viewport.height}, network=${persona.behavior.network}, input=${persona.behavior.input}, reading_level=${persona.behavior.reading_level}, patience=${persona.behavior.patience_threshold_seconds}s`,
  );
  lines.push(`Goals:\n- ${persona.behavior.goals.join("\n- ")}`);
  if (persona.behavior.avoids.length > 0)
    lines.push(`Avoids: ${persona.behavior.avoids.join(", ")}`);
  if (persona.behavior.abandons_on.length > 0)
    lines.push(`Abandons on: ${persona.behavior.abandons_on.join(", ")}`);
  if (persona.behavior.prefers.length > 0)
    lines.push(`Prefers: ${persona.behavior.prefers.join(", ")}`);
  return lines.join("\n");
}

export async function generateFlows(opts: GenerateFlowsOptions): Promise<Flow[]> {
  const surfaceBlock = opts.surface
    ? `## Surface this persona lives on
id: ${opts.surface.id}
name: ${opts.surface.name}
base_url: ${opts.surface.base_url ?? "(unset)"}
audience: ${opts.surface.audience}
features available: ${opts.surface.features.join(", ") || "(none listed)"}
NOT available on this surface: ${opts.surface.excluded_features.join(", ") || "(none listed)"}

DO NOT propose flows that reference features in "NOT available". The persona cannot find what isn't there.`
    : "";

  const focus = opts.focus?.trim();
  const userPrompt = [
    `## Product context\n${summarizeProject(opts.project)}`,
    surfaceBlock,
    `## Persona\n${personaToPrompt(opts.persona)}`,
    focus
      ? `## Focus directive (from operator)\nThe operator wants extra coverage on: ${focus}\nWhere this persona's own goals plausibly intersect with the focus area, prefer a flow that exercises it. Do not invent flows the persona would never attempt just to hit the focus — persona realism wins ties.`
      : "",
    `## Task\nPropose ${opts.count ?? 3} flows this persona would attempt on this surface.`,
  ]
    .filter(Boolean)
    .join("\n\n");

  const result = await opts.provider.propose({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    schema: FlowSetSchema,
    schemaName: "FlowSet",
    schemaDescription:
      "Object with 'flows' array. Each flow has id, persona_id, title, goal, optional starting_url_hint, steps[], rationale.",
    maxTokens: 6000,
    temperature: 0.7,
    purpose: "flow_gen",
  });

  return result.flows.map((f) => ({ ...f, persona_id: opts.persona.id })) as Flow[];
}
