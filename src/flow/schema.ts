import { z } from "zod";

export const FlowStepSchema = z.object({
  intent: z
    .string()
    .describe(
      "What the persona is trying to do at this step, in their own words. 1 sentence.",
    ),
  observation_target: z
    .string()
    .optional()
    .describe(
      "What the persona is looking for or expects to see on the page before acting. Used by the action loop's observe() primitive.",
    ),
  success_criteria: z
    .string()
    .describe(
      "How the persona (and the runner) decides this step succeeded. Specific and observable.",
    ),
  give_up_criteria: z
    .array(z.string())
    .default([])
    .describe("Conditions under which the persona abandons this step."),
});

export const FlowSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, { message: "id must be lowercase kebab-case" }),
  persona_id: z.string(),
  title: z.string().describe("Short human-readable name for this flow."),
  goal: z
    .string()
    .describe(
      "The persona's overall goal for this flow, in their voice (1-2 sentences).",
    ),
  starting_url_hint: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined)
    .describe(
      "Optional hint at where the flow starts (e.g. '/pricing', 'the homepage'). Resolved against the run URL.",
    ),
  steps: z.array(FlowStepSchema).min(1).max(15),
  rationale: z
    .string()
    .describe("One sentence: why this flow stress-tests something useful."),
  feature: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined)
    .describe(
      "Single capability this flow exercises (e.g. 'checkout', 'signup', 'search'). Used by --features filter. Should match a surface.features entry when applicable.",
    ),
  tags: z
    .array(z.string())
    .default([])
    .describe(
      "Free-form labels (e.g. 'smoke', 'critical', 'mobile-only'). Used by --tags / --exclude-tags filters.",
    ),
  paths: z
    .array(z.string())
    .default([])
    .describe(
      "URL path patterns this flow exercises (e.g. '/checkout/*', '/api/cart'). Reserved for future diff-aware filtering.",
    ),
});

export type Flow = z.infer<typeof FlowSchema>;
export type FlowStep = z.infer<typeof FlowStepSchema>;
