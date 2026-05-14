/**
 * Subprocess entry point for one flow.
 *
 * Spawned by flow-supervisor.ts. Reads a FlowWorkerInput from a JSON file
 * (path = process.argv[2]), wires the global event emitter + the per-flow
 * onEvent handler so EVERY GauntletEvent and FlowEvent gets serialized as
 * one-JSON-per-line on stdout, then calls runFlow. The final stdout line is
 * always `{"type":"flow_result","result":<FlowRunResult>}` on success, or
 * `{"type":"flow_error","message":...,"stack":...}` on uncaught failure.
 *
 * stdout is the IPC channel (vs node's IPC) because the parent already needs
 * to read the event stream for renderer + watchdog reset; piggy-backing the
 * result on the same channel keeps the protocol single-stream and trivial.
 */

import { readFile } from "node:fs/promises";
import { configureAiCache } from "../ai/cache.ts";
import { pickProvider } from "../ai/provider.ts";
import { setGlobalEventEmitter } from "../ai/provider.ts";
import "../ai/index.ts"; // register all provider factories
import { flowEventBridge, type GauntletEvent } from "../events.ts";
import { runFlow, type FlowEventHandler } from "./flow-runner.ts";
import type { FlowWorkerInput } from "./flow-supervisor.ts";

function emitLine(obj: unknown): void {
  // Single write per event keeps lines atomic on stdout. No trailing
  // partial-line risk on parent's split-by-newline reader.
  try {
    process.stdout.write(JSON.stringify(obj) + "\n");
  } catch {
    // Stdout closed (parent died) — nothing useful to do.
  }
}

async function main(): Promise<void> {
  const inputPath = process.argv[2];
  if (!inputPath) {
    emitLine({
      type: "flow_error",
      message: "flow-worker: missing input path argv[2]",
    });
    process.exit(2);
  }
  const raw = await readFile(inputPath, "utf8");
  const input = JSON.parse(raw) as FlowWorkerInput;

  // Wire the process-global emitter so AI-call + setup-op events flow
  // through stdout. Same channel used for FlowEvents below.
  setGlobalEventEmitter((e: GauntletEvent) => emitLine(e));

  // Configure AI cache + provider exactly as the CLI would.
  configureAiCache({
    enabled: input.cacheEnabled,
    cwd: input.cacheDir ?? process.cwd(),
  });
  const provider = pickProvider(input.model);

  // Bridge FlowEvent -> GauntletEvent -> stdout. Using flowEventBridge means
  // we go through one canonical adapter, matching what the in-process CLI
  // does for the render pipeline.
  const onFlowEvent: FlowEventHandler = flowEventBridge((e: GauntletEvent) =>
    emitLine(e),
  );

  // Best-effort signal handling. The parent supervisor sends SIGTERM, then
  // SIGKILL after killGraceMs. We don't have a handle to in-flight Playwright
  // resources here (runFlow owns its own try/finally), so just exit and let
  // the OS reap the process group.
  let signaled = false;
  const onSignal = (sig: NodeJS.Signals): void => {
    if (signaled) return;
    signaled = true;
    emitLine({
      type: "warn",
      message: `flow-worker received ${sig}; exiting`,
      ts: Date.now(),
    });
    // Give stdout a tick to flush, then exit.
    setTimeout(() => process.exit(143), 50);
  };
  process.on("SIGTERM", onSignal);
  process.on("SIGINT", onSignal);

  try {
    const result = await runFlow({
      url: input.url,
      persona: input.persona,
      flow: input.flow,
      provider,
      runDir: input.runDir,
      headless: input.headless,
      onEvent: onFlowEvent,
      recordVideo: input.recordVideo,
      ...(input.storageStatePath ? { storageStatePath: input.storageStatePath } : {}),
      ...(input.surfaceId ? { surfaceId: input.surfaceId } : {}),
      ...(input.wallclockBudgetMs !== undefined
        ? { wallclockBudgetMs: input.wallclockBudgetMs }
        : {}),
    });
    emitLine({ type: "flow_result", result });
    process.exit(0);
  } catch (err) {
    emitLine({
      type: "flow_error",
      message: err instanceof Error ? err.message : String(err),
      ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
    });
    process.exit(1);
  }
}

main().catch((err: unknown) => {
  emitLine({
    type: "flow_error",
    message: err instanceof Error ? err.message : String(err),
    ...(err instanceof Error && err.stack ? { stack: err.stack } : {}),
  });
  process.exit(1);
});
