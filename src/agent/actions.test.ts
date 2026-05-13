import { describe, expect, test } from "bun:test";
import {
  ActionOrNoMatchSchema,
  ActionPickSchema,
  LocatorPickSchema,
  observe,
  type ActionContext,
  type LocatorPick,
} from "./actions.ts";
import type { AiProvider, ProposeOptions } from "../ai/provider.ts";

describe("LocatorPickSchema (observe — discriminated on match_kind)", () => {
  test("accepts element match with idx", () => {
    const v = LocatorPickSchema.parse({
      match_kind: "element",
      idx: 7,
      reasoning: "button labelled 'Save'",
      confidence: 95,
    });
    if (v.match_kind === "element") {
      expect(v.idx).toBe(7);
    }
  });

  test("accepts text-snippet match without idx", () => {
    // Real-world dogfood (audplexus 2026-05-13): observe correctly identified
    // a stat-card text match, but the historical idx=-1 contract collapsed
    // that to "no match", so the runner abandoned the persona for a
    // legitimate observation. The match_kind="text" variant is the fix.
    const v = LocatorPickSchema.parse({
      match_kind: "text",
      reasoning: "page-text snippet contains 'Failed: 0'",
      confidence: 90,
    });
    expect(v.match_kind).toBe("text");
    // The text variant has no idx field — narrowed by discriminant.
    expect("idx" in v).toBe(false);
  });

  test("accepts none with reasoning", () => {
    const v = LocatorPickSchema.parse({
      match_kind: "none",
      reasoning: "nothing relevant on this page",
      confidence: 80,
    });
    expect(v.match_kind).toBe("none");
  });

  test("rejects element match with negative idx (idx is non-negative on element variant)", () => {
    expect(() =>
      LocatorPickSchema.parse({
        match_kind: "element",
        idx: -1,
        reasoning: "x",
        confidence: 50,
      }),
    ).toThrow();
  });

  test("rejects unknown match_kind", () => {
    expect(() =>
      LocatorPickSchema.parse({
        match_kind: "maybe",
        reasoning: "x",
        confidence: 50,
      }),
    ).toThrow();
  });

  test("defaults confidence when omitted", () => {
    const v = LocatorPickSchema.parse({
      match_kind: "none",
      reasoning: "x",
    });
    expect(v.confidence).toBe(70);
  });
});

describe("ActionPickSchema (action — discriminated on action verb)", () => {
  test("click does not require value", () => {
    const v = ActionPickSchema.parse({
      match_kind: "element",
      action: "click",
      idx: 3,
      reasoning: "primary CTA",
      confidence: 95,
    });
    expect(v.action).toBe("click");
    expect("value" in v).toBe(false);
  });

  test("fill requires value", () => {
    expect(() =>
      ActionPickSchema.parse({
        match_kind: "element",
        action: "fill",
        idx: 3,
        reasoning: "the email field",
        confidence: 95,
      }),
    ).toThrow();

    const v = ActionPickSchema.parse({
      match_kind: "element",
      action: "fill",
      idx: 3,
      value: "user@example.com",
      reasoning: "the email field",
      confidence: 95,
    });
    if (v.action === "fill") {
      expect(v.value).toBe("user@example.com");
    }
  });

  test("press requires value (key)", () => {
    expect(() =>
      ActionPickSchema.parse({
        match_kind: "element",
        action: "press",
        idx: 3,
        reasoning: "submit by Enter",
        confidence: 95,
      }),
    ).toThrow();
  });

  test("select requires value", () => {
    expect(() =>
      ActionPickSchema.parse({
        match_kind: "element",
        action: "select",
        idx: 3,
        reasoning: "country selector",
        confidence: 95,
      }),
    ).toThrow();
  });

  test("scroll_to and hover do not require value", () => {
    expect(() =>
      ActionPickSchema.parse({
        match_kind: "element",
        action: "scroll_to",
        idx: 3,
        reasoning: "off-screen footer",
        confidence: 95,
      }),
    ).not.toThrow();
    expect(() =>
      ActionPickSchema.parse({
        match_kind: "element",
        action: "hover",
        idx: 3,
        reasoning: "tooltip trigger",
        confidence: 95,
      }),
    ).not.toThrow();
  });

  test("rejects unknown action verb", () => {
    expect(() =>
      ActionPickSchema.parse({
        match_kind: "element",
        action: "punch",
        idx: 3,
        reasoning: "?",
        confidence: 95,
      }),
    ).toThrow();
  });
});

describe("observe() returns the discriminated outcome to the caller", () => {
  // Fake Page: only page.evaluate is exercised by observe() (via dom-outline).
  // Returning a small outline + page text lets us drive the function end-to-end
  // with a stubbed AI provider.
  function makeFakePage(opts: { outline: unknown[]; text: string }) {
    return {
      evaluate: async (script: string) => {
        if (script.startsWith("(") || script.includes("OUTLINE_SCRIPT") || script.includes("getOutline") || script.includes("function")) {
          // First call: outline script.
          if (script.includes("document.body ? document.body.innerText")) {
            return opts.text;
          }
          return opts.outline;
        }
        if (script.includes("document.body")) return opts.text;
        return opts.outline;
      },
    };
  }

  function makeProvider(reply: LocatorPick): AiProvider {
    return {
      name: "fake",
      model: "fake-1",
      async propose<T>(_opts: ProposeOptions<T>): Promise<T> {
        return reply as unknown as T;
      },
    };
  }

  test("text-snippet match returns match_kind='text' (not 'none')", async () => {
    // Real-world dogfood (audplexus 2026-05-13): the previous contract
    // collapsed text-only matches to idx=-1, which the runner treated as
    // persona abandonment. The new discriminated outcome surfaces text
    // matches as a first-class success.
    const page = makeFakePage({
      outline: [{ idx: 0, role: "heading", name: "Diagnostics", tag: "h2", visible: true }],
      text: "Failed: 0",
    });
    const provider = makeProvider({
      match_kind: "text",
      reasoning: "page-text snippet contains 'Failed: 0'",
      confidence: 90,
    });
    const ctx: ActionContext = {
      provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: page as any,
    };
    const result = await observe(ctx, "count of failed jobs");
    expect(result.match_kind).toBe("text");
    expect(result.confidence).toBe(90);
    // The discriminated union prevents a `match` field from existing on the
    // text variant — the runner's old `if (!obs.match)` check would have
    // (incorrectly) triggered abandon for this exact case before the fix.
    expect("match" in result).toBe(false);
  });

  test("element match returns match_kind='element' with the picked element", async () => {
    const outline = [
      { idx: 0, role: "heading", name: "Diagnostics", tag: "h2", visible: true },
      { idx: 1, role: "button", name: "Save", tag: "button", visible: true },
    ];
    const page = makeFakePage({ outline, text: "" });
    const provider = makeProvider({
      match_kind: "element",
      idx: 1,
      reasoning: "the Save button",
      confidence: 95,
    });
    const ctx: ActionContext = {
      provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: page as any,
    };
    const result = await observe(ctx, "save button");
    expect(result.match_kind).toBe("element");
    if (result.match_kind === "element") {
      expect(result.match.name).toBe("Save");
    }
  });

  test("low-confidence pick is downgraded to none", async () => {
    const page = makeFakePage({
      outline: [{ idx: 0, role: "button", name: "Maybe", tag: "button", visible: true }],
      text: "",
    });
    const provider = makeProvider({
      match_kind: "element",
      idx: 0,
      reasoning: "guess",
      confidence: 40,
    });
    const ctx: ActionContext = {
      provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: page as any,
    };
    const result = await observe(ctx, "submit");
    expect(result.match_kind).toBe("none");
    expect(result.reasoning).toContain("low confidence");
  });

  test("none from the model passes through as none", async () => {
    const page = makeFakePage({ outline: [], text: "" });
    const provider = makeProvider({
      match_kind: "none",
      reasoning: "blank page",
      confidence: 95,
    });
    const ctx: ActionContext = {
      provider,
      // eslint-disable-next-line @typescript-eslint/no-explicit-any
      page: page as any,
    };
    const result = await observe(ctx, "anything");
    expect(result.match_kind).toBe("none");
  });
});

describe("ActionOrNoMatchSchema (act — accepts no_match too)", () => {
  test("accepts a valid action pick", () => {
    const v = ActionOrNoMatchSchema.parse({
      match_kind: "element",
      action: "click",
      idx: 3,
      reasoning: "x",
      confidence: 95,
    });
    expect(v.match_kind).toBe("element");
  });

  test("accepts none without an action", () => {
    const v = ActionOrNoMatchSchema.parse({
      match_kind: "none",
      reasoning: "no matching affordance",
      confidence: 80,
    });
    expect(v.match_kind).toBe("none");
  });
});
