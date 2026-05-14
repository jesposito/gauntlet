import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import type { Persona } from "../persona/schema.ts";
import type { Flow } from "../flow/schema.ts";
import type { GauntletEvent } from "../events.ts";
import type { FlowEvent } from "./flow-runner.ts";
import {
  runFlowSupervised,
  type FlowWorkerInput,
} from "./flow-supervisor.ts";

const PERSONA: Persona = {
  id: "test-persona",
  surface: undefined,
  character: { name: "Test", voice: "" },
  behavior: {
    device: "desktop",
    viewport: { width: 1280, height: 720 },
    network: "fast",
    input: "mouse",
    patience_threshold_seconds: 60,
    abandons_on: [],
    avoids: [],
  },
} as unknown as Persona;

const FLOW: Flow = {
  id: "test-flow",
  steps: [],
} as unknown as Flow;

function baseInput(runDir: string): FlowWorkerInput {
  return {
    url: "http://example.invalid",
    persona: PERSONA,
    flow: FLOW,
    runDir,
    headless: true,
    recordVideo: false,
    providerName: "anthropic",
    model: "claude-opus-4-7",
    cacheEnabled: false,
  };
}

const tmpDirs: string[] = [];
async function makeTmp(): Promise<string> {
  const dir = await mkdtemp(join(tmpdir(), "gauntlet-sup-test-"));
  tmpDirs.push(dir);
  return dir;
}

afterEach(async () => {
  while (tmpDirs.length > 0) {
    const d = tmpDirs.pop()!;
    await rm(d, { recursive: true, force: true }).catch(() => undefined);
  }
});

describe("runFlowSupervised", () => {
  test("happy path: forwards events and returns the result", async () => {
    const runDir = await makeTmp();
    const scriptDir = await makeTmp();
    const scriptPath = join(scriptDir, "happy-worker.ts");
    // A stub worker: emits flow_start + flow_end + flow_result, then exits 0.
    const flowResult = {
      persona: PERSONA,
      flow: FLOW,
      url: "http://example.invalid",
      runDir,
      steps: [],
      failures: [],
      outcome: "completed",
      outcomeReason: undefined,
      durationMs: 42,
    };
    await writeFile(
      scriptPath,
      `
const start = { type: "flow_start", personaId: "test-persona", flowId: "test-flow", totalSteps: 0, ts: Date.now() };
const end = { type: "flow_end", personaId: "test-persona", flowId: "test-flow", outcome: "completed", durationMs: 42, ts: Date.now() };
process.stdout.write(JSON.stringify(start) + "\\n");
process.stdout.write(JSON.stringify(end) + "\\n");
process.stdout.write(JSON.stringify({ type: "flow_result", result: ${JSON.stringify(flowResult)} }) + "\\n");
process.exit(0);
`,
      "utf8",
    );

    const events: GauntletEvent[] = [];
    const flowEvents: FlowEvent[] = [];
    const result = await runFlowSupervised(baseInput(runDir), {
      emit: (e) => events.push(e),
      onFlowEvent: (e) => flowEvents.push(e),
      workerScript: scriptPath,
      silenceBudgetMs: 10_000,
    });

    expect(result.outcome).toBe("completed");
    expect(result.durationMs).toBe(42);
    // flow_start + flow_end were forwarded to both channels.
    expect(events.some((e) => e.type === "flow_start")).toBe(true);
    expect(events.some((e) => e.type === "flow_end")).toBe(true);
    expect(flowEvents.some((e) => e.type === "flow_start")).toBe(true);
    expect(flowEvents.some((e) => e.type === "flow_end")).toBe(true);
  }, 10_000);

  test("silence kill: watchdog SIGKILLs a wedged worker", async () => {
    const runDir = await makeTmp();
    // Worker that emits one event then sleeps forever.
    const oneShot = `
const start = { type: "flow_start", personaId: "test-persona", flowId: "test-flow", totalSteps: 0, ts: Date.now() };
process.stdout.write(JSON.stringify(start) + "\\n");
setInterval(() => {}, 1000);
`;
    const events: GauntletEvent[] = [];
    const t0 = Date.now();
    const result = await runFlowSupervised(baseInput(runDir), {
      emit: (e) => events.push(e),
      onFlowEvent: () => {},
      // Drive the watchdog hard: 200ms silence budget, 200ms grace before KILL.
      silenceBudgetMs: 200,
      killGraceMs: 200,
      spawnArgv: [process.execPath, "-e", oneShot],
    });
    const elapsed = Date.now() - t0;

    expect(result.outcome).toBe("timeout");
    expect(result.outcomeReason ?? "").toMatch(/silence/i);
    // Watchdog ticks every 5s, so worst-case wakeup is ~5s after the budget
    // expires. Allow generous headroom for CI noise.
    expect(elapsed).toBeLessThan(15_000);
    // Should have emitted at least one warn event about the kill.
    expect(events.some((e) => e.type === "warn")).toBe(true);
  }, 20_000);

  test("child error: non-zero exit synthesizes outcome=error", async () => {
    const runDir = await makeTmp();
    const events: GauntletEvent[] = [];
    const result = await runFlowSupervised(baseInput(runDir), {
      emit: (e) => events.push(e),
      onFlowEvent: () => {},
      silenceBudgetMs: 10_000,
      spawnArgv: [
        process.execPath,
        "-e",
        `process.stdout.write(JSON.stringify({type:"flow_error",message:"boom from worker"}) + "\\n"); process.exit(1);`,
      ],
    });
    expect(result.outcome).toBe("error");
    expect(result.outcomeReason ?? "").toMatch(/boom/);
  }, 10_000);
});
