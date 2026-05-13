import { describe, expect, test } from "bun:test";
import {
  GiveUpClassSchema,
  StepVerdictSchema,
  type GiveUpClass,
} from "./step-judge.ts";

describe("GiveUpClassSchema", () => {
  test("accepts all four categories", () => {
    const cases: GiveUpClass[] = ["bug", "confusing_ux", "feature_gap", "not_a_bug"];
    for (const c of cases) {
      expect(GiveUpClassSchema.parse(c)).toBe(c);
    }
  });

  test("rejects unknown category", () => {
    expect(() => GiveUpClassSchema.parse("blocker")).toThrow();
  });
});

describe("StepVerdictSchema", () => {
  test("accepts give_up + classification", () => {
    const v = StepVerdictSchema.parse({
      status: "give_up",
      give_up_reason: "no failed items visible",
      give_up_class: "not_a_bug",
      evidence: "page text shows '0 Failed' tile",
    });
    expect(v.status).toBe("give_up");
    expect(v.give_up_class).toBe("not_a_bug");
  });

  test("treats classification as optional", () => {
    // success verdicts don't need a classification.
    const v = StepVerdictSchema.parse({
      status: "success",
      evidence: "outline shows [16] heading 'Library Destinations'",
    });
    expect(v.status).toBe("success");
    expect(v.give_up_class).toBeUndefined();
  });

  test("rejects unknown classification", () => {
    expect(() =>
      StepVerdictSchema.parse({
        status: "give_up",
        give_up_class: "wat",
        evidence: "x",
      }),
    ).toThrow();
  });
});
