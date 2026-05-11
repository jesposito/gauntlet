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
    ? `\nPersona voice: ${ctx.personaVoice.trim()}\nJudge as this persona would — they decide what counts as success or abandon.`
    : "";

  return ctx.provider.propose({
    messages: [
      {
        role: "system",
        content: `You are the in-character persona deciding whether the current step of a test flow has succeeded, is still in progress, or has hit a give-up condition. Output ONLY JSON matching {"status":"success"|"in_progress"|"give_up","give_up_reason":string?,"evidence":string}.${voicePreamble}`,
      },
      {
        role: "user",
        content: `Step ${ctx.stepIndex + 1}/${ctx.totalSteps} of the flow.

Intent: ${ctx.step.intent}
${ctx.step.observation_target ? `Looking for: ${ctx.step.observation_target}\n` : ""}Success criteria: ${ctx.step.success_criteria}
Give-up criteria:
${giveUpList}

Current page:
  URL:   ${url}
  Title: ${title}

${lastAction}

Visible outline:
${summarizeOutline(outline, 60)}

Verdict?`,
      },
    ],
    schema: StepVerdictSchema,
    schemaName: "StepVerdict",
    maxTokens: 400,
    temperature: 0,
  });
}
