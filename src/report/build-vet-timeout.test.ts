/**
 * buildReport forwards `vetTimeoutMs` into vetAll's `perFindingBudgetMs`.
 *
 * Proven end-to-end without mocking vetAll: we use the vetter's existing
 * browser test-seam to install a launcher whose `newContext` hangs forever.
 * With a tiny vetTimeoutMs the per-finding wallclock (perFindingBudgetMs)
 * fires almost immediately, landing the finding `could_not_replay` with a
 * note that quotes the exact budget — so the note text proves the number we
 * passed reached vetAll rather than its 60s default.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "./build.ts";
import {
  _setBrowserLauncherForTesting,
  _setAxeRunnerForTesting,
} from "./vetter.ts";
import { FailureReason } from "../runner/failure-reasons.ts";

// A launcher whose context never opens: newContext returns a never-resolving
// promise, so openSession is stuck until withVetTimeout(perFindingBudgetMs)
// rejects it. close() resolves so the post-vet finally doesn't hang.
function makeHangingLauncher() {
  const browser = {
    newContext: () => new Promise<never>(() => {}),
    close: async () => undefined,
  };
  return { launch: async () => browser as never };
}

async function writeRunFixture(): Promise<string> {
  const runDir = await mkdtemp(join(tmpdir(), "gauntlet-vet-timeout-"));
  const flowDir = join(runDir, "mary", "mary--demo");
  await mkdir(flowDir, { recursive: true });
  const flowResult = {
    persona: "mary",
    flow: "mary--demo",
    url: "https://example.test/",
    startedAt: 1,
    finishedAt: 2,
    outcome: "completed",
    steps: [],
    // ACCESSIBILITY_VIOLATION -> replayStrategy "axe_recheck" -> goes through
    // openSession, which is what the perFindingBudgetMs timeout guards.
    failures: [
      {
        reason: FailureReason.ACCESSIBILITY_VIOLATION,
        message: "axe[serious] color-contrast: insufficient contrast",
        timestamp: 1,
        stepIndex: 0,
        url: "https://example.test/",
        metadata: { axeId: "color-contrast" },
      },
    ],
  };
  await writeFile(join(flowDir, "flow-result.json"), JSON.stringify(flowResult), "utf8");
  return runDir;
}

describe("buildReport vetTimeoutMs -> vetAll perFindingBudgetMs", () => {
  afterEach(() => {
    _setBrowserLauncherForTesting(undefined);
    _setAxeRunnerForTesting(undefined);
  });

  test("a tiny vetTimeoutMs is the budget the vetter applies", async () => {
    _setBrowserLauncherForTesting(makeHangingLauncher());
    const runDir = await writeRunFixture();
    try {
      const built = await buildReport({ runDir, vet: true, vetTimeoutMs: 1 });
      const findings = built.report.personas.flatMap((p) => p.findings);
      expect(findings.length).toBe(1);
      const f = findings[0]!;
      expect(f.vetting.status).toBe("could_not_replay");
      // The note quotes the budget that actually fired. "exceeded 1ms" proves
      // vetTimeoutMs=1 reached perFindingBudgetMs (the default would be 60000).
      expect(f.vetting.note ?? "").toMatch(/exceeded 1ms/);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  }, 15_000);
});
