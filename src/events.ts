/**
 * Cross-phase event stream for gauntlet. One source of truth that two renderers
 * (human text + JSONL for agents like Claude driving gauntlet via Bash) consume
 * independently. See docs/UX-DESIGN-PROPOSAL.md for the design rationale.
 *
 * Design principles enforced by this module:
 *   - Every long-running operation must emit a heartbeat at least every 5s.
 *   - Cache hits are visible (ai_call_end carries `cached: boolean`).
 *   - Concurrent personas are visually attributable (events carry personaId).
 *   - Format degrades gracefully — text renderer drops ANSI on non-TTY,
 *     JSONL renderer is identical regardless of stdout.
 *   - Zero measurable overhead — events emit synchronously from call sites.
 *
 * The existing FlowEvent union in src/runner/flow-runner.ts is the run-phase
 * subset of this. We adapt FlowEvent -> GauntletEvent at the bridge below so
 * the runner doesn't need a wholesale refactor.
 */

import type { FlowEvent } from "./runner/flow-runner.ts";

export type Phase = "init" | "flows" | "run" | "vet" | "report";

export type AiCallPurpose =
  | "surface_gen"
  | "persona_gen"
  | "flow_gen"
  | "observe"
  | "act"
  | "judge";

export type VetStatus = "verified" | "regressed" | "subjective" | "could_not_replay";
export type FlowOutcome =
  | "completed"
  | "abandoned"
  | "patience_exceeded"
  | "timeout"
  | "error";

export type GauntletEvent =
  // Phase events
  | { type: "phase_start"; phase: Phase; label: string; ts: number }
  | { type: "phase_end"; phase: Phase; durationMs: number; ts: number }

  // AI call events (visibility into cache hit vs live call)
  | {
      type: "ai_call_start";
      callId: string;
      purpose: AiCallPurpose;
      model: string;
      ts: number;
    }
  | {
      type: "ai_call_end";
      callId: string;
      durationMs: number;
      cached: boolean;
      ts: number;
    }

  // Run-phase events — superset of FlowEvent. Adapter below converts.
  | {
      type: "flow_start";
      personaId: string;
      flowId: string;
      totalSteps: number;
      ts: number;
    }
  | {
      type: "step_start";
      personaId: string;
      flowId: string;
      stepIndex: number;
      intent: string;
      ts: number;
    }
  | {
      type: "step_observe";
      personaId: string;
      flowId: string;
      stepIndex: number;
      matched: boolean;
      reasoning: string;
      ts: number;
    }
  | {
      type: "step_act";
      personaId: string;
      flowId: string;
      stepIndex: number;
      action: string | undefined;
      targetName: string | undefined;
      performed: boolean;
      error?: string;
      ts: number;
    }
  | {
      type: "step_verdict";
      personaId: string;
      flowId: string;
      stepIndex: number;
      status: "success" | "in_progress" | "give_up";
      evidence: string;
      ts: number;
    }
  | {
      type: "flow_end";
      personaId: string;
      flowId: string;
      outcome: FlowOutcome;
      durationMs: number;
      ts: number;
    }

  // Vetting-phase events — the felt-bad moment we are eliminating
  | { type: "vet_start"; total: number; distinctUrls: number; ts: number }
  | {
      type: "vet_url_start";
      url: string;
      findingCount: number;
      sessionIndex: number;
      sessionTotal: number;
      ts: number;
    }
  | {
      type: "vet_url_navigate";
      url: string;
      durationMs: number;
      ok: boolean;
      ts: number;
    }
  | { type: "vet_url_axe_start"; url: string; ts: number }
  | {
      type: "vet_url_axe_end";
      url: string;
      violationCount: number;
      durationMs: number;
      ts: number;
    }
  | {
      type: "vet_finding";
      findingIndex: number;
      total: number;
      findingId: string;
      status: VetStatus;
      ruleId?: string;
      ts: number;
    }
  | { type: "vet_url_close"; url: string; ts: number }
  | {
      type: "vet_end";
      verified: number;
      regressed: number;
      subjective: number;
      couldNotReplay: number;
      durationMs: number;
      ts: number;
    }

  // Heartbeat — emitted on a timer during long ops so the renderer can show
  // elapsed-time spinner. Cleared automatically when the matching _end fires.
  | {
      type: "heartbeat";
      phase: Phase;
      label: string;
      elapsedMs: number;
      ts: number;
    }

  // Diagnostics
  | { type: "warn"; message: string; context?: string; ts: number }
  | { type: "error"; message: string; context?: string; ts: number };

export type EventEmitter = (e: GauntletEvent) => void;

/** Default no-op emitter so callers can pass it without a feature flag. */
export const nullEmitter: EventEmitter = () => undefined;

/** Multiplex a single event to N renderers. */
export function multiplex(...emitters: EventEmitter[]): EventEmitter {
  if (emitters.length === 0) return nullEmitter;
  if (emitters.length === 1) return emitters[0]!;
  return (e: GauntletEvent) => {
    for (const r of emitters) r(e);
  };
}

/**
 * Bridge the existing FlowEventHandler signature to the broader GauntletEvent.
 * The runner can stay on FlowEvent + onEvent without churning every call site;
 * the CLI plugs in this adapter to inject ts and forward to the renderers.
 */
export function flowEventBridge(emit: EventEmitter): (e: FlowEvent) => void {
  return (e: FlowEvent) => {
    const ts = Date.now();
    switch (e.type) {
      case "flow_start":
        emit({ ...e, ts });
        return;
      case "step_start":
        emit({ ...e, ts });
        return;
      case "step_observe":
        emit({ ...e, ts });
        return;
      case "step_act":
        emit({ ...e, ts });
        return;
      case "step_verdict":
        emit({ ...e, ts });
        return;
      case "flow_end":
        emit({ ...e, ts });
        return;
    }
  };
}

/**
 * Monotonic id generator for correlating ai_call_start / ai_call_end pairs.
 * Not cryptographic — just unique within a process run.
 */
let _callIdSeq = 0;
export function nextCallId(): string {
  _callIdSeq += 1;
  return `ai-${_callIdSeq.toString(36)}`;
}
