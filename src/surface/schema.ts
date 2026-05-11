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
  requires_auth: z
    .boolean()
    .optional()
    .default(false)
    .describe(
      "True when this surface sits behind a login wall. Surface generator infers this from landing-page hints (login redirect, 401/403, password input).",
    ),
  auth_state: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined)
    .describe(
      "Relative path to a Playwright storageState JSON (cookies + localStorage). Populated by `gauntlet auth <surface>`. Loaded by the runner before navigation.",
    ),
  login_url: z
    .string()
    .nullable()
    .optional()
    .transform((v) => v ?? undefined)
    .describe(
      "Where the user goes to sign in. Used by `gauntlet auth` as the default landing URL.",
    ),
  notes: z.string().optional(),
});

export type Surface = z.infer<typeof SurfaceSchema>;
