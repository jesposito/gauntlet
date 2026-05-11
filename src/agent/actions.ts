import { z, type ZodSchema, type ZodTypeAny } from "zod";
import type { Locator, Page } from "playwright";
import type { AiProvider } from "../ai/provider.ts";
import {
  getOutline,
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
}

export interface ObserveResult {
  match: OutlineElement | undefined;
  reasoning: string;
  outline: OutlineElement[];
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
  const result = await ctx.provider.propose({
    messages: [
      {
        role: "system",
        content: `You pick the best-matching page element from a numbered outline. Output ONLY JSON matching {"idx": number, "reasoning": string}. idx is the element index, or -1 if nothing matches.${voicePreamble(ctx.personaVoice)}`,
      },
      {
        role: "user",
        content: `Outline of visible interactive elements on this page:\n${summarizeOutline(outline)}\n\nInstruction: "${instruction}"\n\nReturn the matching idx, or -1 if no element matches.`,
      },
    ],
    schema: LocatorPickSchema,
    schemaName: "LocatorPick",
    maxTokens: 400,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });
  const match = result.idx >= 0 ? outline[result.idx] : undefined;
  return { match, reasoning: result.reasoning, outline };
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
        content: `You are driving a browser for a user. Given their intent and a numbered outline of visible interactive elements, choose ONE element and ONE action. Output ONLY JSON matching {"idx": number, "action": "click"|"fill"|"press"|"select"|"scroll_to"|"hover", "value": string?, "reasoning": string}. Use idx=-1 if nothing on the page matches the intent. For fill/press/select, value is required.${voicePreamble(ctx.personaVoice)}`,
      },
      {
        role: "user",
        content: `Outline:\n${summarizeOutline(outline)}\n\nIntent: "${instruction}"\n\nPick one action to take next.`,
      },
    ],
    schema: ActionPickSchema,
    schemaName: "ActionPick",
    maxTokens: 500,
    temperature: 0,
    ...(ctx.signal ? { signal: ctx.signal } : {}),
  });

  if (pick.idx < 0 || pick.idx >= outline.length) {
    return {
      performed: false,
      action: undefined,
      target: undefined,
      reasoning: pick.reasoning,
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
