import { z } from "zod";
import type { AiProvider } from "../ai/provider.ts";
import { SurfaceSchema, type Surface } from "../surface/schema.ts";
import { type ProjectContext, summarizeProject } from "./project-reader.ts";

const SurfaceSetSchema = z.object({
  surfaces: z.array(SurfaceSchema).min(1).max(8),
});

const SCHEMA_EXAMPLE = `{
  "surfaces": [
    {
      "id": "marketing",
      "name": "Marketing / Acquisition",
      "base_url": "https://get-example.com" | null,
      "audience": "First-time visitors deciding whether to sign up.",
      "features": ["pricing", "demo links", "signup CTA", "feature comparison"],
      "excluded_features": ["account dashboard", "customer-only data"],
      "notes": "optional"
    },
    {
      "id": "customer-portfolio",
      "name": "Customer-facing portfolio",
      "base_url": "https://{tenant}.example.com",
      "audience": "Recruiters / peers / clients reading a specific customer's profile.",
      "features": ["bio", "experience", "blog posts", "contact link"],
      "excluded_features": ["platform pricing", "signup CTA", "billing UI"]
    }
  ]
}`;

const SYSTEM_PROMPT = `You are mapping a software product into its distinct user-facing SURFACES. A product like a SaaS rarely has one site; it usually has several:

- a marketing/acquisition page (audience: prospects)
- one or more application or admin panels (audience: customers using it)
- customer-facing artifact pages (e.g. a portfolio site, a public profile) (audience: the customer's audience)
- internal/ops surfaces (audience: the company staff)

You will be given:
- A product context (name, description, frameworks, README excerpt, optional landing snapshot)

Produce a list of surfaces. Each surface has:
- id: lowercase-kebab unique
- name: short human-readable
- base_url: production URL when knowable from context, otherwise null. Use template syntax like {tenant} for parameterized hostnames.
- audience: one-sentence description of the user living there
- features: 3-8 concrete capabilities visible on this surface
- excluded_features: 1-5 capabilities users might EXPECT but that don't live here (this prevents persona mis-targeting)

Rules:
- 1-6 surfaces total. Don't invent surfaces that aren't supported by the README/landing context.
- A surface must have a distinct audience from every other surface. If two candidates share audience, merge them.
- Output ONLY a JSON object matching the schema below. No prose, no markdown fences.

Example shape:
${SCHEMA_EXAMPLE}`;

export interface GenerateSurfacesOptions {
  provider: AiProvider;
  project: ProjectContext;
}

export async function generateSurfaces(opts: GenerateSurfacesOptions): Promise<Surface[]> {
  const userPrompt = [
    `## Product context\n${summarizeProject(opts.project)}`,
    `## Task\nIdentify the distinct user-facing surfaces of this product. Return all of them.`,
  ].join("\n\n");

  const result = await opts.provider.propose({
    messages: [
      { role: "system", content: SYSTEM_PROMPT },
      { role: "user", content: userPrompt },
    ],
    schema: SurfaceSetSchema,
    schemaName: "SurfaceSet",
    schemaDescription:
      "Object with 'surfaces' array. Each surface has id, name, base_url?, audience, features[], excluded_features[].",
    maxTokens: 4000,
    temperature: 0.6,
  });

  return result.surfaces as Surface[];
}
