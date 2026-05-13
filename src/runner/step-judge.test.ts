import { describe, expect, test } from "bun:test";
import {
  ensureGiveUpClass,
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

describe("ensureGiveUpClass", () => {
  // Real-world dogfood (audplexus 2026-05-13): the AI judge returned status=give_up
  // verdicts with no give_up_class field across 4/4 abandoned flows, so the
  // auto-downgrade path in report rendering never fired and every abandon
  // landed as a serious finding. ensureGiveUpClass is the post-parse safety net.
  test("defaults missing give_up_class on give_up verdict to 'bug'", () => {
    const v = ensureGiveUpClass({
      status: "give_up",
      give_up_reason: "no Failed heading",
      evidence: "outline shows only 'Diagnostics' and 'Issue Inbox' headings",
    });
    expect(v.give_up_class).toBe("bug");
  });

  test("preserves an existing give_up_class on give_up verdict", () => {
    const v = ensureGiveUpClass({
      status: "give_up",
      give_up_reason: "no Failed heading",
      give_up_class: "feature_gap",
      evidence: "outline shows only 'Diagnostics' and 'Issue Inbox' headings",
    });
    expect(v.give_up_class).toBe("feature_gap");
  });

  test("does not touch non-give_up verdicts", () => {
    const ok = ensureGiveUpClass({
      status: "success",
      evidence: "outline shows [16] heading 'Library Destinations'",
    });
    expect(ok.give_up_class).toBeUndefined();

    const inProgress = ensureGiveUpClass({
      status: "in_progress",
      evidence: "form opened, fields visible",
    });
    expect(inProgress.give_up_class).toBeUndefined();
  });
});
