import { afterAll, afterEach, beforeAll, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  FakeProvider,
  makeFlow,
  makeOutline,
  makePersona,
  makePlaywrightStub,
  makeSpyState,
  pendingUntilBrowserClose,
  type FakeBrowserSpyState,
} from "./flow-runner.fakes.ts";

// Replace playwright globally for this test file BEFORE runFlow is imported.
// Each test reconfigures `currentStub` to control outline/url/spy state. The
// module mock just delegates to the current stub. This keeps the chromium
// import in flow-runner.ts unchanged.
let currentStub: ReturnType<typeof makePlaywrightStub> | undefined;
mock.module("playwright", () => ({
  chromium: {
    launch: (opts: unknown) => {
      if (!currentStub) {
        throw new Error("playwright stub not configured for this test");
      }
      return currentStub.chromium.launch(opts);
    },
  },
}));

// Also stub axe-core/playwright. AxeBuilder otherwise instantiates against
// the fake page, calls into Playwright internals not present on our stub,
// and surfaces noisy errors. runAxe tolerates a thrown analyze() (returns an
// empty result with `error` set), but the cleaner story is to make the
// builder a no-op so the test isn't inspecting an irrelevant error string.
mock.module("@axe-core/playwright", () => ({
  default: class FakeAxeBuilder {
    withTags() {
      return this;
    }
    async analyze() {
      return { violations: [], passes: [], incomplete: [], inapplicable: [] };
    }
  },
}));

import {
  classifyFlowError,
  FLOW_WALLCLOCK_BUDGET_MS,
  runFlow,
  type FlowRunResult,
} from "./flow-runner.ts";

/**
 * Pure-function tests for the wallclock-vs-error outcome classifier. Kept in
 * place — the integration tests below cover the live behavior, but locking
 * the rule in a pure function keeps it impossible to drift even when the
 * runner refactors around it.
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

/**
 * Integration tests for runFlow. These exercise the observe -> act -> capture
 * -> judge orchestration with a stubbed Playwright (see flow-runner.fakes.ts)
 * and a deterministic AI provider. The goal is to lock in the contract that
 * the codex audit's findings #1, #3, and #10 turn on:
 *
 *   #1 — text-match observation must NOT abandon the flow.
 *   #3 — wallclock-induced browser close must produce outcome="timeout",
 *        not outcome="error".
 *   #10 — the orchestrator itself needs coverage; the pure helpers above are
 *         insufficient.
 */
describe("runFlow integration", () => {
  let runRoot: string;
  let spy: FakeBrowserSpyState;
  let runDir: string;

  beforeAll(async () => {
    runRoot = await mkdtemp(join(tmpdir(), "gauntlet-runflow-"));
  });

  afterAll(async () => {
    await rm(runRoot, { recursive: true, force: true });
  });

  afterEach(() => {
    currentStub = undefined;
  });

  function configureStub(opts: {
    url?: string;
    title?: string;
    bodyText?: string;
  } = {}): void {
    spy = makeSpyState();
    runDir = join(runRoot, `run-${Math.random().toString(36).slice(2, 10)}`);
    currentStub = makePlaywrightStub({
      outline: makeOutline(),
      bodyText: opts.bodyText ?? "page body text",
      url: opts.url ?? "https://example.test/",
      title: opts.title ?? "Example",
      spy,
    });
  }

  test("text-match observation produces success and advances to next step", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        // Step 1: observe -> text match (NOT none, NOT element).
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "text",
            reasoning: "found 'Submit' in page text",
            confidence: 85,
          },
        },
        // Step 2: observe -> text match again, just to confirm advance happened.
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "text",
            reasoning: "found 'second' in page text",
            confidence: 85,
          },
        },
      ],
    });
    const result = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
    });
    expect(result.outcome).not.toBe("abandoned");
    expect(result.outcome).toBe("completed");
    expect(result.steps).toHaveLength(2);
    expect(result.steps[0]?.verdict.status).toBe("success");
    expect(result.steps[1]?.verdict.status).toBe("success");
    // The text-match path must NOT call act() or judgeStep() — verify by
    // counting LocatorPick proposes (one per step, no ActionPick/StepVerdict).
    const schemas = provider.proposeCalls.map((c) => c.schemaName);
    expect(schemas).toEqual(["LocatorPick", "LocatorPick"]);
  });

  test("none-match observation produces give_up verdict with give_up_class set", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "none",
            reasoning: "nothing on the page matches the persona's target",
            confidence: 95,
          },
        },
      ],
    });
    const result = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
    });
    expect(result.outcome).toBe("abandoned");
    expect(result.failures.length).toBeGreaterThan(0);
    const f = result.failures[0]!;
    // The runner builds the failure with metadata.evidence — give_up_class
    // lives on the verdict for the observe-none path (see flow-runner.ts
    // ~line 462). Locking in the contract that the failure carries enough
    // signal for the reporter to discriminate bug vs not_a_bug.
    expect(result.steps[0]?.verdict.status).toBe("give_up");
    if (result.steps[0]?.verdict.status === "give_up") {
      expect(result.steps[0].verdict.give_up_class).toBeDefined();
      expect(["bug", "confusing_ux", "feature_gap", "not_a_bug"]).toContain(
        result.steps[0].verdict.give_up_class,
      );
    }
    expect(f.metadata?.evidence).toBeDefined();
  });

  test("element-match observation flows to act() then judgeStep()", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "element",
            idx: 0,
            reasoning: "the Submit button matches the intent",
            confidence: 90,
          },
        },
        {
          schemaName: "ActionPick",
          value: {
            match_kind: "element",
            action: "click",
            idx: 0,
            reasoning: "click Submit",
            confidence: 90,
          },
        },
        {
          schemaName: "StepVerdict",
          value: {
            status: "success",
            evidence: "Submit was clicked and the page advanced",
          },
        },
        // Step 2: collapse via observe-none so the run terminates cleanly
        // without dragging another full observe/act/judge round through.
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "none",
            reasoning: "step 2 not relevant to this scenario",
            confidence: 95,
          },
        },
      ],
    });
    const result = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
    });
    expect(result.steps[0]?.performed).toBe(true);
    expect(result.steps[0]?.verdict.status).toBe("success");
    // Run terminates on step 2's give-up; outcome is abandoned, but the
    // assertion here is that step 0 reached the full observe -> act -> judge
    // chain (3 propose calls before step 2's single propose).
    const schemas = provider.proposeCalls.map((c) => c.schemaName);
    expect(schemas.slice(0, 3)).toEqual([
      "LocatorPick",
      "ActionPick",
      "StepVerdict",
    ]);
  });

  test("wallclock timeout produces outcome='timeout' (not 'error')", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        // observe() awaits provider.propose forever; when the wallclock
        // fires and the fake browser closes, the closeRejecters fire and
        // the in-flight propose rejects with "browser has been closed".
        // The outer catch reclassifies as outcome="timeout".
        pendingUntilBrowserClose(spy),
      ],
    });
    const result = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
      wallclockBudgetMs: 100,
    });
    expect(result.outcome).toBe("timeout");
    expect(result.outcomeReason).toContain("wallclock");
    // flow-result.json must exist and reflect the same outcome.
    const onDisk = JSON.parse(
      await readFile(join(runDir, "flow-result.json"), "utf8"),
    );
    expect(onDisk.outcome).toBe("timeout");
  });

  test("flow-result.json on disk matches the in-memory outcome exactly", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "none",
            reasoning: "not present",
            confidence: 95,
          },
        },
      ],
    });
    const result = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
    });
    const onDisk = JSON.parse(
      await readFile(join(runDir, "flow-result.json"), "utf8"),
    );
    expect(onDisk.outcome).toBe(result.outcome);
    expect(onDisk.outcomeReason).toBe(result.outcomeReason ?? null);
    // Step shape lines up too — the on-disk projection is what the report
    // generator reads, so a drift here means the report goes stale.
    expect(onDisk.steps).toHaveLength(result.steps.length);
  });

  test("AI provider rejection (non-wallclock) produces outcome='error', not 'timeout'", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        // Reject immediately — no wallclock involved. classifyFlowError must
        // see wallclockFired=false and return outcome="error".
        () => Promise.reject(new Error("provider exploded")),
        () => Promise.reject(new Error("provider exploded (retry)")),
      ],
    });
    const result = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
      // Generous budget so the wallclock CANNOT plausibly fire first.
      wallclockBudgetMs: 60_000,
    });
    // The runner wraps observe()/act()/judgeStep() inner errors into
    // outcome="timeout" only when StepTimeoutError surfaces (per-step
    // budget exceeded). A bare rejection from the AI bubbles out of the
    // step loop's try block as a non-StepTimeout throw -> rethrown ->
    // caught by the outer try -> classifyFlowError(wallclockFired=false)
    // -> outcome="error".
    expect(result.outcome).toBe("error");
    expect(result.outcome).not.toBe("timeout");
    expect(result.outcomeReason).toContain("provider exploded");
  });

  test("browser + context are closed on completion", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "text",
            reasoning: "ok",
            confidence: 85,
          },
        },
        {
          schemaName: "LocatorPick",
          value: {
            match_kind: "text",
            reasoning: "ok",
            confidence: 85,
          },
        },
      ],
    });
    const result: FlowRunResult = await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
    });
    expect(result.outcome).toBe("completed");
    expect(spy.launchCount).toBe(1);
    expect(spy.closeCount).toBe(1);
    expect(spy.contextCloseCount).toBe(1);
  });

  test("browser is closed even when outcome is error", async () => {
    configureStub();
    const provider = new FakeProvider({
      queue: [
        () => Promise.reject(new Error("boom")),
        () => Promise.reject(new Error("boom retry")),
      ],
    });
    await runFlow({
      url: "https://example.test/",
      persona: makePersona(),
      flow: makeFlow(),
      provider,
      runDir,
      headless: true,
    });
    expect(spy.closeCount).toBe(1);
    expect(spy.contextCloseCount).toBe(1);
  });
});
