/**
 * Text renderer for the GauntletEvent stream. One file, no deps. Two modes:
 *
 *   - TTY: ANSI spinner + color, single-line in-place updates for the
 *     currently-active long op (AI call, axe scan), settled completion lines
 *     when the op ends.
 *   - Non-TTY (CI / piped): plain timestamped lines, no spinner, no ANSI.
 *
 * Design constraints (see docs/UX-DESIGN-PROPOSAL.md):
 *   - Heartbeat at least every 5s during any AI call or axe scan.
 *   - Cache hits visible (`cached=true` shown explicitly so users know why
 *     a run was fast).
 *   - Concurrent personas are color-coded so interleaved lines are scannable.
 *   - The single source of truth (events.ts) doesn't change shape between
 *     modes; only this renderer differs.
 */

import type { GauntletEvent, Phase } from "../events.ts";

const SPINNER_FRAMES = ["⠋", "⠙", "⠹", "⠸", "⠼", "⠴", "⠦", "⠧", "⠇", "⠏"];
const SPINNER_INTERVAL_MS = 80;
const HEARTBEAT_MIN_MS = 250; // throttle redraws
/**
 * Persona color cycle for concurrent runs — 6 distinct ANSI colors so the
 * eye can group lines by persona at a glance. Adjacent personas in the
 * curated set get different colors deterministically.
 */
const PERSONA_COLORS = ["36", "35", "33", "32", "34", "31"]; // cyan/magenta/yellow/green/blue/red

const ANSI = {
  reset: "\x1b[0m",
  dim: "\x1b[2m",
  bold: "\x1b[1m",
  green: "\x1b[32m",
  red: "\x1b[31m",
  yellow: "\x1b[33m",
  cyan: "\x1b[36m",
  clearLine: "\x1b[2K",
  cursorStart: "\r",
};

export interface TextRendererOptions {
  isTTY?: boolean;
  color?: boolean;
  /** When false, suppress per-step detail but keep phase headers. */
  verbose?: boolean;
  /** Total steps for headerless quiet mode. */
  quiet?: boolean;
  /** Test seam: write target. Defaults to process.stdout. */
  out?: { write: (s: string) => unknown };
}

interface ActiveOp {
  label: string;
  startedAt: number;
  phase: Phase;
}

export function createTextRenderer(opts: TextRendererOptions = {}): (e: GauntletEvent) => void {
  const out = opts.out ?? process.stdout;
  const isTTY = opts.isTTY ?? (process.stdout.isTTY ?? false);
  const color = opts.color ?? (isTTY && process.env["NO_COLOR"] === undefined);
  const quiet = opts.quiet === true;

  // Track in-flight long ops by stable key (callId for AI, url for axe).
  // The spinner timer redraws the most recent active op every SPINNER_INTERVAL_MS.
  const active = new Map<string, ActiveOp>();
  let spinnerTimer: ReturnType<typeof setInterval> | undefined;
  let spinnerFrame = 0;
  let lineActive = false; // we have an unterminated spinner line on screen
  let lastDraw = 0;

  // Stable persona color assignment.
  const personaIdToColor = new Map<string, string>();
  function colorForPersona(personaId: string): string {
    let c = personaIdToColor.get(personaId);
    if (c === undefined) {
      c = PERSONA_COLORS[personaIdToColor.size % PERSONA_COLORS.length]!;
      personaIdToColor.set(personaId, c);
    }
    return c;
  }

  // Stable persona short-label assignment with collision disambiguation.
  // Real-world dogfood (facets-sh 2026-05-14): first-segment shortname
  // collapsed `marketing-commuter-prospect` and `marketing-skeptical-creator`
  // both to `[marketing]`, defeating per-persona attribution. Color still
  // disambiguated but the label was wrong. Strategy: take the LAST segment
  // (almost always the most distinctive — "prospect", "creator", "newcomer"
  // — since persona IDs typically follow `<surface>-<role>-<descriptor>`).
  // On collision with an already-seen persona, fall through to last-2,
  // last-3, then the full id (capped at 16 chars).
  const personaIdToShort = new Map<string, string>();
  function shortNameFor(personaId: string): string {
    const cached = personaIdToShort.get(personaId);
    if (cached !== undefined) return cached;
    const segs = personaId.split("-").filter(Boolean);
    const candidates = [
      segs[segs.length - 1],
      segs.slice(-2).join("-"),
      segs.slice(-3).join("-"),
      personaId,
    ].filter((c): c is string => typeof c === "string" && c.length > 0);
    const taken = new Set(personaIdToShort.values());
    let chosen = personaId;
    for (const c of candidates) {
      if (!taken.has(c)) {
        chosen = c;
        break;
      }
    }
    if (chosen.length > 16) chosen = chosen.slice(0, 15) + "…";
    personaIdToShort.set(personaId, chosen);
    return chosen;
  }

  function paint(text: string, ansi: string): string {
    if (!color) return text;
    return `\x1b[${ansi}m${text}${ANSI.reset}`;
  }

  function clearSpinnerLine(): void {
    if (!isTTY || !lineActive) return;
    out.write(ANSI.cursorStart + ANSI.clearLine);
    lineActive = false;
  }

  function drawSpinner(force = false): void {
    if (!isTTY || active.size === 0) return;
    const now = Date.now();
    if (!force && now - lastDraw < HEARTBEAT_MIN_MS) return;
    lastDraw = now;
    // Draw the most-recently-started op (LIFO) so concurrent ops don't fight.
    const ops = Array.from(active.values());
    const op = ops[ops.length - 1]!;
    const elapsed = ((now - op.startedAt) / 1000).toFixed(1);
    const frame = SPINNER_FRAMES[spinnerFrame % SPINNER_FRAMES.length]!;
    spinnerFrame += 1;
    const extra = active.size > 1 ? paint(` (+${active.size - 1} more)`, "2") : "";
    out.write(
      `${ANSI.cursorStart}${ANSI.clearLine}${paint(frame, "36")} ${op.label}${paint(` ${elapsed}s`, "2")}${extra}`,
    );
    lineActive = true;
  }

  function ensureSpinnerTimer(): void {
    if (spinnerTimer || !isTTY) return;
    spinnerTimer = setInterval(() => drawSpinner(false), SPINNER_INTERVAL_MS);
    // Don't keep the event loop alive on the spinner alone.
    spinnerTimer.unref?.();
  }

  function clearSpinnerTimer(): void {
    if (active.size === 0 && spinnerTimer) {
      clearInterval(spinnerTimer);
      spinnerTimer = undefined;
    }
  }

  function writeLine(line: string): void {
    clearSpinnerLine();
    out.write(line + "\n");
    drawSpinner(true); // redraw spinner below if any op still active
  }

  function startOp(key: string, label: string, phase: Phase): void {
    active.set(key, { label, startedAt: Date.now(), phase });
    ensureSpinnerTimer();
    drawSpinner(true);
  }

  function endOp(key: string, completionLine: string | undefined): void {
    const op = active.get(key);
    active.delete(key);
    if (completionLine !== undefined) writeLine(completionLine);
    if (active.size === 0) {
      clearSpinnerLine();
      clearSpinnerTimer();
    } else {
      drawSpinner(true);
    }
    void op; // could log per-op stats here later
  }

  // === Event handler ===
  return (e: GauntletEvent): void => {
    switch (e.type) {
      case "phase_start": {
        // Phase headers are kept even in quiet mode — they bound the run
        // structurally and make logs greppable. Only per-step detail is
        // suppressed by quiet.
        clearSpinnerLine();
        out.write(`\n${paint(`[Phase ${e.phase}]`, "1")} ${e.label}\n`);
        return;
      }

      case "phase_end": {
        if (quiet) return;
        return; // phase_end is for JSONL/timing; text output is implicit in the next phase header
      }

      case "setup_op_start": {
        // Setup ops can wedge silently (browser_launch / new_context / goto on
        // slow sites). Use the spinner to make "currently doing X" visible.
        startOp(`setup:${e.personaId}:${e.flowId}:${e.op}`, `setup ${e.op}`, "run");
        return;
      }

      case "setup_op_end": {
        const status = e.ok ? paint("done", "32") : paint("failed", "31");
        const detail = e.ok ? "" : `: ${truncate(e.error ?? "error", 80)}`;
        endOp(
          `setup:${e.personaId}:${e.flowId}:${e.op}`,
          quiet
            ? undefined
            : `    setup ${e.op}  ${status}  ${(e.durationMs / 1000).toFixed(1)}s${detail}`,
        );
        return;
      }

      case "ai_call_start": {
        const label = `AI: ${e.purpose}`;
        startOp(e.callId, label, /* best-guess phase: */ purposeToPhase(e.purpose));
        return;
      }

      case "ai_call_end": {
        const cachedTag = e.cached ? paint(" (cache hit)", "32") : "";
        const ms = e.durationMs;
        endOp(
          e.callId,
          quiet
            ? undefined
            : `  ${paint("AI", "36")} ${e.cached ? "cache" : "live"} ${(ms / 1000).toFixed(1)}s${cachedTag}`,
        );
        return;
      }

      case "vet_start": {
        if (quiet) return;
        writeLine(
          `\n${paint(`[Phase vet]`, "1")} vetting ${e.total} findings across ${e.distinctUrls} URL${e.distinctUrls === 1 ? "" : "s"}`,
        );
        return;
      }

      case "vet_url_start": {
        if (quiet) return;
        writeLine(
          `  session ${e.sessionIndex}/${e.sessionTotal}  ${e.url}  (${e.findingCount} finding${e.findingCount === 1 ? "" : "s"})`,
        );
        return;
      }

      case "vet_url_navigate": {
        if (quiet) return;
        const status = e.ok ? paint("done", "32") : paint("failed", "31");
        writeLine(`    navigating...  ${status}  ${(e.durationMs / 1000).toFixed(1)}s`);
        return;
      }

      case "vet_url_axe_start": {
        startOp(`axe:${e.url}`, "axe scan", "vet");
        return;
      }

      case "vet_url_axe_end": {
        const violations =
          e.violationCount === 0 ? paint("0 violations", "32") : `${e.violationCount} violations`;
        endOp(
          `axe:${e.url}`,
          quiet
            ? undefined
            : `    axe scan...    ${paint("done", "32")}  ${(e.durationMs / 1000).toFixed(1)}s  (${violations})`,
        );
        return;
      }

      case "vet_finding": {
        // No per-finding line in the human renderer — too noisy. The summary
        // counts at vet_end carry the load. JSONL still emits per-finding for
        // agents that want fine-grained progress.
        return;
      }

      case "vet_url_close": {
        return;
      }

      case "vet_end": {
        if (quiet) return;
        const dur = (e.durationMs / 1000).toFixed(1);
        writeLine(
          `\n  vetting complete: ${paint(`verified=${e.verified}`, "32")}  regressed=${e.regressed}  subjective=${e.subjective}  could_not_replay=${e.couldNotReplay}  (${dur}s)`,
        );
        return;
      }

      case "flow_start": {
        if (quiet) return;
        const c = colorForPersona(e.personaId);
        writeLine(
          `  ${paint(`[${shortNameFor(e.personaId)}]`, c)} ${e.flowId}  START (${e.totalSteps} step${e.totalSteps === 1 ? "" : "s"})`,
        );
        return;
      }

      case "step_start": {
        if (quiet) return;
        const c = colorForPersona(e.personaId);
        writeLine(
          `  ${paint(`[${shortNameFor(e.personaId)}]`, c)} step ${e.stepIndex + 1}: ${truncate(e.intent, 80)}`,
        );
        return;
      }

      case "step_observe": {
        if (quiet) return;
        const c = colorForPersona(e.personaId);
        const verdict = e.matched ? paint("MATCH", "32") : paint("NO MATCH", "31");
        writeLine(`    ${paint(`[${shortNameFor(e.personaId)}]`, c)} observe -> ${verdict}: ${truncate(e.reasoning, 90)}`);
        return;
      }

      case "step_act": {
        if (quiet) return;
        const c = colorForPersona(e.personaId);
        const status = e.performed ? paint("OK", "32") : paint("FAILED", "31");
        const target = e.targetName ? ` "${truncate(e.targetName, 40)}"` : "";
        const err = e.error ? ` err=${truncate(e.error, 60)}` : "";
        writeLine(
          `    ${paint(`[${shortNameFor(e.personaId)}]`, c)} act -> ${status} ${e.action ?? "?"}${target}${err}`,
        );
        return;
      }

      case "step_verdict": {
        if (quiet) return;
        const c = colorForPersona(e.personaId);
        const v =
          e.status === "success"
            ? paint("success", "32")
            : e.status === "in_progress"
              ? paint("in_progress", "33")
              : paint("give_up", "31");
        writeLine(
          `    ${paint(`[${shortNameFor(e.personaId)}]`, c)} verdict=${v}: ${truncate(e.evidence, 90)}`,
        );
        return;
      }

      case "flow_end": {
        if (quiet) return;
        const c = colorForPersona(e.personaId);
        const o = paint(e.outcome, e.outcome === "completed" ? "32" : "33");
        writeLine(
          `  ${paint(`[${shortNameFor(e.personaId)}]`, c)} ${e.flowId}  END outcome=${o} duration=${(e.durationMs / 1000).toFixed(1)}s`,
        );
        return;
      }

      case "heartbeat": {
        // The spinner timer handles in-place redraws; explicit heartbeats
        // from the emitter side are honored only on non-TTY (where the
        // spinner can't paint) and only every 5s+.
        if (isTTY) return;
        writeLine(`  [heartbeat] ${e.label} ${(e.elapsedMs / 1000).toFixed(1)}s`);
        return;
      }

      case "warn": {
        writeLine(`  ${paint("warn:", "33")} ${e.message}${e.context ? ` (${e.context})` : ""}`);
        return;
      }

      case "error": {
        writeLine(`  ${paint("error:", "31")} ${e.message}${e.context ? ` (${e.context})` : ""}`);
        return;
      }
    }
  };
}

function truncate(s: string, n: number): string {
  if (s.length <= n) return s;
  return s.slice(0, n - 1) + "…";
}

function purposeToPhase(p: import("../events.ts").AiCallPurpose): Phase {
  if (p === "surface_gen" || p === "persona_gen") return "init";
  if (p === "flow_gen") return "flows";
  return "run";
}
