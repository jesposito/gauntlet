import { describe, expect, test } from "bun:test";
import { rollUp } from "./rollup.ts";
import { FailureReason } from "../runner/failure-reasons.ts";
import type { Finding, PersonaReport } from "./schema.ts";

function findingF(over: Partial<Finding>): Finding {
  return {
    id: "x",
    personaId: "p",
    url: "http://x",
    reason: FailureReason.ACCESSIBILITY_VIOLATION,
    severity: "serious",
    title: "t",
    detail: "d",
    artifacts: {},
    replayStrategy: "axe_recheck",
    vetting: { status: "unverified" },
    ...over,
  };
}

function pr(id: string, findings: Finding[]): PersonaReport {
  return { personaId: id, personaName: id, flows: [], findings };
}

describe("rollUp", () => {
  test("returns empty when no shared signatures", () => {
    const a = pr("a", [findingF({ id: "1", personaId: "a", axeRuleId: "label", url: "u1" })]);
    const b = pr("b", [findingF({ id: "2", personaId: "b", axeRuleId: "button-name", url: "u1" })]);
    expect(rollUp([a, b])).toEqual([]);
  });

  test("groups same axe rule + url across personas", () => {
    const a = pr("a", [findingF({ id: "1", personaId: "a", axeRuleId: "label", url: "u1", title: "Label missing" })]);
    const b = pr("b", [findingF({ id: "2", personaId: "b", axeRuleId: "label", url: "u1", title: "Label missing" })]);
    const r = rollUp([a, b]);
    expect(r).toHaveLength(1);
    expect(r[0]?.signature).toBe("axe:label@u1");
    expect(r[0]?.count).toBe(2);
    expect(r[0]?.personas.sort()).toEqual(["a", "b"]);
  });

  test("ignores single-persona signatures", () => {
    const a = pr("a", [
      findingF({ id: "1", personaId: "a", axeRuleId: "label", url: "u1" }),
      findingF({ id: "2", personaId: "a", axeRuleId: "label", url: "u1" }),
    ]);
    expect(rollUp([a])).toEqual([]);
  });

  test("non-axe findings dedupe on (reason, url)", () => {
    const a = pr("a", [findingF({ id: "1", personaId: "a", reason: FailureReason.CONSOLE_ERROR, url: "u1", replayStrategy: "navigation_only" })]);
    const b = pr("b", [findingF({ id: "2", personaId: "b", reason: FailureReason.CONSOLE_ERROR, url: "u1", replayStrategy: "navigation_only" })]);
    const r = rollUp([a, b]);
    expect(r).toHaveLength(1);
    expect(r[0]?.signature).toBe(`${FailureReason.CONSOLE_ERROR}@u1`);
  });

  test("sorts by descending count", () => {
    const a = pr("a", [findingF({ id: "1", personaId: "a", axeRuleId: "label", url: "u1" }), findingF({ id: "3", personaId: "a", axeRuleId: "button-name", url: "u1" })]);
    const b = pr("b", [findingF({ id: "2", personaId: "b", axeRuleId: "label", url: "u1" }), findingF({ id: "4", personaId: "b", axeRuleId: "button-name", url: "u1" })]);
    const c = pr("c", [findingF({ id: "5", personaId: "c", axeRuleId: "label", url: "u1" })]);
    const r = rollUp([a, b, c]);
    expect(r[0]?.signature).toBe("axe:label@u1");
    expect(r[0]?.count).toBe(3);
    expect(r[1]?.signature).toBe("axe:button-name@u1");
    expect(r[1]?.count).toBe(2);
  });
});
