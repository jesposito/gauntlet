import { describe, expect, test } from "bun:test";
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
