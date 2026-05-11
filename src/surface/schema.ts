import { z } from "zod";

export const SurfaceSchema = z.object({
  id: z
    .string()
    .regex(/^[a-z][a-z0-9-]*$/, { message: "id must be lowercase kebab-case" }),
  name: z.string().describe("Human-readable name, e.g. 'Marketing / Acquisition'."),
  base_url: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined)
    .describe("Production URL for this surface, when known. May be left empty until run-time."),
  audience: z
    .string()
    .describe(
      "Who lives on this surface, in one sentence. Drives persona generation.",
    ),
  features: z
    .array(z.string())
    .default([])
    .describe("Concrete capabilities visible on this surface (e.g. 'pricing', 'signup CTA', 'admin dashboard')."),
  excluded_features: z
    .array(z.string())
    .default([])
    .describe(
      "Capabilities a user might EXPECT but that don't live here (e.g. tenant portfolios don't show platform pricing).",
    ),
  notes: z.string().optional(),
});

export type Surface = z.infer<typeof SurfaceSchema>;
