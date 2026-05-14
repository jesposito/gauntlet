import { describe, expect, test } from "bun:test";
import { flowEventBridge, multiplex, nextCallId, nullEmitter } from "./events.ts";
import type { FlowEvent } from "./runner/flow-runner.ts";
import type { GauntletEvent } from "./events.ts";

describe("nextCallId", () => {
  test("produces unique ids in sequence", () => {
    const a = nextCallId();
    const b = nextCallId();
    expect(a).not.toBe(b);
    expect(a).toMatch(/^ai-/);
  });
});

describe("multiplex", () => {
  test("fans an event to every emitter", () => {
    const sinkA: GauntletEvent[] = [];
    const sinkB: GauntletEvent[] = [];
    const emit = multiplex(
      (e) => sinkA.push(e),
      (e) => sinkB.push(e),
    );
    emit({ type: "warn", message: "x", ts: 1 });
    expect(sinkA).toHaveLength(1);
    expect(sinkB).toHaveLength(1);
  });

  test("collapses to nullEmitter when zero emitters provided", () => {
    const emit = multiplex();
    expect(emit).toBe(nullEmitter);
  });

  test("returns the single emitter as-is when only one provided", () => {
    const fn = (_e: GauntletEvent) => undefined;
    expect(multiplex(fn)).toBe(fn);
  });
});

describe("flowEventBridge", () => {
  test("attaches ts to every forwarded FlowEvent", () => {
    const captured: GauntletEvent[] = [];
    const bridge = flowEventBridge((e) => captured.push(e));
    const fe: FlowEvent = {
      type: "flow_start",
      personaId: "mary",
      flowId: "f1",
      totalSteps: 3,
    };
    bridge(fe);
    expect(captured).toHaveLength(1);
    const out = captured[0]!;
    if (out.type === "flow_start") {
      expect(out.personaId).toBe("mary");
      expect(typeof out.ts).toBe("number");
    } else {
      throw new Error("expected flow_start");
    }
  });

  test("forwards every variant of FlowEvent", () => {
    const captured: GauntletEvent[] = [];
    const bridge = flowEventBridge((e) => captured.push(e));
    const events: FlowEvent[] = [
      { type: "flow_start", personaId: "p", flowId: "f", totalSteps: 1 },
      { type: "step_start", personaId: "p", flowId: "f", stepIndex: 0, intent: "i" },
      {
        type: "step_observe",
        personaId: "p",
        flowId: "f",
        stepIndex: 0,
        matched: true,
        reasoning: "r",
      },
      {
        type: "step_act",
        personaId: "p",
        flowId: "f",
        stepIndex: 0,
        action: "click",
        targetName: "x",
        performed: true,
      },
      {
        type: "step_verdict",
        personaId: "p",
        flowId: "f",
        stepIndex: 0,
        status: "success",
        evidence: "e",
      },
      { type: "flow_end", personaId: "p", flowId: "f", outcome: "completed", durationMs: 10 },
    ];
    for (const e of events) bridge(e);
    expect(captured.map((e) => e.type)).toEqual([
      "flow_start",
      "step_start",
      "step_observe",
      "step_act",
      "step_verdict",
      "flow_end",
    ]);
  });
});
