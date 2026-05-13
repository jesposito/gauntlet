import { describe, expect, test } from "bun:test";
import { classifyFlowError, FLOW_WALLCLOCK_BUDGET_MS } from "./flow-runner.ts";

/**
 * Pure-function tests for the wallclock-vs-error outcome classifier. The
 * full runFlow integration (wallclock alarm fires, browser force-closes,
 * in-flight Playwright await rejects, outer catch reclassifies) cannot be
 * unit-tested without spawning chromium — but the classification rule itself
 * is the load-bearing logic. Keeping it in a pure function makes the rule
 * unmistakable: if the wallclock fired, the flow is a timeout; otherwise
 * it's an error. The rule used to live as inline `if` branches inside the
 * catch, which let an earlier refactor incorrectly leak browser-close errors
 * out as outcome="error" instead of "timeout".
 */
describe("classifyFlowError", () => {
  test("wallclock fired -> outcome='timeout' regardless of error type", () => {
    const r = classifyFlowError({
      err: new Error("Target page, context or browser has been closed"),
      wallclockFired: true,
      wallclockBudgetMs: 5_000,
    });
    expect(r.outcome).toBe("timeout");
    expect(r.outcomeReason).toContain("wallclock alarm fired at 5s");
  });

  test("wallclock fired with non-Error throwable -> still 'timeout'", () => {
    const r = classifyFlowError({
      err: "playwright went sideways",
      wallclockFired: true,
      wallclockBudgetMs: 60_000,
    });
    expect(r.outcome).toBe("timeout");
  });

  test("no wallclock + Error -> outcome='error' with message", () => {
    const r = classifyFlowError({
      err: new Error("provider crashed"),
      wallclockFired: false,
      wallclockBudgetMs: 60_000,
    });
    expect(r.outcome).toBe("error");
    expect(r.outcomeReason).toBe("provider crashed");
  });

  test("no wallclock + string throwable -> stringified", () => {
    const r = classifyFlowError({
      err: "weird non-error throw",
      wallclockFired: false,
      wallclockBudgetMs: 60_000,
    });
    expect(r.outcome).toBe("error");
    expect(r.outcomeReason).toBe("weird non-error throw");
  });

  test("wallclock budget rendered in seconds", () => {
    const r = classifyFlowError({
      err: new Error("x"),
      wallclockFired: true,
      wallclockBudgetMs: FLOW_WALLCLOCK_BUDGET_MS,
    });
    expect(r.outcomeReason).toContain(`${FLOW_WALLCLOCK_BUDGET_MS / 1000}s`);
  });
});
