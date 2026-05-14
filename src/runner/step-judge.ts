import { z } from "zod";
import type { AiProvider } from "../ai/provider.ts";
import type { FlowStep } from "../flow/schema.ts";
import { getOutline, getPageText, summarizeOutline } from "../agent/dom-outline.ts";
import type { Page } from "playwright";

/**
 * Classification of why a step gave up. Lets the reporter distinguish real
 * defects from confusing-but-present UX, feature-gap signals, and
 * persona-expectation mismatches that should be noise.
 *
 *   bug          — the affordance is broken or genuinely missing from the
 *                  page despite being a documented capability of the product.
 *                  Worth filing.
 *   confusing_ux — the affordance is on the page but the persona didn't find
 *                  it (collapsed disclosure, ambiguous labelling, hidden
 *                  behind hover, etc). Worth fixing as polish, not a defect.
 *   feature_gap  — the affordance was never built; the persona's expectation
 *                  is reasonable but out-of-scope for this product. Worth
 *                  routing to product, not engineering.
 *   not_a_bug    — the persona's expectation does not match how this product
 *                  actually works (wrong terminology, wrong mental model,
 *                  state-dependent flow with unmet preconditions). Noise;
 *                  should not be reported as a defect.
 */
export const GiveUpClassSchema = z.enum([
  "bug",
  "confusing_ux",
  "feature_gap",
  "not_a_bug",
]);

export type GiveUpClass = z.infer<typeof GiveUpClassSchema>;

/**
 * Internal canonical verdict shape: discriminated union on `status`. The
 * give-up variant requires both `give_up_reason` and `give_up_class` so that
 * downstream reporters never see a give-up without classification — that
 * invariant used to be patched in via post-parse coercion, which is exactly
 * the kind of "model the constraint, don't guard around it" anti-pattern
 * the codex audit flagged.
 *
 * The AI sometimes still emits give_up verdicts without a class. We tolerate
 * that by parsing into a permissive raw schema first, then normalizing into
 * this strict shape (defaulting missing class -> "bug" so non-classified
 * abandons keep their original severity and never silently suppress a real
 * defect).
 */
export const StepVerdictSchema = z.discriminatedUnion("status", [
  z.object({
    status: z.literal("success"),
    evidence: z
      .string()
      .describe("One sentence: what on the page supports success."),
  }),
  z.object({
    status: z.literal("in_progress"),
    evidence: z
      .string()
      .describe("One sentence: what on the page shows progress."),
  }),
  z.object({
    status: z.literal("give_up"),
    give_up_reason: z
      .string()
      .describe(
        "Which give_up_criteria fired, or which observable signal triggered abandon.",
      ),
    give_up_class: GiveUpClassSchema.describe(
      "Required for give_up. Distinguishes real defects from confusing UX / feature gaps / persona-expectation noise.",
    ),
    evidence: z
      .string()
      .describe("One sentence: what on the page supports give_up."),
  }),
]);

export type StepVerdict = z.infer<typeof StepVerdictSchema>;

/**
 * Permissive raw shape used to parse AI output before normalizing into the
 * strict StepVerdictSchema above. Optional fields here account for known
 * provider sloppiness:
 *   - give_up_class omitted on give_up verdicts (audplexus 2026-05-13, 4/4)
 *   - give_up_reason omitted on give_up verdicts
 *   - give_up_reason / give_up_class explicitly null on success/in_progress
 *     verdicts (facets-sh 2026-05-14: AI returned `{"status":"success",
 *     "evidence":"...","give_up_reason":null,"give_up_class":null}`, schema
 *     rejected because `.optional()` doesn't accept `null` — the call escaped
 *     as outcome="error" instead of being treated as a normal success)
 *
 * `.nullish()` accepts both `undefined` and `null`. Normalization collapses
 * both to the strict shape.
 */
export const RawStepVerdictSchema = z.object({
  status: z.enum(["success", "in_progress", "give_up"]),
  give_up_reason: z.string().nullish(),
  give_up_class: GiveUpClassSchema.nullish(),
  evidence: z.string(),
});

export type RawStepVerdict = z.infer<typeof RawStepVerdictSchema>;

/**
 * Normalize a permissive AI output into the strict StepVerdict union. For
 * give_up verdicts, missing give_up_class defaults to "bug" so we never
 * silently suppress a real defect (real-world dogfood: audplexus 2026-05-13,
 * 4/4 abandoned flows came back with no give_up_class), and missing
 * give_up_reason defaults to the evidence text. For success / in_progress
 * verdicts, any give_up_* fields the AI hallucinated are stripped (facets-sh
 * 2026-05-14: AI sent give_up_reason: null on a success verdict).
 * Exported for tests; runtime consumers should depend on the strict
 * StepVerdict shape only.
 */
export function normalizeVerdict(raw: RawStepVerdict): StepVerdict {
  if (raw.status === "give_up") {
    return {
      status: "give_up",
      give_up_reason: raw.give_up_reason ?? raw.evidence,
      give_up_class: raw.give_up_class ?? "bug",
      evidence: raw.evidence,
    };
  }
  return { status: raw.status, evidence: raw.evidence };
}

export interface JudgeContext {
  provider: AiProvider;
  page: Page;
  step: FlowStep;
  stepIndex: number;
  totalSteps: number;
  personaVoice?: string;
  actionResult?: {
    performed: boolean;
    action?: string;
    error?: string;
  };
  signal?: AbortSignal;
}

export async function judgeStep(ctx: JudgeContext): Promise<StepVerdict> {
  const outline = await getOutline(ctx.page);
  const pageText = await getPageText(ctx.page, 3000);
  const url = ctx.page.url();
  const title = await ctx.page.title().catch(() => "");

  const lastAction = ctx.actionResult
    ? ctx.actionResult.performed
      ? `Last action: performed ${ctx.actionResult.action ?? "(unknown)"}.`
      : `Last action: failed (${ctx.actionResult.error ?? "no match"}).`
    : "No action attempted yet.";

  const giveUpList =
    ctx.step.give_up_criteria.length > 0
      ? ctx.step.give_up_criteria.map((g, i) => `  ${i + 1}. ${g}`).join("\n")
      : "  (none specified)";

  const voicePreamble = ctx.personaVoice
    ? `\nPersona voice (for tone of evidence text only — does NOT entitle the persona to bail for aesthetic reasons): ${ctx.personaVoice.trim()}`
    : "";

  // The judge prompt is deliberately strict about what counts as give_up.
  // Without these rules the AI dramatises the persona's personality and
  // bails the moment a page looks "cluttered" or "corporate" rather than
  // actually trying to complete the step. Bias toward in_progress.
  const SYSTEM = `You judge whether the current step of a real user-test flow succeeded, is still in progress, or has hit a give-up condition. Output ONLY JSON matching {"status":"success"|"in_progress"|"give_up","give_up_reason":string?,"give_up_class":"bug"|"confusing_ux"|"feature_gap"|"not_a_bug"?,"evidence":string}.

STRICT RULES:
1. Default to "in_progress" when uncertain. The flow has more steps; this judge runs once per step, not at the end.
2. "success" requires concrete evidence the success_criteria is met. Cite the evidence verbatim from either the visible outline OR the page-text snippet — both are first-class sources. Counts/stats/labels often live in the text snippet without being in the outline.
3. "give_up" is for objective blockers ONLY. Allowed reasons:
     a. The previous action FAILED ('action: failed' in the last-action note) AND no obvious recovery is on the page.
     b. A specific give_up_criterion has DEMONSTRABLY fired with observable evidence (cite which one + what you saw).
     c. The expected element / functionality is not present on the page AND the persona has no way to navigate to it.
4. Before declaring "give_up" for a missing affordance, CHECK FOR DISCLOSURE WIDGETS in the outline. A <summary> entry means a collapsed <details> block — clickable, may contain the help/hint/instructions the persona is looking for. The actor will be told to expand it next iteration; you must report "in_progress" not "give_up".
5. Before declaring "give_up" for a missing label, CHECK THE PAGE-TEXT SNIPPET. Dashboards routinely render counts as "<value><label>" pairs in plain divs that never make it into the role-based outline. If the snippet contains the words/numbers the persona wanted, that counts as the affordance being present — synonyms and reasonable terminology variation are fine ("Failed: 0" satisfies "failed count tile"; "341 Total Books" satisfies "total-books indicator").
6. Do NOT give up because the page looks busy, the copy is corporate, the brand is mid, or the persona "would feel impatient". The persona's voice/personality is for narration tone, not a license to abandon. Stress is fine; abandonment requires a concrete blocker.
7. If 'last action: performed' (success), and the outline/text now shows progress toward success_criteria, prefer "in_progress" over "give_up".

When status="give_up", you MUST set give_up_class to one of:
  - "bug"          The affordance is broken or absent despite being a documented capability of the page (e.g. button renders but click does nothing; required field has no input; documented feature simply not on the page).
  - "confusing_ux" The affordance EXISTS on the page but the persona couldn't find/use it without help: collapsed behind <details> the actor never opened, ambiguous label, hidden behind hover, requires non-obvious keyboard shortcut, etc. Real for triage, not a defect.
  - "feature_gap"  The persona's expectation is reasonable but the product genuinely doesn't have this feature (e.g. wanted bulk-select in a list that doesn't support it; wanted email/password form for an OAuth-only login). Route to product, not eng.
  - "not_a_bug"    The persona was wrong: state-dependent flow with unmet preconditions (e.g. wanted to read a failure reason on a dashboard with zero failures), wrong terminology (looked for "tile" when the page calls them "cards"), or wrong mental model. Noise; should not be reported as a defect.

Evidence must reference observable state: an outline index, a literal URL, a literal page title, a literal heading text, a snippet from the page-text, or the last-action result. Do not write evidence like "this looks frustrating" — that is not evidence.${voicePreamble}`;

  const raw = await ctx.provider.propose({
    messages: [
      { role: "system", content: SYSTEM },
      {
        role: "user",
        content: `Step ${ctx.stepIndex + 1}/${ctx.totalSteps} of the flow.

Intent: ${ctx.step.intent}
${ctx.step.observation_target ? `Looking for: ${ctx.step.observation_target}\n` : ""}Success criteria: ${ctx.step.success_criteria}
Give-up criteria (only fire one of these — and only with observable evidence):
${giveUpList}

Current page:
  URL:   ${url}
  Title: ${title}

${lastAction}

Visible outline (role-bearing interactive + heading elements):
${summarizeOutline(outline, 60)}

Visible page-text snippet (covers stat cards, status banners, empty-state messages, and other text the role-based outline cannot represent — first-class evidence alongside the outline):
${pageText || "(no body text captured)"}

Verdict? Remember: bias toward in_progress; before declaring give_up, check for a <summary> disclosure in the outline AND scan the page-text for synonyms of what the persona wanted; give_up requires an observable blocker, not aesthetic distaste; if status="give_up", set give_up_class.`,
      },
    ],
    schema: RawStepVerdictSchema,
    schemaName: "StepVerdict",
    maxTokens: 400,
    temperature: 0,
    purpose: "judge",
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  return normalizeVerdict(raw);
}
