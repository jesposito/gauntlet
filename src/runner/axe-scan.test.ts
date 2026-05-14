import { describe, expect, mock, test } from "bun:test";
import {
  PERSONA_RULE_TO_AXE_ID,
  matchAxeViolationsToPersonaRules,
  type AxeViolation,
} from "./axe-scan.ts";

const sampleViolations: AxeViolation[] = [
  { id: "label", impact: "serious", help: "Form elements must have labels", helpUrl: "x", nodeCount: 1, sampleTargets: ["input#x"] },
  { id: "color-contrast", impact: "serious", help: "Insufficient contrast", helpUrl: "x", nodeCount: 4, sampleTargets: [".btn"] },
];

describe("PERSONA_RULE_TO_AXE_ID", () => {
  test("known mappings exist", () => {
    expect(PERSONA_RULE_TO_AXE_ID.form_field_missing_label).toBe("label");
    expect(PERSONA_RULE_TO_AXE_ID.unlabeled_icon_buttons).toBe("button-name");
    expect(PERSONA_RULE_TO_AXE_ID.keyboard_trap).toBe("no-keyboard-trap");
  });
});

describe("matchAxeViolationsToPersonaRules", () => {
  test("matches when persona rule maps to an axe id present in violations", () => {
    const hits = matchAxeViolationsToPersonaRules(sampleViolations, ["form_field_missing_label"]);
    expect(hits).toHaveLength(1);
    expect(hits[0]?.rule).toBe("form_field_missing_label");
    expect(hits[0]?.axeId).toBe("label");
  });

  test("ignores unmapped persona rules", () => {
    const hits = matchAxeViolationsToPersonaRules(sampleViolations, ["pizza_smell"]);
    expect(hits).toHaveLength(0);
  });

  test("ignores rules that map to an axe id NOT in violations", () => {
    const hits = matchAxeViolationsToPersonaRules(sampleViolations, ["keyboard_trap"]);
    expect(hits).toHaveLength(0);
  });

  test("returns all matching hits", () => {
    const v: AxeViolation[] = [
      ...sampleViolations,
      { id: "button-name", impact: "critical", help: "Buttons need names", helpUrl: "x", nodeCount: 2, sampleTargets: ["button"] },
    ];
    const hits = matchAxeViolationsToPersonaRules(v, ["unlabeled_icon_buttons", "form_field_missing_label"]);
    expect(hits.map((h) => h.axeId).sort()).toEqual(["button-name", "label"]);
  });
});

/**
 * Contract tests for runAxe's timeout + signal behavior. AxeBuilder.analyze
 * is NOT internally cancelable (per the doc comment on runAxe), so these
 * tests lock the OBSERVABLE contract: caller-side bounding works, and
 * timeouts/aborts surface as `error` on the result rather than throwing.
 *
 * The whole-file `mock.module` swap is hoisted; each test rebinds
 * `analyzeImpl` to control whether AxeBuilder.analyze() resolves, hangs,
 * or throws. Pattern mirrors flow-runner.test.ts's `currentStub` shape.
 */

let analyzeImpl: () => Promise<unknown> = async () => ({
  violations: [],
  passes: [],
  incomplete: [],
  inapplicable: [],
});
mock.module("@axe-core/playwright", () => ({
  AxeBuilder: class {
    withTags() {
      return this;
    }
    analyze() {
      return analyzeImpl();
    }
  },
}));

describe("runAxe — timeout + signal contract", () => {
  test("successful analyze returns parsed violations and zero error", async () => {
    analyzeImpl = async () => ({
      violations: [
        {
          id: "label",
          impact: "serious",
          help: "Form elements must have labels",
          helpUrl: "https://example.com/label",
          nodes: [{ target: ["input#x"], html: "<input id=x>" }],
        },
      ],
      passes: [{}, {}],
      incomplete: [],
      inapplicable: [{}],
    });
    const { runAxe } = await import("./axe-scan.ts");
    const fakePage = { url: () => "https://example.com/" } as never;
    const result = await runAxe(fakePage);
    expect(result.error).toBeUndefined();
    expect(result.violations).toHaveLength(1);
    expect(result.violations[0]?.id).toBe("label");
    expect(result.passes).toBe(2);
    expect(result.inapplicable).toBe(1);
  });

  test("caller-supplied AbortSignal aborts pending analyze with surfaced error", async () => {
    analyzeImpl = () => new Promise<never>(() => {});
    const { runAxe } = await import("./axe-scan.ts");
    const fakePage = {
      url: () => "https://example.com/",
      evaluate: async () => undefined,
    } as never;
    const controller = new AbortController();
    const start = Date.now();
    const p = runAxe(fakePage, controller.signal);
    setTimeout(() => controller.abort(), 50);
    const result = await p;
    const elapsed = Date.now() - start;
    expect(elapsed).toBeLessThan(2_000);
    expect(result.error).toContain("aborted");
    expect(result.violations).toHaveLength(0);
  }, 5_000);

  test("pre-aborted signal short-circuits with error", async () => {
    analyzeImpl = () => new Promise<never>(() => {});
    const { runAxe } = await import("./axe-scan.ts");
    const fakePage = {
      url: () => "https://example.com/",
      evaluate: async () => undefined,
    } as never;
    const controller = new AbortController();
    controller.abort();
    const result = await runAxe(fakePage, controller.signal);
    expect(result.error).toContain("aborted");
  });
});
