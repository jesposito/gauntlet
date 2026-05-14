import { describe, expect, test } from "bun:test";
import {
  GiveUpClassSchema,
  normalizeVerdict,
  RawStepVerdictSchema,
  StepVerdictSchema,
  type GiveUpClass,
  type StepVerdict,
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

describe("StepVerdictSchema (discriminated union)", () => {
  test("accepts give_up + classification + reason", () => {
    const v = StepVerdictSchema.parse({
      status: "give_up",
      give_up_reason: "no failed items visible",
      give_up_class: "not_a_bug",
      evidence: "page text shows '0 Failed' tile",
    });
    expect(v.status).toBe("give_up");
    if (v.status === "give_up") {
      expect(v.give_up_class).toBe("not_a_bug");
      expect(v.give_up_reason).toBe("no failed items visible");
    }
  });

  test("accepts success without classification fields", () => {
    const v = StepVerdictSchema.parse({
      status: "success",
      evidence: "outline shows [16] heading 'Library Destinations'",
    });
    expect(v.status).toBe("success");
    // success variant has no give_up_class — narrowed by discriminant
    if (v.status === "success") {
      expect(v.evidence).toContain("Library Destinations");
    }
  });

  test("accepts in_progress without classification fields", () => {
    const v = StepVerdictSchema.parse({
      status: "in_progress",
      evidence: "form opened, fields visible",
    });
    expect(v.status).toBe("in_progress");
  });

  test("rejects give_up with missing give_up_class (strict union)", () => {
    // The strict StepVerdictSchema requires give_up_class on give_up. The
    // judge calls a permissive raw schema and normalizes — see normalization
    // tests below — but consumers using StepVerdictSchema directly should
    // reject malformed inputs rather than silently accept them.
    expect(() =>
      StepVerdictSchema.parse({
        status: "give_up",
        give_up_reason: "x",
        evidence: "y",
      }),
    ).toThrow();
  });

  test("rejects give_up with missing give_up_reason (strict union)", () => {
    expect(() =>
      StepVerdictSchema.parse({
        status: "give_up",
        give_up_class: "bug",
        evidence: "y",
      }),
    ).toThrow();
  });

  test("rejects unknown classification", () => {
    expect(() =>
      StepVerdictSchema.parse({
        status: "give_up",
        give_up_reason: "x",
        give_up_class: "wat",
        evidence: "x",
      }),
    ).toThrow();
  });
});

describe("normalizeVerdict (permissive AI output -> strict union)", () => {
  // Real-world dogfood (audplexus 2026-05-13): the AI judge returned
  // status=give_up verdicts with no give_up_class field across 4/4 abandoned
  // flows. Normalization defaults the missing class to "bug" so the abandon
  // is never silently downgraded to noise.
  test("defaults missing give_up_class on give_up to 'bug'", () => {
    const raw = RawStepVerdictSchema.parse({
      status: "give_up",
      give_up_reason: "no Failed heading",
      evidence: "outline shows only 'Diagnostics' and 'Issue Inbox' headings",
    });
    const v = normalizeVerdict(raw);
    expect(v.status).toBe("give_up");
    if (v.status === "give_up") {
      expect(v.give_up_class).toBe("bug");
    }
  });

  test("defaults missing give_up_reason to evidence text", () => {
    const raw = RawStepVerdictSchema.parse({
      status: "give_up",
      evidence: "no Failed heading on dashboard",
    });
    const v = normalizeVerdict(raw);
    if (v.status === "give_up") {
      expect(v.give_up_reason).toBe("no Failed heading on dashboard");
      expect(v.give_up_class).toBe("bug");
    }
  });

  test("preserves an existing give_up_class", () => {
    const raw = RawStepVerdictSchema.parse({
      status: "give_up",
      give_up_reason: "no Failed heading",
      give_up_class: "feature_gap",
      evidence: "outline shows only 'Diagnostics' and 'Issue Inbox' headings",
    });
    const v = normalizeVerdict(raw);
    if (v.status === "give_up") {
      expect(v.give_up_class).toBe("feature_gap");
    }
  });

  test("accepts null on optional fields (facets-sh 2026-05-14 dogfood)", () => {
    // Real AI output that crashed the run pre-fix:
    //   {"status":"success","evidence":"...","give_up_reason":null,"give_up_class":null}
    // Pre-fix the schema rejected with `give_up_reason: Expected string,
    // received null` and the error escaped as outcome="error". `.nullish()`
    // accepts null + undefined; normalization collapses both away.
    const raw = RawStepVerdictSchema.parse({
      status: "success",
      give_up_reason: null,
      give_up_class: null,
      evidence: "Heading [6] visible, no modal.",
    });
    const v = normalizeVerdict(raw);
    expect(v.status).toBe("success");
    expect("give_up_reason" in v).toBe(false);
    expect("give_up_class" in v).toBe(false);
  });

  test("accepts null on a give_up verdict and defaults class to 'bug'", () => {
    const raw = RawStepVerdictSchema.parse({
      status: "give_up",
      give_up_reason: null,
      give_up_class: null,
      evidence: "no help text on the form",
    });
    const v = normalizeVerdict(raw);
    if (v.status === "give_up") {
      expect(v.give_up_class).toBe("bug");
      expect(v.give_up_reason).toBe("no help text on the form");
    } else {
      throw new Error("expected give_up");
    }
  });

  test("strips give_up fields from non-give_up verdicts", () => {
    // Even if the AI hallucinated extra fields on a success, normalization
    // returns the strict shape. The discriminated union enforces it.
    const raw = RawStepVerdictSchema.parse({
      status: "success",
      give_up_reason: "should not be here",
      give_up_class: "bug",
      evidence: "outline shows [16] heading 'Library Destinations'",
    });
    const v = normalizeVerdict(raw);
    expect(v.status).toBe("success");
    expect("give_up_reason" in v).toBe(false);
    expect("give_up_class" in v).toBe(false);
  });

  test("normalized verdict round-trips through strict schema", () => {
    const raw = RawStepVerdictSchema.parse({
      status: "give_up",
      evidence: "missing affordance",
    });
    const v = normalizeVerdict(raw);
    expect(() => StepVerdictSchema.parse(v)).not.toThrow();
  });
});

describe("StepVerdict discriminated narrowing", () => {
  // Compile-time guarantee that the discriminated union narrows correctly.
  // If a future refactor re-introduces optional give_up fields on non-give_up
  // variants, this test will fail to compile.
  test("narrows give_up branch to require both fields", () => {
    const v: StepVerdict = {
      status: "give_up",
      give_up_reason: "no Failed heading",
      give_up_class: "bug",
      evidence: "outline shows only 'Diagnostics' and 'Issue Inbox' headings",
    };
    if (v.status === "give_up") {
      // No optional access needed here — the union guarantees presence.
      const reason: string = v.give_up_reason;
      const cls: GiveUpClass = v.give_up_class;
      expect(reason.length).toBeGreaterThan(0);
      expect(cls).toBe("bug");
    }
  });
});
