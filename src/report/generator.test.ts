import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildPersonaReport } from "./generator.ts";

function makeRun(): string {
  return mkdtempSync(join(tmpdir(), "gauntlet-gen-test-"));
}

function writeFlow(
  runDir: string,
  personaId: string,
  flowId: string,
  body: unknown,
): void {
  const dir = join(runDir, personaId, flowId);
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "flow-result.json"), JSON.stringify(body), "utf8");
}

const validFlow = {
  persona: "p",
  flow: "f1",
  url: "https://example.com",
  startedAt: 1,
  finishedAt: 2,
  outcome: "completed" as const,
  steps: [],
  failures: [
    {
      reason: "console_error",
      message: "BadThing happened",
      timestamp: 1,
      stepIndex: 0,
      url: "https://example.com",
    },
  ],
};

describe("buildPersonaReport - schema validation at disk boundary", () => {
  afterEach(() => {
    mock.restore();
  });

  test("loads schema-valid flow-result.json cleanly and produces findings", async () => {
    const runDir = makeRun();
    writeFlow(runDir, "alice", "flow-1", validFlow);

    const report = await buildPersonaReport(runDir, "alice");
    expect(report.findings.length).toBe(1);
    expect(report.findings[0]?.detail).toBe("BadThing happened");
    expect(report.flows.length).toBe(1);
  });

  test("rejects (skips with warn) flow-result missing required field", async () => {
    const runDir = makeRun();
    // Missing `outcome`.
    const bad = { ...validFlow, outcome: undefined };
    delete (bad as { outcome?: unknown }).outcome;
    writeFlow(runDir, "alice", "flow-1", bad);

    const warn = mock(() => {});
    console.warn = warn as typeof console.warn;
    const report = await buildPersonaReport(runDir, "alice");
    // Bad artifact => skipped, no findings, no flow summary, but no throw.
    expect(report.findings.length).toBe(0);
    expect(report.flows.length).toBe(0);
    expect(warn).toHaveBeenCalled();
    const warnMsg = String((warn.mock.calls[0] ?? [""])[0]);
    expect(warnMsg).toContain("flow-result.json");
  });

  test("rejects (skips with warn) flow-result with wrong-typed field", async () => {
    const runDir = makeRun();
    const bad = { ...validFlow, startedAt: "not-a-number" };
    writeFlow(runDir, "alice", "flow-1", bad);

    const warn = mock(() => {});
    console.warn = warn as typeof console.warn;
    const report = await buildPersonaReport(runDir, "alice");
    expect(report.findings.length).toBe(0);
    expect(warn).toHaveBeenCalled();
  });

  test("aggregates valid flow even when sibling flow is corrupt", async () => {
    const runDir = makeRun();
    writeFlow(runDir, "alice", "good-flow", validFlow);
    writeFlow(runDir, "alice", "bad-flow", { not: "a flow result" });

    console.warn = mock(() => {}) as typeof console.warn;
    const report = await buildPersonaReport(runDir, "alice");
    // One good flow processed, one corrupt skipped.
    expect(report.flows.length).toBe(1);
    expect(report.findings.length).toBe(1);
  });
});
