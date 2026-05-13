import { z, type ZodSchema, type ZodTypeAny } from "zod";
import type { Locator, Page } from "playwright";
import type { AiProvider } from "../ai/provider.ts";
import {
  getOutline,
  getPageText,
  summarizeOutline,
  type OutlineElement,
} from "./dom-outline.ts";

/**
 * Outcome of an observe() pick. Three states because text-snippet-only matches
 * are real successes — collapsing them into idx=-1 (the historical contract)
 * caused the runner to record persona-abandonment for "saw the value in the
 * page text" outcomes (the audplexus dogfood false-positive). The
 * discriminated union makes the three states unrepresentable as anything but
 * one of: an outline-index match, a text-snippet match, or no match at all.
 */
const ConfidenceField = z
  .number()
  .int()
  .min(0)
  .max(100)
  .default(70)
  .describe(
    "0-100 confidence the verdict is correct. Be honest: 90+ only for unambiguous matches (exact name + role + clear semantic match). 60-89 when reasonably sure. <60 when guessing — caller will treat as no_match.",
  );

export const LocatorPickSchema = z.discriminatedUnion("match_kind", [
  z.object({
    match_kind: z
      .literal("element")
      .describe("An interactive outline element matches the instruction."),
    idx: z
      .number()
      .int()
      .min(0)
      .describe("Index of the chosen element from the outline."),
    reasoning: z.string().describe("One sentence: why this element matches."),
    confidence: ConfidenceField,
  }),
  z.object({
    match_kind: z
      .literal("text")
      .describe(
        "The persona's target is purely textual (e.g. 'count of failed jobs') and is present in the page-text snippet but not as an interactive element.",
      ),
    reasoning: z
      .string()
      .describe(
        "One sentence: which page-text snippet supplies the match (cite the literal text).",
      ),
    confidence: ConfidenceField,
  }),
  z.object({
    match_kind: z
      .literal("none")
      .describe("Nothing on the page matches the instruction."),
    reasoning: z.string().describe("One sentence: why nothing matches."),
    confidence: ConfidenceField,
  }),
]);

/**
 * Action schema. Discriminated on `action` so that fill/press/select require
 * `value` and the others forbid it. Previously a flat schema with `value`
 * always optional admitted "fill with no value" — invalid output that only
 * blew up at runtime as "action failed", polluting the judge signal.
 */
const BaseActionFields = {
  match_kind: z.literal("element"),
  idx: z
    .number()
    .int()
    .min(0)
    .describe("Index of the chosen element from the outline."),
  reasoning: z.string().describe("One sentence: why this element matches."),
  confidence: ConfidenceField,
} as const;

export const ActionPickSchema = z.discriminatedUnion("action", [
  z.object({ ...BaseActionFields, action: z.literal("click") }),
  z.object({
    ...BaseActionFields,
    action: z.literal("fill"),
    value: z.string().describe("Value to fill into the element."),
  }),
  z.object({
    ...BaseActionFields,
    action: z.literal("press"),
    value: z.string().describe("Key to press (e.g. 'Enter', 'Escape')."),
  }),
  z.object({
    ...BaseActionFields,
    action: z.literal("select"),
    value: z.string().describe("Option value to select."),
  }),
  z.object({ ...BaseActionFields, action: z.literal("scroll_to") }),
  z.object({ ...BaseActionFields, action: z.literal("hover") }),
]);

/**
 * What the AI may return for the action picker. When nothing on the page
 * matches the intent, the model emits `{ match_kind: "none", reasoning, ... }`
 * rather than an action — the caller treats that as no_match. The act layer
 * runs the discriminated union below to validate.
 */
export const ActionOrNoMatchSchema = z.union([
  ActionPickSchema,
  z.object({
    match_kind: z.literal("none"),
    reasoning: z.string().describe("One sentence: why nothing on the page matches."),
    confidence: ConfidenceField,
  }),
]);

export type ActionPick = z.infer<typeof ActionPickSchema>;
export type ActionOrNoMatch = z.infer<typeof ActionOrNoMatchSchema>;
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

/**
 * Detect that an error from `provider.propose` originated in zod schema
 * validation (rather than e.g. an HTTP/network failure). Providers throw a
 * standard `Error` with a message starting with `<provider> output failed
 * schema "<name>":` when safeParse fails — see src/ai/anthropic.ts:103,
 * src/ai/openai.ts, src/ai/google.ts, src/ai/ollama.ts. Substring-matching
 * the literal `output failed schema` is intentional and brittle in the right
 * way: if a provider changes its error wording we want to NOT silently
 * swallow it as a "model decline".
 */
function isSchemaRejection(message: string): boolean {
  return message.includes("output failed schema");
}

/**
 * Three observation outcomes. `element` means an interactive outline element
 * was matched (the historical happy path). `text` means the persona's target
 * was a stat/label/empty-state value present in the page-text snippet but not
 * in the role-based outline — still a successful observation; the runner
 * should NOT treat it as abandonment. `none` means nothing matched.
 */
export type ObserveResult =
  | {
      match_kind: "element";
      match: OutlineElement;
      reasoning: string;
      outline: OutlineElement[];
      confidence: number;
    }
  | {
      match_kind: "text";
      reasoning: string;
      outline: OutlineElement[];
      confidence: number;
    }
  | {
      match_kind: "none";
      reasoning: string;
      outline: OutlineElement[];
      confidence: number;
    };

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
        content: `You pick the best-matching page element from a numbered outline. Output ONLY JSON matching one of three discriminated shapes keyed on "match_kind":
  { "match_kind": "element", "idx": number, "reasoning": string, "confidence": number }
  { "match_kind": "text",    "reasoning": string, "confidence": number }
  { "match_kind": "none",    "reasoning": string, "confidence": number }

Use "element" when an interactive outline entry matches the instruction; idx is the element index. Use "text" when the persona's target is purely textual ("count of failed jobs", "total books label", "empty-state copy", a <summary> label content) and you can find that literal text in the page-text snippet — cite the snippet in reasoning. Use "none" when nothing on the page matches. confidence is 0-100: 90+ for unambiguous matches, 60-89 when reasonably sure, <60 when guessing (callers will treat <60 as no_match). A <summary> entry in the outline is a collapsed disclosure widget (native <details>) — if the persona is looking for help text or instructions and a relevant <summary> label is present, prefer match_kind="element" with that summary's idx so the actor can expand it.${voicePreamble(ctx.personaVoice)}`,
      },
      {
        role: "user",
        content: `Outline of visible interactive elements on this page:\n${summarizeOutline(outline)}\n\nPage-text snippet (supplemental, for content not in the outline):\n${pageText || "(no body text captured)"}\n\nInstruction: "${instruction}"\n\nReturn one of the three discriminated shapes.${recentStepsPreamble(ctx.recentSteps)}`,
      },
    ],
    schema: LocatorPickSchema,
    schemaName: "LocatorPick",
    maxTokens: 400,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  const confidence =
    typeof result.confidence === "number" ? result.confidence : 70;

  // Low-confidence picks are treated as no_match regardless of what the model
  // claimed. Better to bail honestly than commit to a wrong locator + cascade
  // through act/judge.
  if (confidence < OBSERVE_CONFIDENCE_THRESHOLD) {
    return {
      match_kind: "none",
      reasoning: `low confidence (${confidence}/100) — treating as no_match. ${result.reasoning}`,
      outline,
      confidence,
    };
  }

  if (result.match_kind === "element") {
    const el = outline[result.idx];
    if (!el) {
      // Out-of-bounds idx from the model — collapse to no_match.
      return {
        match_kind: "none",
        reasoning: `out-of-bounds idx ${result.idx} (outline has ${outline.length} entries). ${result.reasoning}`,
        outline,
        confidence,
      };
    }
    return { match_kind: "element", match: el, reasoning: result.reasoning, outline, confidence };
  }

  if (result.match_kind === "text") {
    return { match_kind: "text", reasoning: result.reasoning, outline, confidence };
  }

  return { match_kind: "none", reasoning: result.reasoning, outline, confidence };
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
 * Result wrapper for the propose-action call so we can fold zod-rejection
 * into the normal control flow without leaking provider exceptions out of
 * `act()`. Anything other than schema rejection (network failures, abort,
 * provider auth errors) still throws — those aren't model-decline signals.
 */
type ProposeActionOutcome =
  | { kind: "ok"; value: z.input<typeof ActionOrNoMatchSchema> }
  | { kind: "schema_rejected"; message: string };

async function proposeActionWithRecovery(
  ctx: ActionContext,
  instruction: string,
  outline: OutlineElement[],
): Promise<ProposeActionOutcome> {
  try {
    const value = await ctx.provider.propose({
      messages: [
        {
          role: "system",
          content: `You are driving a browser for a user. Given their intent and a numbered outline of visible interactive elements, choose ONE element and ONE action OR signal no match. Output ONLY JSON matching one of these shapes (discriminated by "action" or "match_kind"):
  { "match_kind": "element", "action": "click"|"scroll_to"|"hover", "idx": number, "reasoning": string, "confidence": number }
  { "match_kind": "element", "action": "fill"|"press"|"select",     "idx": number, "value": string, "reasoning": string, "confidence": number }
  { "match_kind": "none",    "reasoning": string, "confidence": number }

Use match_kind="none" when nothing on the page matches the intent. For fill, value is the text to type. For press, value is the key (e.g. "Enter"). For select, value is the option to select. confidence is 0-100 — only above 60 will the action actually fire; below 60 the caller treats it as no_match. Be honest: 90+ for unambiguous matches, 60-89 when reasonably sure, <60 when guessing.${voicePreamble(ctx.personaVoice)}`,
        },
        {
          role: "user",
          content: `Outline:\n${summarizeOutline(outline)}\n\nIntent: "${instruction}"\n\nPick one action to take next, or signal match_kind="none".${recentStepsPreamble(ctx.recentSteps)}`,
        },
      ],
      schema: ActionOrNoMatchSchema,
      schemaName: "ActionPick",
      maxTokens: 500,
      temperature: 0,
      ...(ctx.signal ? { signal: ctx.signal } : {}),
    });
    return { kind: "ok", value };
  } catch (err) {
    const message = err instanceof Error ? err.message : String(err);
    if (!isSchemaRejection(message)) throw err;
    return { kind: "schema_rejected", message: message.split("\n")[0] ?? message };
  }
}

/**
 * Pick an element AND an action to perform on it given the persona's
 * intent. Executes the action.
 */
export async function act(ctx: ActionContext, instruction: string): Promise<ActResult> {
  const outline = await getOutline(ctx.page);
  const pickResult = await proposeActionWithRecovery(ctx, instruction, outline);
  if (pickResult.kind === "schema_rejected") {
    // Schema-rejection recovery: when the AI returns a malformed shape (most
    // commonly a locator-pick `{match_kind, idx, reasoning}` instead of an
    // action-pick — observed during audplexus dogfood 2026-05-13), the
    // provider throws on safeParse. Without this catch, the schema-validation
    // error escapes runFlow and the entire flow lands `outcome="error"` for
    // what is effectively a model decline. Treat schema rejection as no_match
    // so the judge can decide give_up cleanly on its next iteration.
    return {
      performed: false,
      action: undefined,
      target: undefined,
      reasoning: `AI returned non-action shape; treated as no_match. ${pickResult.message}`,
    };
  }
  const pick = pickResult.value;

  const pickConfidence =
    typeof pick.confidence === "number" ? pick.confidence : 70;

  if (pick.match_kind === "none") {
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

  const target = outline[pick.idx];
  if (!target) {
    return {
      performed: false,
      action: undefined,
      target: undefined,
      reasoning: `out-of-bounds idx ${pick.idx} (outline has ${outline.length} entries). ${pick.reasoning}`,
    };
  }
  const locator = buildLocator(ctx.page, target);

  try {
    switch (pick.action) {
      case "click":
        await locator.click({ timeout: 8000 });
        break;
      case "fill":
        await locator.fill(pick.value, { timeout: 8000 });
        break;
      case "press":
        await locator.press(pick.value, { timeout: 8000 });
        break;
      case "select":
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
