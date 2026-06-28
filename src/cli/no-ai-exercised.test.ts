/**
 * Unit tests for the no-flows / dead-key guard in cmdRun. A run that made ZERO
 * live AI calls AND replayed nothing from cache exits 0 and looks green, but
 * never exercised the persona path — masking an expired key or a roster with no
 * flows. shouldWarnNoAiExercised is the pure detector; cmdRun emits
 * NO_AI_EXERCISED_MESSAGE as a `warn` event (routed through the global emitter,
 * so it reaches both renderers) when it returns true.
 *
 * Liveness is the count of non-cached `ai_call_end` events the parent observed
 * (liveAiCalls), which is ground truth in BOTH supervised (default) and
 * in-process modes — see the docstring on shouldWarnNoAiExercised.
 */

import { describe, expect, test } from "bun:test";
import {
  NO_AI_EXERCISED_MESSAGE,
  shouldWarnNoAiExercised,
} from "../cli.ts";

describe("shouldWarnNoAiExercised", () => {
  test("warns when zero flows ran (legacy no-flows / single-step path)", () => {
    expect(
      shouldWarnNoAiExercised({ totalFlows: 0, liveAiCalls: 0, cacheHits: 0 }),
    ).toBe(true);
  });

  test("warns when flows ran but made 0 live calls and 0 replays (dead-key sig)", () => {
    // e.g. dead key surfaced as every flow erroring before any propose() call:
    // nothing live, nothing pulled from cache.
    expect(
      shouldWarnNoAiExercised({ totalFlows: 3, liveAiCalls: 0, cacheHits: 0 }),
    ).toBe(true);
  });

  test("does NOT warn on a warm-cache replay run (flows ran, served from cache)", () => {
    // The defining regression: re-running flows against a warm cache makes zero
    // LIVE calls but proves the flow/roster path ran. Telling the user to check
    // their key here was a guaranteed false positive on the fast-iteration loop.
    expect(
      shouldWarnNoAiExercised({ totalFlows: 2, liveAiCalls: 0, cacheHits: 12 }),
    ).toBe(false);
  });

  test("does NOT warn when live calls were made", () => {
    expect(
      shouldWarnNoAiExercised({ totalFlows: 2, liveAiCalls: 10, cacheHits: 0 }),
    ).toBe(false);
  });

  test("does NOT warn on a mixed run (some live, some replayed)", () => {
    expect(
      shouldWarnNoAiExercised({ totalFlows: 1, liveAiCalls: 4, cacheHits: 4 }),
    ).toBe(false);
  });

  test("supervised default: live calls counted off the event stream suppress the warn", () => {
    // Regression guard for the supervised-mode false positive: in the default
    // mode the parent's AiCache stats stay {0,0,0} (propose runs in the worker),
    // but liveAiCalls is sourced from forwarded ai_call_end events, so a real
    // run with flows>0 does NOT warn even with cacheHits===0.
    expect(
      shouldWarnNoAiExercised({ totalFlows: 3, liveAiCalls: 9, cacheHits: 0 }),
    ).toBe(false);
  });

  test("--no-cache: a flows run that made live calls does NOT warn", () => {
    // Cache off => cacheHits stays 0, but live calls are still counted, so a
    // genuine run is not a false positive.
    expect(
      shouldWarnNoAiExercised({ totalFlows: 3, liveAiCalls: 6, cacheHits: 0 }),
    ).toBe(false);
  });

  test("still warns on the legacy no-flows path regardless of cache", () => {
    expect(
      shouldWarnNoAiExercised({ totalFlows: 0, liveAiCalls: 0, cacheHits: 0 }),
    ).toBe(true);
  });
});

describe("NO_AI_EXERCISED_MESSAGE", () => {
  test("does not assert a single cause and points at the recovery paths", () => {
    expect(NO_AI_EXERCISED_MESSAGE).toContain("0 live AI calls");
    expect(NO_AI_EXERCISED_MESSAGE).toContain("gauntlet flows");
    expect(NO_AI_EXERCISED_MESSAGE).toContain("gauntlet doctor");
    // It must NOT flatly claim "no flows ran" as the cause — that was the
    // misleading wording fired on every warm-cache replay.
    expect(NO_AI_EXERCISED_MESSAGE).not.toContain("no flows ran (legacy capture). ");
  });
});
