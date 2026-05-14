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
      "requires_auth": false,
      "login_url": null,
      "notes": "optional"
    },
    {
      "id": "tenant-admin",
      "name": "Tenant admin panel (the actual product)",
      "base_url": "https://{tenant}.example.com/admin",
      "audience": "Customers managing their account / content. THIS is what the product does.",
      "features": ["edit profile", "manage content", "billing", "settings"],
      "excluded_features": ["platform marketing copy", "other tenants' data"],
      "requires_auth": true,
      "login_url": "https://{tenant}.example.com/login",
      "notes": "Sits behind auth. gauntlet auth <id> needed before run."
    },
    {
      "id": "customer-portfolio",
      "name": "Customer-facing portfolio",
      "base_url": "https://{tenant}.example.com",
      "audience": "Recruiters / peers / clients reading a specific customer's profile.",
      "features": ["bio", "experience", "blog posts", "contact link"],
      "excluded_features": ["platform pricing", "signup CTA", "billing UI"],
      "requires_auth": false
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
- requires_auth=true when: a fetched landing was unreachable with status 401/403, the landing hint mentions "login wall" or "appears to require login", OR the README clearly states the surface is behind auth (admin panel, customer dashboard, internal tooling).
- login_url is the URL a logged-out user goes to in order to sign in. Set when knowable (often /login on the same host). null otherwise.
- If the README describes the product as a SaaS/multi-tenant app, you almost certainly have at least one auth-walled surface even when only a marketing page was fetched. Propose it.
- Output ONLY a JSON object matching the schema below. No prose, no markdown fences.

Example shape:
${SCHEMA_EXAMPLE}`;

export interface GenerateSurfacesOptions {
  provider: AiProvider;
  project: ProjectContext;
  /**
   * Optional user-supplied directive. When set, the AI is told to weight
   * surface discovery toward the named area without ignoring the rest of
   * the product. Empty string = no directive (same as undefined).
   */
  focus?: string;
}

export async function generateSurfaces(opts: GenerateSurfacesOptions): Promise<Surface[]> {
  const focus = opts.focus?.trim();
  const userPrompt = [
    `## Product context\n${summarizeProject(opts.project)}`,
    focus
      ? `## Focus directive (from operator)\nThe operator wants extra attention paid to: ${focus}\nIdentify all surfaces, but make sure any surface that touches this area is captured cleanly (its own surface entry, not folded into a generic "app" surface).`
      : "",
    `## Task\nIdentify the distinct user-facing surfaces of this product. Return all of them.`,
  ]
    .filter(Boolean)
    .join("\n\n");

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
    purpose: "surface_gen",
  });

  return result.surfaces as Surface[];
}
