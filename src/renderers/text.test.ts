import { describe, expect, test } from "bun:test";
import { createTextRenderer } from "./text.ts";

function makeBuffer(): { write: (s: string) => unknown; lines: () => string[]; raw: () => string } {
  const chunks: string[] = [];
  return {
    write: (s: string) => {
      chunks.push(s);
      return true;
    },
    lines: () =>
      chunks
        .join("")
        .replace(/\x1b\[[0-9;]*m/g, "") // strip ANSI
        .split("\n"),
    raw: () => chunks.join(""),
  };
}

describe("text renderer (non-TTY mode = CI/piped output)", () => {
  test("phase_start renders a header line", () => {
    const buf = makeBuffer();
    const r = createTextRenderer({ isTTY: false, color: false, out: buf });
    r({ type: "phase_start", phase: "vet", label: "vetting findings", ts: 1 });
    expect(buf.lines().some((l) => l.includes("[Phase vet]"))).toBe(true);
    expect(buf.lines().some((l) => l.includes("vetting findings"))).toBe(true);
  });

  test("ai_call_end shows cache vs live distinction", () => {
    const bufLive = makeBuffer();
    const bufCache = makeBuffer();
    const rLive = createTextRenderer({ isTTY: false, color: false, out: bufLive });
    const rCache = createTextRenderer({ isTTY: false, color: false, out: bufCache });
    rLive({ type: "ai_call_end", callId: "ai-1", durationMs: 12300, cached: false, ts: 1 });
    rCache({ type: "ai_call_end", callId: "ai-2", durationMs: 200, cached: true, ts: 1 });
    expect(bufLive.raw()).toContain("live");
    expect(bufCache.raw()).toContain("cache hit");
  });

  test("vet phase emits start + per-session + summary lines", () => {
    const buf = makeBuffer();
    const r = createTextRenderer({ isTTY: false, color: false, out: buf });
    r({ type: "vet_start", total: 8, distinctUrls: 2, ts: 1 });
    r({
      type: "vet_url_start",
      url: "https://x/a",
      findingCount: 5,
      sessionIndex: 1,
      sessionTotal: 2,
      ts: 1,
    });
    r({ type: "vet_url_navigate", url: "https://x/a", durationMs: 1500, ok: true, ts: 1 });
    r({ type: "vet_url_axe_end", url: "https://x/a", violationCount: 2, durationMs: 3200, ts: 1 });
    r({
      type: "vet_end",
      verified: 5,
      regressed: 1,
      subjective: 2,
      couldNotReplay: 0,
      durationMs: 8000,
      ts: 1,
    });
    const out = buf.raw();
    expect(out).toContain("vetting 8 findings");
    expect(out).toContain("session 1/2");
    expect(out).toContain("navigating");
    expect(out).toContain("axe scan");
    expect(out).toContain("vetting complete");
    expect(out).toContain("verified=5");
    expect(out).toContain("subjective=2");
  });

  test("step events carry persona shortname for concurrent attribution", () => {
    const buf = makeBuffer();
    const r = createTextRenderer({ isTTY: false, color: false, out: buf });
    r({ type: "flow_start", personaId: "marcus-sync-conductor", flowId: "f", totalSteps: 3, ts: 1 });
    r({
      type: "flow_start",
      personaId: "priya-newcomer",
      flowId: "g",
      totalSteps: 2,
      ts: 1,
    });
    r({
      type: "step_act",
      personaId: "marcus-sync-conductor",
      flowId: "f",
      stepIndex: 0,
      action: "click",
      targetName: "Sync",
      performed: true,
      ts: 1,
    });
    expect(buf.raw()).toContain("[marcus]");
    expect(buf.raw()).toContain("[priya]");
  });

  test("quiet mode suppresses per-step detail but keeps phase headers", () => {
    const buf = makeBuffer();
    const r = createTextRenderer({ isTTY: false, color: false, quiet: true, out: buf });
    r({ type: "phase_start", phase: "run", label: "executing flows", ts: 1 });
    r({
      type: "step_start",
      personaId: "p",
      flowId: "f",
      stepIndex: 0,
      intent: "find pricing",
      ts: 1,
    });
    expect(buf.raw()).toContain("[Phase run]");
    expect(buf.raw()).not.toContain("find pricing");
  });

  test("color disabled means no ANSI escape sequences in output", () => {
    const buf = makeBuffer();
    const r = createTextRenderer({ isTTY: false, color: false, out: buf });
    r({ type: "warn", message: "heads up", ts: 1 });
    expect(buf.raw()).not.toMatch(/\x1b\[/);
  });
});
