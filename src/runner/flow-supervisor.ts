/**
 * Per-flow worker process supervisor.
 *
 * Codex audit (2026-05-14, 3.6M tokens) traced a 12-min production wedge to
 * ffmpeg's `gracefulClose()` in playwright-core/lib/server/videoRecorder.js
 * — no internal deadline. The 5-min flow wallclock IS firing but only calls
 * `browser?.close().catch()`; it does NOT kill the Bun process tree, and
 * ffmpeg lives in OUR process (Playwright launches it from Node/Bun, not
 * Chromium). Every existing `withTimeout` is `Promise.race` — protects the
 * caller, doesn't kill the underlying work.
 *
 * Belt-and-braces: run each flow as a DETACHED subprocess (own process group
 * via setsid) and watch parent-side. If the worker goes silent past
 * silenceBudgetMs (no events on stdout), we kill the whole process group with
 * SIGKILL after a SIGTERM grace. This is the only mechanism that GUARANTEES
 * no flow can wedge the gauntlet binary indefinitely.
 *
 * Protocol: worker stdout is line-delimited JSON. Most lines are
 * GauntletEvent. The final line is one of:
 *   {"type":"flow_result","result":<FlowRunResult>}
 *   {"type":"flow_error","message":"...","stack":"..."}
 */

import { spawn, type ChildProcess } from "node:child_process";
import { mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import type { Persona } from "../persona/schema.ts";
import type { Flow } from "../flow/schema.ts";
import type { EventEmitter, GauntletEvent } from "../events.ts";
import type {
  FlowEvent,
  FlowEventHandler,
  FlowRunResult,
} from "./flow-runner.ts";

export interface FlowWorkerInput {
  url: string;
  persona: Persona;
  flow: Flow;
  runDir: string;
  headless: boolean;
  recordVideo: boolean;
  storageStatePath?: string;
  surfaceId?: string;
  /** Provider config — by-name + model. The worker re-instantiates. */
  providerName: string;
  model: string;
  cacheDir?: string;
  cacheEnabled: boolean;
  /** Optional override for testing. */
  wallclockBudgetMs?: number;
}

export interface SupervisorOptions {
  /** Default 75s — per codex recommendation. */
  silenceBudgetMs?: number;
  /** SIGTERM grace before SIGKILL. Default 2s. */
  killGraceMs?: number;
  emit: EventEmitter;
  onFlowEvent: FlowEventHandler;
  /**
   * Override the worker entry-point path. Production uses the bundled
   * flow-worker.ts next to this file; tests substitute a stub script.
   */
  workerScript?: string;
  /**
   * Override the executable to spawn. Defaults to `process.execPath`
   * (the running bun binary). Tests use this to spawn a one-liner via
   * `bun -e '...'` without writing a script file.
   */
  execPath?: string;
  /**
   * If set, replaces the entire spawn argv (useful for tests using
   * `bun -e '...'`). When provided, workerScript and execPath are ignored.
   */
  spawnArgv?: string[];
}

const FLOW_EVENT_TYPES = new Set<string>([
  "flow_start",
  "step_start",
  "step_observe",
  "step_act",
  "step_verdict",
  "flow_end",
]);

function defaultWorkerScript(): string {
  // file://.../src/runner/flow-supervisor.ts -> .../src/runner/flow-worker.ts
  return fileURLToPath(new URL("./flow-worker.ts", import.meta.url));
}

function synthesizeResult(
  input: FlowWorkerInput,
  outcome: FlowRunResult["outcome"],
  reason: string,
): FlowRunResult {
  return {
    persona: input.persona,
    flow: input.flow,
    url: input.url,
    runDir: input.runDir,
    steps: [],
    failures: [],
    outcome,
    outcomeReason: reason,
    durationMs: 0,
  };
}

export async function runFlowSupervised(
  input: FlowWorkerInput,
  opts: SupervisorOptions,
): Promise<FlowRunResult> {
  const silenceBudgetMs = opts.silenceBudgetMs ?? 75_000;
  const killGraceMs = opts.killGraceMs ?? 2_000;

  // Stage the worker input on disk (avoids argv-length limits and shell
  // quoting hazards). Cleaned in finally.
  const stagingDir = await mkdtemp(join(tmpdir(), "gauntlet-flow-"));
  const inputPath = join(stagingDir, "input.json");
  await writeFile(inputPath, JSON.stringify(input), "utf8");

  let argv: string[];
  let execPath: string;
  if (opts.spawnArgv && opts.spawnArgv.length > 0) {
    execPath = opts.spawnArgv[0]!;
    argv = opts.spawnArgv.slice(1);
  } else {
    execPath = opts.execPath ?? process.execPath;
    argv = ["run", opts.workerScript ?? defaultWorkerScript(), inputPath];
  }

  // detached: true => new process group on POSIX (setsid). Lets us reap the
  // ENTIRE tree (chromium, ffmpeg, any helper procs Playwright spawned) by
  // signalling -pid. Same semantics on Linux + macOS; gauntlet doesn't
  // target Windows (per CLAUDE.md).
  const child: ChildProcess = spawn(execPath, argv, {
    detached: true,
    stdio: ["ignore", "pipe", "pipe"],
  });

  let capturedResult: FlowRunResult | undefined;
  let capturedError: { message: string; stack?: string } | undefined;
  let lastEventAt = Date.now();
  let supervisorKilled = false;
  let killReason = "";

  // Stream stdout line-by-line. Bun's child stdout is a Node Readable.
  let stdoutBuf = "";
  const childPid = child.pid;
  child.stdout?.setEncoding("utf8");
  child.stdout?.on("data", (chunk: string) => {
    stdoutBuf += chunk;
    let nl: number;
    while ((nl = stdoutBuf.indexOf("\n")) !== -1) {
      const line = stdoutBuf.slice(0, nl).trim();
      stdoutBuf = stdoutBuf.slice(nl + 1);
      if (!line) continue;
      lastEventAt = Date.now();
      let parsed: unknown;
      try {
        parsed = JSON.parse(line);
      } catch {
        // Non-JSON noise on stdout — forward as a warn for visibility but
        // do not crash.
        opts.emit({
          type: "warn",
          message: `worker stdout (non-JSON): ${line.slice(0, 200)}`,
          ts: Date.now(),
        });
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        "type" in parsed &&
        (parsed as { type: unknown }).type === "flow_result"
      ) {
        capturedResult = (parsed as unknown as { result: FlowRunResult }).result;
        continue;
      }
      if (
        parsed &&
        typeof parsed === "object" &&
        "type" in parsed &&
        (parsed as { type: unknown }).type === "flow_error"
      ) {
        const e = parsed as { message?: string; stack?: string };
        capturedError = {
          message: e.message ?? "worker reported flow_error",
          ...(e.stack ? { stack: e.stack } : {}),
        };
        continue;
      }
      // GauntletEvent — emit. Also bridge to onFlowEvent if it's a FlowEvent.
      const ev = parsed as GauntletEvent;
      opts.emit(ev);
      if (
        typeof (ev as { type?: string }).type === "string" &&
        FLOW_EVENT_TYPES.has((ev as { type: string }).type)
      ) {
        // FlowEvent shape is the same minus `ts`. Pass through directly.
        opts.onFlowEvent(ev as unknown as FlowEvent);
      }
    }
  });

  // Forward stderr to parent stderr verbatim.
  child.stderr?.on("data", (chunk: Buffer | string) => {
    process.stderr.write(chunk);
  });

  // Watchdog: every 5s, check silence budget. setInterval refs the event
  // loop; we clear it on exit.
  const watchdog = setInterval(() => {
    const silentMs = Date.now() - lastEventAt;
    if (silentMs <= silenceBudgetMs) return;
    if (supervisorKilled) return;
    supervisorKilled = true;
    killReason = `supervisor: silence > ${Math.round(silentMs / 1000)}s`;
    opts.emit({
      type: "warn",
      message: `flow ${input.persona.id}/${input.flow.id} produced no events for ${Math.round(silentMs / 1000)}s; killing worker pid=${childPid}`,
      ts: Date.now(),
    });
    if (childPid !== undefined) {
      // SIGTERM the process group (negative pid). Wait killGraceMs, then
      // SIGKILL if still alive.
      try {
        process.kill(-childPid, "SIGTERM");
      } catch {
        /* already gone */
      }
      setTimeout(() => {
        try {
          process.kill(-childPid, 0);
          // Still alive — escalate.
          try {
            process.kill(-childPid, "SIGKILL");
          } catch {
            /* race */
          }
        } catch {
          /* already exited; nothing to do */
        }
      }, killGraceMs);
    }
  }, 5_000);

  const exitInfo = await new Promise<{
    code: number | null;
    signal: NodeJS.Signals | null;
  }>((resolve) => {
    child.once("exit", (code, signal) => {
      resolve({ code, signal });
    });
    child.once("error", (err) => {
      capturedError = {
        message: `worker spawn error: ${err.message}`,
        ...(err.stack ? { stack: err.stack } : {}),
      };
      resolve({ code: null, signal: null });
    });
  });

  clearInterval(watchdog);
  await rm(stagingDir, { recursive: true, force: true }).catch(() => undefined);

  if (capturedResult) {
    // If supervisor kill+result race (worker emitted result then we killed),
    // honor the captured result — the worker actually finished.
    return capturedResult;
  }

  if (supervisorKilled) {
    return synthesizeResult(input, "timeout", killReason);
  }

  if (capturedError) {
    return synthesizeResult(
      input,
      "error",
      capturedError.message.slice(0, 500),
    );
  }

  // No result + no error + clean exit. Treat as error.
  const sig = exitInfo.signal ? ` signal=${exitInfo.signal}` : "";
  const code = exitInfo.code !== null ? `code=${exitInfo.code}` : "code=null";
  return synthesizeResult(
    input,
    exitInfo.code === 0 ? "error" : "error",
    `worker exited without flow_result (${code}${sig})`,
  );
}
