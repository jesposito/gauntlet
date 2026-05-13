import { z, type ZodSchema, type ZodTypeAny } from "zod";
import type { Locator, Page } from "playwright";
import type { AiProvider } from "../ai/provider.ts";
import {
  getOutline,
  getPageText,
  summarizeOutline,
  type OutlineElement,
} from "./dom-outline.ts";

export const LocatorPickSchema = z.object({
  idx: z
    .number()
    .int()
    .min(-1)
    .describe(
      "Index of the chosen element from the outline. Use -1 if nothing matches.",
    ),
  reasoning: z.string().describe("One sentence: why this element matches."),
  confidence: z
    .number()
    .int()
    .min(0)
    .max(100)
    .default(70)
    .describe(
      "0-100 confidence the picked element is correct. Be honest: 90+ only for unambiguous matches (exact name + role + clear semantic match). 60-89 when reasonably sure. <60 when guessing — caller will treat as no_match.",
    ),
});

export const ActionPickSchema = LocatorPickSchema.extend({
  action: z.enum(["click", "fill", "press", "select", "scroll_to", "hover"]),
  value: z
    .string()
    .optional()
    .describe(
      "Value to fill, key to press, or option to select. Required for fill/press/select.",
    ),
});

export type ActionPick = z.infer<typeof ActionPickSchema>;
export type LocatorPick = z.infer<typeof LocatorPickSchema>;

export interface ActionContext {
  provider: AiProvider;
  page: Page;
  personaVoice?: string;
  /**
   * Optional AbortSignal threaded into AI provider calls. When the flow-runner
   * step times out, this signal fires and the in-flight fetch is cancelled
   * rather than continuing to mutate the page in the background.
   */
  signal?: AbortSignal;
  /**
   * Last 1-3 step memos from the flow. Without history the AI can repeat a
   * picked-and-failed locator on the very next observe — feeding the recent
   * tuples breaks that loop and lets the model pick a different element.
   * Borrowed from browser-use / Stagehand's "memory" pattern.
   */
  recentSteps?: ReadonlyArray<{
    intent: string;
    action?: string;
    targetName?: string;
    outcome: "success" | "in_progress" | "give_up" | "no_match" | "failed";
    evidence?: string;
  }>;
}

export interface ObserveResult {
  match: OutlineElement | undefined;
  reasoning: string;
  outline: OutlineElement[];
  /**
   * 0-100 self-reported confidence the picked element is correct. Callers
   * threshold this (default 60) and treat low-confidence picks the same as
   * no_match — better to bail honestly than commit to a wrong locator.
   */
  confidence: number;
}

/**
 * Below this confidence value, observe() reports no match even when the AI
 * returned a non-negative idx. Tuned to filter out coin-flip guesses without
 * being so strict that legitimate-but-uncertain picks get dropped.
 */
export const OBSERVE_CONFIDENCE_THRESHOLD = 60;

/** Format the recent-step memos for inclusion in observe / act prompts. */
function recentStepsPreamble(steps: ActionContext["recentSteps"]): string {
  if (!steps || steps.length === 0) return "";
  const lines = steps.map((s, i) => {
    const action = s.action
      ? `${s.action}${s.targetName ? ` "${s.targetName.slice(0, 40)}"` : ""}`
      : "(no action)";
    const evidence = s.evidence ? ` evidence: ${s.evidence.slice(0, 80)}` : "";
    return `  ${i + 1}. intent="${s.intent.slice(0, 80)}" -> ${action} -> ${s.outcome}.${evidence}`;
  });
  return `\n\nRecent step history (don't repeat mistakes from these — if a prior step failed on a target, pick a different one or report idx=-1):\n${lines.join("\n")}`;
}

function voicePreamble(voice: string | undefined): string {
  if (!voice) return "";
  return `\nThe acting user's voice: ${voice.trim()}\nStay consistent with how they would scan the page.`;
}

/**
 * Pick the element matching `instruction` from the current page. Does NOT
 * execute any action. Used to gate steps ("is the thing I'm looking for here
 * before I commit to acting?").
 */
export async function observe(
  ctx: ActionContext,
  instruction: string,
): Promise<ObserveResult> {
  const outline = await getOutline(ctx.page);
  const pageText = await getPageText(ctx.page, 2000);
  const result = await ctx.provider.propose({
    messages: [
      {
        role: "system",
        content: `You pick the best-matching page element from a numbered outline. Output ONLY JSON matching {"idx": number, "reasoning": string, "confidence": number}. idx is the element index, or -1 if nothing matches. confidence is 0-100 reflecting how certain you are: 90+ for unambiguous matches (exact name + role + clear semantic match), 60-89 when reasonably sure, <60 when guessing (callers will treat <60 as no_match). Notes: a <summary> entry in the outline is a collapsed disclosure widget (native <details>) — if the persona is looking for help text or instructions and a relevant <summary> label is present, treat that as a match. The page-text snippet supplements the outline for content the outline cannot represent (stat cards, status banners, empty-state text); if the persona's target is purely textual ("count of failed jobs"), a match in the text snippet is still a successful observation — return idx=-1 with high confidence and call out the text-snippet hit in reasoning so the caller does not treat it as a missing affordance.${voicePreamble(ctx.personaVoice)}`,
      },
      {
        role: "user",
        content: `Outline of visible interactive elements on this page:\n${summarizeOutline(outline)}\n\nPage-text snippet (supplemental, for content not in the outline):\n${pageText || "(no body text captured)"}\n\nInstruction: "${instruction}"\n\nReturn the matching idx, or -1 if no element matches.${recentStepsPreamble(ctx.recentSteps)}`,
      },
    ],
    schema: LocatorPickSchema,
    schemaName: "LocatorPick",
    maxTokens: 400,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const confidence = typeof result.confidence === "number" ? result.confidence : 70;
  // Low-confidence picks are treated as no_match. Better to bail honestly
  // than commit to a wrong locator + cascade through act/judge.
  const match =
    result.idx >= 0 && confidence >= OBSERVE_CONFIDENCE_THRESHOLD
      ? outline[result.idx]
      : undefined;
  const reasoning =
    result.idx >= 0 && confidence < OBSERVE_CONFIDENCE_THRESHOLD
      ? `low confidence (${confidence}/100) — treating as no_match. ${result.reasoning}`
      : result.reasoning;
  return { match, reasoning, outline, confidence };
}

function buildLocator(page: Page, el: OutlineElement): Locator {
  if (el.name) {
    if (el.role === "button" || el.role === "link") {
      return page.getByRole(el.role, { name: el.name, exact: false }).first();
    }
    if (el.role === "textbox" || el.role === "combobox") {
      return page.getByLabel(el.name, { exact: false }).first();
    }
    if (el.role === "heading") {
      return page.getByRole("heading", { name: el.name, exact: false }).first();
    }
    return page.getByText(el.name, { exact: false }).first();
  }
  return page.locator(el.tag).first();
}

export interface ActResult {
  performed: boolean;
  action: ActionPick["action"] | undefined;
  target: OutlineElement | undefined;
  reasoning: string;
  error?: string;
}

/**
 * Pick an element AND an action to perform on it given the persona's
 * intent. Executes the action.
 */
export async function act(ctx: ActionContext, instruction: string): Promise<ActResult> {
  const outline = await getOutline(ctx.page);
  const pick = await ctx.provider.propose({
    messages: [
      {
        role: "system",
        content: `You are driving a browser for a user. Given their intent and a numbered outline of visible interactive elements, choose ONE element and ONE action. Output ONLY JSON matching {"idx": number, "action": "click"|"fill"|"press"|"select"|"scroll_to"|"hover", "value": string?, "reasoning": string, "confidence": number}. Use idx=-1 if nothing on the page matches the intent. For fill/press/select, value is required. confidence is 0-100 — only above 60 will the action actually fire; below 60 the caller treats it as no_match. Be honest: 90+ for unambiguous matches, 60-89 when reasonably sure, <60 when guessing.${voicePreamble(ctx.personaVoice)}`,
      },
      {
        role: "user",
        content: `Outline:\n${summarizeOutline(outline)}\n\nIntent: "${instruction}"\n\nPick one action to take next.${recentStepsPreamble(ctx.recentSteps)}`,
      },
    ],
    schema: ActionPickSchema,
    schemaName: "ActionPick",
    maxTokens: 500,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  const pickConfidence = typeof pick.confidence === "number" ? pick.confidence : 70;
  if (pick.idx < 0 || pick.idx >= outline.length) {
    return {
      performed: false,
      action: undefined,
      target: undefined,
      reasoning: pick.reasoning,
    };
  }
  // Confidence gate: don't fire the action if the AI hedged. Same threshold
  // as observe() — low-confidence picks degrade to no_match so the judge
  // can decide give_up cleanly instead of acting on a guess.
  if (pickConfidence < OBSERVE_CONFIDENCE_THRESHOLD) {
    return {
      performed: false,
      action: undefined,
      target: undefined,
      reasoning: `low confidence (${pickConfidence}/100) — declined to act. ${pick.reasoning}`,
    };
  }
  const target = outline[pick.idx]!;
  const locator = buildLocator(ctx.page, target);

  try {
    switch (pick.action) {
      case "click":
        await locator.click({ timeout: 8000 });
        break;
      case "fill":
        if (pick.value === undefined) throw new Error("fill requires value");
        await locator.fill(pick.value, { timeout: 8000 });
        break;
      case "press":
        if (pick.value === undefined) throw new Error("press requires value (key)");
        await locator.press(pick.value, { timeout: 8000 });
        break;
      case "select":
        if (pick.value === undefined) throw new Error("select requires value");
        await locator.selectOption(pick.value, { timeout: 8000 });
        break;
      case "scroll_to":
        await locator.scrollIntoViewIfNeeded({ timeout: 8000 });
        break;
      case "hover":
        await locator.hover({ timeout: 8000 });
        break;
    }
    return { performed: true, action: pick.action, target, reasoning: pick.reasoning };
  } catch (err) {
    return {
      performed: false,
      action: pick.action,
      target,
      reasoning: pick.reasoning,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function describeZod(schema: ZodTypeAny, depth = 0): string {
  if (depth > 3) return "any";
  const def = (schema as { _def: { typeName?: string } })._def;
  const name = def.typeName ?? "";
  switch (name) {
    case "ZodString":
      return "string";
    case "ZodNumber":
      return "number";
    case "ZodBoolean":
      return "boolean";
    case "ZodNull":
      return "null";
    case "ZodEnum": {
      const values = ((def as unknown as { values: string[] }).values ?? []).map((v) => JSON.stringify(v));
      return values.join(" | ");
    }
    case "ZodLiteral":
      return JSON.stringify((def as unknown as { value: unknown }).value);
    case "ZodArray": {
      const inner = (def as unknown as { type: ZodTypeAny }).type;
      return `${describeZod(inner, depth + 1)}[]`;
    }
    case "ZodOptional":
    case "ZodNullable":
    case "ZodDefault": {
      const inner = (def as unknown as { innerType: ZodTypeAny }).innerType;
      return `${describeZod(inner, depth + 1)}${name === "ZodOptional" ? "?" : ""}`;
    }
    case "ZodObject": {
      const shapeFn = (def as unknown as { shape: () => Record<string, ZodTypeAny> }).shape;
      const shape = typeof shapeFn === "function" ? shapeFn() : (shapeFn as unknown as Record<string, ZodTypeAny>);
      const entries = Object.entries(shape ?? {}).map(([k, v]) => {
        const isOptional = (v._def as { typeName?: string }).typeName === "ZodOptional";
        return `  "${k}"${isOptional ? "?" : ""}: ${describeZod(v, depth + 1)}`;
      });
      return `{\n${entries.join(",\n")}\n}`;
    }
    default:
      return "any";
  }
}

/**
 * Extract structured data from the current page, matching the provided zod
 * schema. The AI is given the outline AND a short text excerpt and asked to
 * fill in the schema. Modeled on Stagehand's extract().
 */
export async function extract<T>(
  ctx: ActionContext,
  instruction: string,
  schema: ZodSchema<T>,
  schemaName: string,
): Promise<T> {
  const shape = describeZod(schema as unknown as ZodTypeAny);
  const outline = await getOutline(ctx.page);
  const text = (await ctx.page.evaluate(() =>
    (document.body?.innerText ?? "").slice(0, 6000),
  )) as string;

  return ctx.provider.propose({
    messages: [
      {
        role: "system",
        content: `Extract structured data from a page. Output ONLY JSON matching the "${schemaName}" schema. Required fields must be filled using the best evidence on the page (use the closest accurate value; for booleans about presence, infer from the outline+text). Only OPTIONAL fields may be omitted when absent. Do not fabricate specific numbers or quotes that aren't supported.${voicePreamble(ctx.personaVoice)}`,
      },
      {
        role: "user",
        content: `Page outline:\n${summarizeOutline(outline, 40)}\n\nPage text (truncated):\n${text}\n\nInstruction: ${instruction}\n\nReturn JSON matching schema "${schemaName}":\n${shape}\n\nField names MUST match exactly. ? means optional.`,
      },
    ],
    schema,
    schemaName,
    maxTokens: 1500,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
}
