import { z } from "zod";
import type { AiProvider } from "../ai/provider.ts";
import type { FlowStep } from "../flow/schema.ts";
import { getOutline, summarizeOutline } from "../agent/dom-outline.ts";
import type { Page } from "playwright";

export const StepVerdictSchema = z.object({
  status: z.enum(["success", "in_progress", "give_up"]),
  give_up_reason: z
    .string()
    .optional()
    .describe(
      "Which give_up_criteria fired, or which observable signal triggered abandon.",
    ),
  evidence: z.string().describe("One sentence: what on the page supports this verdict."),
});

export type StepVerdict = z.infer<typeof StepVerdictSchema>;

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
  const SYSTEM = `You judge whether the current step of a real user-test flow succeeded, is still in progress, or has hit a give-up condition. Output ONLY JSON matching {"status":"success"|"in_progress"|"give_up","give_up_reason":string?,"evidence":string}.

STRICT RULES:
1. Default to "in_progress" when uncertain. The flow has more steps; this judge runs once per step, not at the end.
2. "success" requires concrete evidence the success_criteria is met (URL match, expected text/heading visible in the outline, confirmation message present, expected element index in outline, etc). Cite the evidence verbatim.
3. "give_up" is for objective blockers ONLY. Allowed reasons:
     a. The previous action FAILED ('action: failed' in the last-action note) AND no obvious recovery is on the page.
     b. A specific give_up_criterion has DEMONSTRABLY fired with observable evidence (cite which one + what you saw).
     c. The expected element / functionality is not present on the page AND the persona has no way to navigate to it.
4. Do NOT give up because the page looks busy, the copy is corporate, the brand is mid, or the persona "would feel impatient". The persona's voice/personality is for narration tone, not a license to abandon. Stress is fine; abandonment requires a concrete blocker.
5. If 'last action: performed' (success), and the outline now shows progress toward success_criteria, prefer "in_progress" over "give_up".

Evidence must reference observable state: an outline index, a literal URL, a literal page title, a literal heading text, or the last-action result. Do not write evidence like "this looks frustrating" — that is not evidence.${voicePreamble}`;

  return ctx.provider.propose({
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

Visible outline:
${summarizeOutline(outline, 60)}

Verdict? Remember: bias toward in_progress; give_up requires an observable blocker, not aesthetic distaste.`,
      },
    ],
    schema: StepVerdictSchema,
    schemaName: "StepVerdict",
    maxTokens: 400,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}
