import { z } from "zod";

export const DeviceSchema = z.enum([
  "desktop",
  "laptop",
  "tablet",
  "mobile",
]);

export const NetworkSchema = z.enum([
  "fast-fiber",
  "home-wifi",
  "slow-3g",
  "fast-3g",
  "offline-flaky",
]);

export const InputSchema = z.enum([
  "mouse",
  "touch",
  "keyboard-only",
  "screen-reader",
]);

export const OceanSchema = z
  .object({
    openness: z.number().int().min(0).max(100),
    conscientiousness: z.number().int().min(0).max(100),
    extraversion: z.number().int().min(0).max(100),
    agreeableness: z.number().int().min(0).max(100),
    neuroticism: z.number().int().min(0).max(100),
  })
  .describe(
    "Big Five (OCEAN) personality profile, 0-100 per axis. Shapes voice and abandonment behavior.",
  );

export const CharacterSchema = z.object({
  name: z.string(),
  age: z.number().int().positive().optional(),
  context: z
    .string()
    .describe(
      "Who they are, what they're trying to do, what they care about. Used for in-character narration.",
    ),
  voice: z
    .string()
    .describe(
      "How they speak when frustrated or pleased. Used to shape the report quote tone.",
    ),
  personality: OceanSchema.optional(),
});

export const BehaviorSchema = z.object({
  goals: z
    .array(z.string())
    .min(1)
    .describe("Concrete tasks the persona is trying to accomplish."),
  device: DeviceSchema,
  viewport: z
    .object({ width: z.number().int(), height: z.number().int() })
    .describe("Browser viewport in CSS pixels."),
  network: NetworkSchema,
  input: InputSchema,
  patience_threshold_seconds: z
    .number()
    .positive()
    .describe(
      "Total time before they give up if no visible progress on current goal.",
    ),
  reading_level: z
    .enum(["3rd_grade", "6th_grade", "9th_grade", "college"])
    .default("9th_grade"),
  avoids: z.array(z.string()).default([]),
  abandons_on: z.array(z.string()).default([]),
  prefers: z.array(z.string()).default([]),
});

export const PersonaSchema = z.object({
  id: z.string().regex(/^[a-z][a-z0-9-]*$/, {
    message: "id must be lowercase kebab-case",
  }),
  character: CharacterSchema,
  behavior: BehaviorSchema,
  analytics_grounding: z
    .string()
    .optional()
    .describe("Path to project-specific analytics/support data."),
});

export type Persona = z.infer<typeof PersonaSchema>;
export type Character = z.infer<typeof CharacterSchema>;
export type Behavior = z.infer<typeof BehaviorSchema>;
export type Device = z.infer<typeof DeviceSchema>;
export type Network = z.infer<typeof NetworkSchema>;
export type Input = z.infer<typeof InputSchema>;
export type Ocean = z.infer<typeof OceanSchema>;
