#!/usr/bin/env bun
import { join } from "node:path";
import { mkdir } from "node:fs/promises";
import {
  loadPersona,
  listBuiltinPersonas,
  listCuratedPersonas,
} from "./persona/loader.ts";
import { runPersona } from "./runner/browser.ts";
import { runFlow } from "./runner/flow-runner.ts";
import { runFlowSupervised } from "./runner/flow-supervisor.ts";
import { runWithConcurrency } from "./util/pool.ts";
import {
  loadAllSurfacesWithDiagnostics,
  loadSurface,
  writeSurface,
} from "./surface/loader.ts";
import { generateSurfaces } from "./init/surface-generator.ts";
import { captureAuth, resolveAuthStatePath } from "./auth/capture.ts";
import { buildReport, findLatestRunDir } from "./report/build.ts";
import { buildCrossSurfaceReport } from "./report/cross-surface.ts";
import { seedProject } from "./init/seed.ts";
import { loadSitesFile, runBench, saveBenchReport } from "./bench/runner.ts";
import { renderPrComment } from "./comment/render.ts";
import { readFile } from "node:fs/promises";
import { spawnSync } from "node:child_process";
import { type AiProvider, DEFAULT_MODEL, pickProvider } from "./ai/index.ts";
import { configureAiCache, getAiCache } from "./ai/cache.ts";
import { readProject } from "./init/project-reader.ts";
import { loadTemplates } from "./persona/templates.ts";
import {
  generateCandidates,
  type PersonaCandidate,
} from "./init/persona-generator.ts";
import { curate, listCuratedIds } from "./init/curate.ts";
import { generateFlows } from "./init/flow-generator.ts";
import { curateFlows } from "./init/curate-flows.ts";
import {
  listFlows,
  loadFlowsForPersona,
  loadFlowsForPersonaWithDiagnostics,
} from "./flow/loader.ts";
import {
  FlagParseError,
  parseOptionalBoundedIntFlag,
  parsePositiveIntFlag,
} from "./cli/flag-parsers.ts";
import { filterFlows, describeCriteria, type FlowFilterCriteria } from "./flow/filter.ts";
import { resolvePrUrl } from "./target/pr.ts";
import {
  flowEventBridge,
  multiplex,
  nullEmitter,
  type EventEmitter,
} from "./events.ts";
import { createTextRenderer } from "./renderers/text.ts";
import { createJsonlRenderer } from "./renderers/jsonl.ts";

/**
 * Build the renderer pipeline for a long-running command.
 *
 * The text renderer always runs (writes phase headers + per-step lines to
 * stdout). The JSONL renderer is opt-in via `--events-log <path>`; when set,
 * every event is appended to that file in JSONL form so an agent (Claude)
 * can `tail -f` and reason about the run in real time.
 *
 * If the AI provider module exports a `setGlobalEventEmitter` (Stream A),
 * we wire the emitter through it so cache-hit / live-call AI events flow
 * into both renderers without each call site having to plumb an emitter.
 * The dynamic import keeps this CLI compatible with foundation builds
 * where Stream A hasn't merged yet.
 */
async function buildEmitter(flags: {
  quiet?: boolean;
  noColor?: boolean;
  eventsLog?: string;
}): Promise<EventEmitter> {
  const renderers: EventEmitter[] = [];
  const colorEnabled =
    flags.noColor !== true && process.env["NO_COLOR"] === undefined;
  renderers.push(
    createTextRenderer({
      isTTY: process.stdout.isTTY ?? false,
      color: colorEnabled,
      quiet: flags.quiet === true,
    }),
  );
  if (flags.eventsLog) {
    renderers.push(createJsonlRenderer({ path: flags.eventsLog }));
  }
  const emit = renderers.length === 0 ? nullEmitter : multiplex(...renderers);

  // Stream A wires AI-call events through a process-global emitter exported
  // by ./ai/provider.ts. If it's there, hand it our emit so cache hits /
  // live calls show up in both text + JSONL renderers. If it's not there
  // yet (foundation-only builds), the AI events just don't surface — no
  // crash, no compile error.
  try {
    const mod = (await import("./ai/provider.ts")) as {
      setGlobalEventEmitter?: (e: EventEmitter) => void;
    };
    if (typeof mod.setGlobalEventEmitter === "function") {
      mod.setGlobalEventEmitter(emit);
    }
  } catch {
    // Provider module shape doesn't matter to the renderer pipeline.
  }

  return emit;
}

export interface ParsedArgs {
  command: string;
  positional: string[];
  flags: Record<string, string | boolean>;
}

export function parseArgs(argv: string[]): ParsedArgs {
  const args = argv.slice(2);
  const command = args[0] ?? "help";
  const rest = args.slice(1);
  const positional: string[] = [];
  const flags: Record<string, string | boolean> = {};

  for (let i = 0; i < rest.length; i++) {
    const token = rest[i]!;
    if (token.startsWith("--")) {
      const key = token.slice(2);
      const next = rest[i + 1];
      if (next !== undefined && !next.startsWith("--")) {
        const values: string[] = [];
        while (i + 1 < rest.length && !rest[i + 1]!.startsWith("--")) {
          values.push(rest[++i]!);
        }
        flags[key] = values.length === 1 ? values[0]! : values.join(",");
      } else {
        flags[key] = true;
      }
    } else {
      positional.push(token);
    }
  }

  return { command, positional, flags };
}

function splitCsv(v: string | boolean | undefined): string[] {
  if (typeof v !== "string") return [];
  return v.split(",").map((s) => s.trim()).filter(Boolean);
}

/**
 * Detect a run that never exercised the live AI persona path, so a false-green
 * (a dead/expired key, or the legacy no-flows capture) can't masquerade as a
 * clean exit-0 success. Pure so it's trivially testable.
 *
 * Liveness comes from `liveAiCalls`: the count of non-cached `ai_call_end`
 * events the parent observed on the event stream. This is ground truth in BOTH
 * run modes — in supervised mode (the default) every propose() runs inside a
 * flow-worker subprocess and the parent's AiCache stats stay {0,0,0}, but the
 * worker still streams its ai_call_end events up through the supervisor, so the
 * parent sees them either way. (Cache HITS emit cached:true and don't count: a
 * replay doesn't touch the live provider. A warm-cache re-run is therefore
 * liveAiCalls===0 with totalFlows>0 — the flow path ran, just nothing live.)
 *
 * Only two states are genuine false-greens: totalFlows===0 (the legacy/no-flows
 * single-step path) and a flows run where ZERO live calls happened AND nothing
 * was replayed from cache either (cacheHits===0) — the dead-key signature.
 */
export function shouldWarnNoAiExercised(args: {
  totalFlows: number;
  liveAiCalls: number;
  cacheHits: number;
}): boolean {
  if (args.totalFlows === 0) return true;
  return args.liveAiCalls === 0 && args.cacheHits === 0;
}

export const NO_AI_EXERCISED_MESSAGE =
  "AI path not exercised: 0 live AI calls and 0 cache replays this run. " +
  "Either no flows ran (legacy capture) or every flow errored before calling the " +
  "model — check your key with gauntlet doctor, or run gauntlet flows first.";

async function cmdRun(args: ParsedArgs): Promise<void> {
  const surfaceArg = typeof args.flags.surface === "string" ? args.flags.surface : undefined;
  const prArg = typeof args.flags.pr === "string" ? args.flags.pr : undefined;
  let url = args.positional[0] ?? (typeof args.flags.url === "string" ? args.flags.url : undefined);
  let prInfo: Awaited<ReturnType<typeof resolvePrUrl>> | undefined;

  if (prArg) {
    try {
      prInfo = await resolvePrUrl(prArg, process.cwd());
      if (!url) url = prInfo.url;
    } catch (err) {
      console.error(`error: ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  if (surfaceArg && !url) {
    try {
      const surface = await loadSurface(surfaceArg);
      if (surface.base_url) url = surface.base_url;
      else {
        console.error(`error: surface "${surfaceArg}" has no base_url; pass <url> explicitly.`);
        process.exit(2);
      }
    } catch (err) {
      console.error(`error: cannot load surface "${surfaceArg}": ${err instanceof Error ? err.message : String(err)}`);
      process.exit(2);
    }
  }

  if (!url) {
    console.error("error: missing URL");
    console.error("usage: gauntlet run <url> --personas mary [...]");
    console.error("       gauntlet run --surface marketing --personas ...");
    console.error("       gauntlet run --pr 123 [--features checkout]");
    process.exit(2);
  }

  const personaArg = args.flags.personas;
  if (!personaArg || personaArg === true) {
    // If a surface is selected, default to every curated persona on that surface.
    if (surfaceArg) {
      // resolved below via plan loading
    } else {
      console.error("error: --personas required");
      console.error("available:", (await listBuiltinPersonas()).join(", "));
      process.exit(2);
    }
  }

  let personaIds: string[] =
    personaArg && personaArg !== true
      ? String(personaArg).split(",").map((s) => s.trim()).filter((s): s is string => Boolean(s))
      : [];
  const headless = args.flags.headless !== "false" && args.flags.headed !== true;
  const maxSteps = parsePositiveIntFlag("steps", args.flags.steps, 1, { max: 50 });
  const cacheEnabled = args.flags["no-cache"] !== true;
  const model =
    typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const forceLegacy = args.flags["no-flows"] === true;
  const concurrency = parsePositiveIntFlag(
    "concurrency",
    args.flags.concurrency,
    2,
    { max: 32 },
  );
  const quiet = args.flags.quiet === true;
  const noColor = args.flags["no-color"] === true;
  const recordVideo = args.flags["record-video"] === true;
  // Supervisor (per-flow subprocess + silence watchdog) is ON by default.
  // Codex audit 2026-05-14 mandated belt-and-braces — even with the in-runner
  // wallclock + per-op timeouts in place, ffmpeg / browser subprocesses can
  // outlive Promise.race-based timeouts and wedge the bun process. Pass
  // --no-supervisor to fall back to in-process runFlow (debug only).
  const supervised = args.flags["no-supervisor"] !== true;
  const eventsLog =
    typeof args.flags["events-log"] === "string"
      ? args.flags["events-log"]
      : undefined;

  const cwd = process.cwd();
  configureAiCache({ enabled: cacheEnabled, cwd });

  const baseEmit = await buildEmitter({ quiet, noColor, ...(eventsLog ? { eventsLog } : {}) });
  // Count AI calls off the event stream, split live vs replayed. In supervised
  // mode (default) propose() runs in the flow-worker subprocess so the parent's
  // AiCache stats stay 0 — but every ai_call_end still streams up through the
  // supervisor (carrying `cached`), so this is the only signal that works in
  // BOTH modes. live = real provider hit; replay = served from cache.
  let liveAiCalls = 0;
  let replayedAiCalls = 0;
  const emit: typeof baseEmit = (e) => {
    if (e.type === "ai_call_end") {
      if (e.cached) replayedAiCalls += 1;
      else liveAiCalls += 1;
    }
    baseEmit(e);
  };
  const onFlowEvent = flowEventBridge(emit);

  const filterCriteria: FlowFilterCriteria = {
    flowIds: splitCsv(args.flags.flows),
    features: splitCsv(args.flags.features),
    tags: splitCsv(args.flags.tags),
    excludeTags: splitCsv(args.flags["exclude-tags"]),
    paths: splitCsv(args.flags.paths),
  };
  const filterIsActive =
    (filterCriteria.flowIds?.length ?? 0) > 0 ||
    (filterCriteria.features?.length ?? 0) > 0 ||
    (filterCriteria.tags?.length ?? 0) > 0 ||
    (filterCriteria.excludeTags?.length ?? 0) > 0 ||
    (filterCriteria.paths?.length ?? 0) > 0;

  const ts = new Date().toISOString().replace(/[:.]/g, "-");
  const baseDir = join(cwd, ".gauntlet", "runs", ts);
  await mkdir(baseDir, { recursive: true });

  console.log(`gauntlet run -> ${url}`);
  if (prInfo)
    console.log(`pr: #${prInfo.prNumber} (${prInfo.branch}) via ${prInfo.source}`);
  if (surfaceArg) console.log(`surface: ${surfaceArg}`);
  if (filterIsActive) console.log(`filter: ${describeCriteria(filterCriteria)}`);
  console.log(`personas: ${personaIds.join(", ")}`);
  console.log(`run dir: ${baseDir}`);
  console.log(`concurrency: ${concurrency}`);

  let providerLazy: ReturnType<typeof pickProvider> | undefined;
  const getProvider = (): ReturnType<typeof pickProvider> => {
    if (!providerLazy) providerLazy = pickProvider(model);
    return providerLazy;
  };

  // If --surface was provided and --personas was not, auto-select every
  // curated persona belonging to that surface.
  if (surfaceArg && personaIds.length === 0) {
    const { listCuratedPersonas } = await import("./persona/loader.ts");
    const allCurated = await listCuratedPersonas(cwd);
    const matched: string[] = [];
    for (const id of allCurated) {
      const p = await loadPersona(id, cwd);
      if (p.surface === surfaceArg) matched.push(id);
    }
    if (matched.length === 0) {
      console.error(`error: no curated personas have surface="${surfaceArg}".`);
      process.exit(2);
    }
    personaIds = matched;
  }

  // Cache surfaces we touch so we resolve each yaml once.
  const surfaceCache = new Map<string, Awaited<ReturnType<typeof loadSurface>>>();
  async function getSurface(id: string | undefined): Promise<
    Awaited<ReturnType<typeof loadSurface>> | undefined
  > {
    if (!id) return undefined;
    const hit = surfaceCache.get(id);
    if (hit) return hit;
    try {
      const s = await loadSurface(id, cwd);
      surfaceCache.set(id, s);
      return s;
    } catch {
      return undefined;
    }
  }

  // Pre-resolve every persona + its flows, so we can plan concurrency.
  type Plan = {
    persona: Awaited<ReturnType<typeof loadPersona>>;
    flows: Awaited<ReturnType<typeof loadFlowsForPersona>>;
    storageStatePath?: string;
    surfaceId?: string;
  };
  const plans: Plan[] = [];
  let totalDroppedByFilter = 0;
  for (const id of personaIds) {
    if (!id) continue;
    const persona = await loadPersona(id, cwd);
    if (surfaceArg && persona.surface && persona.surface !== surfaceArg) {
      console.warn(`warn: persona ${id} has surface="${persona.surface}", skipping under --surface=${surfaceArg}.`);
      continue;
    }
    const effectiveSurfaceId = surfaceArg ?? persona.surface;
    const surface = await getSurface(effectiveSurfaceId);
    const storageStatePath = surface
      ? resolveAuthStatePath(cwd, surface.auth_state)
      : undefined;
    if (surface?.requires_auth && !storageStatePath) {
      console.warn(
        `warn: surface "${surface.id}" requires_auth=true but no auth_state captured. ` +
          `Persona ${id} will hit the login wall. Run \`gauntlet auth ${surface.id}\` first.`,
      );
    }
    let flows: Awaited<ReturnType<typeof loadFlowsForPersona>> = [];
    if (!forceLegacy) {
      const loaded = await loadFlowsForPersonaWithDiagnostics(id, cwd);
      flows = loaded.flows;
      // Surface broken-flow diagnostics to the operator. If they specifically
      // targeted a flow id that failed to parse, hard-fail instead of
      // silently skipping it — that's a bug in their yaml they need to see.
      for (const d of loaded.diagnostics) {
        const targetedThisFlow = (filterCriteria.flowIds ?? []).includes(d.flowId);
        const prefix = targetedThisFlow ? "error" : "warn";
        console.error(`${prefix}: skipping ${d.path}: ${d.reason}`);
        if (targetedThisFlow) {
          process.exit(2);
        }
      }
    }
    if (!forceLegacy && filterIsActive && flows.length > 0) {
      const before = flows.length;
      const { kept, dropped } = filterFlows(flows, filterCriteria);
      flows = kept;
      totalDroppedByFilter += dropped.length;
      if (kept.length < before) {
        console.log(
          `[${id}] filter kept ${kept.length}/${before} flows (${dropped.length} dropped)`,
        );
      }
    }
    plans.push({
      persona,
      flows,
      ...(storageStatePath ? { storageStatePath } : {}),
      ...(effectiveSurfaceId ? { surfaceId: effectiveSurfaceId } : {}),
    });
  }
  if (filterIsActive) {
    const totalKept = plans.reduce((n, p) => n + p.flows.length, 0);
    if (totalKept === 0) {
      console.error(
        `error: filter matched zero flows (${describeCriteria(filterCriteria)}).\n` +
          `hint: run \`gauntlet list\` to see available flow ids; check flow.feature/tags/paths fields.`,
      );
      process.exit(2);
    }
    console.log(`filter: ${totalKept} flow${totalKept === 1 ? "" : "s"} kept, ${totalDroppedByFilter} dropped across ${plans.length} persona${plans.length === 1 ? "" : "s"}.`);
  }
  if (plans.length === 0) {
    console.error("error: no personas to run.");
    process.exit(2);
  }

  const startedAt = Date.now();
  emit({
    type: "phase_start",
    phase: "run",
    label: `running ${plans.length} persona${plans.length === 1 ? "" : "s"} (concurrency=${concurrency})`,
    ts: Date.now(),
  });

  type PersonaResult = { persona: string; flows: number; failures: number; outcomes: string[] };

  const personaResults = await runWithConcurrency<typeof plans[number], PersonaResult>(plans, concurrency, async (plan) => {
    const { persona, flows, storageStatePath, surfaceId } = plan;
    const authSuffix = storageStatePath ? ` (authed)` : "";
    if (flows.length === 0) {
      const runDir = join(baseDir, persona.id);
      console.log(
        `[${persona.id}] ${persona.character.name} -> ${url}${authSuffix} (no flows; legacy single-step capture)`,
      );
      const result = await runPersona({
        url,
        persona,
        runDir,
        maxSteps,
        headless,
        ...(storageStatePath ? { storageStatePath } : {}),
      });
      console.log(
        `[${persona.id}] done. steps=${result.steps} failures=${result.failures.length} duration=${result.durationMs}ms`,
      );
      return { persona: persona.id, flows: 0, failures: result.failures.length, outcomes: [] };
    }

    console.log(
      `[${persona.id}] ${persona.character.name} -> ${url}${authSuffix} (${flows.length} flow${flows.length === 1 ? "" : "s"})`,
    );
    let totalFailures = 0;
    const outcomes: string[] = [];
    for (const flow of flows) {
      const runDir = join(baseDir, persona.id, flow.id);
      try {
        const result = supervised
          ? await runFlowSupervised(
              {
                url,
                persona,
                flow,
                runDir,
                headless,
                recordVideo,
                providerName: getProvider().name,
                model,
                cacheEnabled,
                cacheDir: cwd,
                ...(storageStatePath ? { storageStatePath } : {}),
                ...(surfaceId ? { surfaceId } : {}),
              },
              { emit, onFlowEvent },
            )
          : await runFlow({
              url,
              persona,
              flow,
              provider: getProvider(),
              runDir,
              headless,
              onEvent: onFlowEvent,
              recordVideo,
              ...(storageStatePath ? { storageStatePath } : {}),
              ...(surfaceId ? { surfaceId } : {}),
            });
        totalFailures += result.failures.length;
        outcomes.push(result.outcome);
      } catch (err) {
        // A single flow crashing must not abort the whole run. Mark it
        // as outcome=error, surface the message, continue with the next flow.
        const msg = err instanceof Error ? err.message : String(err);
        const firstLine = msg.split("\n")[0] ?? msg;
        console.error(`[${persona.id}/${flow.id}] flow crashed: ${firstLine}`);
        onFlowEvent({
          type: "flow_end",
          personaId: persona.id,
          flowId: flow.id,
          outcome: "error",
          durationMs: 0,
        });
        outcomes.push("error");
        totalFailures += 1;
        await mkdir(runDir, { recursive: true });
        const now = Date.now();
        await Bun.write(
          join(runDir, "flow-result.json"),
          JSON.stringify(
            {
              persona: persona.id,
              flow: flow.id,
              url,
              ...(surfaceId ? { surface: surfaceId } : {}),
              outcome: "error",
              outcomeReason: `flow runner threw: ${firstLine}`,
              steps: [],
              failures: [
                {
                  reason: "uncaught_exception",
                  message: `flow runner threw: ${msg}`,
                  timestamp: now,
                  stepIndex: -1,
                  url,
                },
              ],
              startedAt: now,
              finishedAt: now,
              durationMs: 0,
            },
            null,
            2,
          ),
        );
      }
    }
    return { persona: persona.id, flows: flows.length, failures: totalFailures, outcomes };
  });

  // End-of-run summary: per-persona flow outcomes + aggregate.
  const allOutcomes: string[] = [];
  let totalFlows = 0;
  let totalFailures = 0;
  for (const r of personaResults) {
    allOutcomes.push(...r.outcomes);
    totalFlows += r.flows;
    totalFailures += r.failures;
  }
  const outcomeCounts = allOutcomes.reduce<Record<string, number>>((acc, o) => {
    acc[o] = (acc[o] ?? 0) + 1;
    return acc;
  }, {});
  const outcomeSummary = Object.entries(outcomeCounts)
    .sort(([, a], [, b]) => b - a)
    .map(([k, v]) => `${k}=${v}`)
    .join(" ");
  console.log(
    `\nsummary: personas=${personaResults.length} flows=${totalFlows} failures=${totalFailures} [${outcomeSummary || "no outcomes"}]`,
  );

  // Cache transparency: shows whether a fast run was real or replayed.
  const cache = getAiCache();
  const cacheStats = cache?.stats() ?? { hits: 0, misses: 0, writes: 0 };
  if (cache?.enabled) {
    const total = cacheStats.hits + cacheStats.misses;
    const pct = total > 0 ? Math.round((cacheStats.hits / total) * 100) : 0;
    console.log(`cache: hits=${cacheStats.hits} misses=${cacheStats.misses} writes=${cacheStats.writes} (${pct}% hit-rate)`);
  }

  // No-flows / dead-key guard. A run that made ZERO live AI calls looks like a
  // green success but never exercised the persona path — masks an expired key
  // or a roster with no flows. Warn loudly through the event stream (both
  // renderers + any --events-log) so the false-green is impossible to miss.
  if (
    shouldWarnNoAiExercised({
      totalFlows,
      liveAiCalls,
      // Replays seen on the event stream (works in supervised mode, where the
      // parent's cacheStats stay 0) OR the in-process cache's own hit count.
      cacheHits: Math.max(replayedAiCalls, cacheStats.hits),
    })
  ) {
    emit({ type: "warn", message: NO_AI_EXERCISED_MESSAGE, context: "run", ts: Date.now() });
  }

  // Detect "every flow crashed for the same reason" — almost always a setup
  // problem (bad API key, network, missing surface yaml), not a real finding.
  const errorCount = outcomeCounts.error ?? 0;
  if (totalFlows > 0 && errorCount === totalFlows) {
    console.error(
      `\nwarn: every flow ended outcome=error. Check the log above for the underlying cause (often a credential or network issue, not a real finding).`,
    );
  }

  emit({ type: "phase_end", phase: "run", durationMs: Date.now() - startedAt, ts: Date.now() });
  console.log(`\nartifacts: ${baseDir}`);

  const skipReport = args.flags["no-report"] === true;
  if (!skipReport) {
    const reportStartedAt = Date.now();
    emit({
      type: "phase_start",
      phase: "report",
      label: "building report (vetting layer re-runs replays)",
      ts: reportStartedAt,
    });
    // Pass `emit` so the vetter heartbeat (vet_url_axe_start/end, vet_finding,
    // heartbeat) actually reaches the user. Codex audit 2026-05-14 caught
    // that this call site dropped emit: tests passed because they passed
    // emit directly, but production runs left users staring at silent terminals
    // for the duration of vet (the felt-bad "25-min black box" from yesterday).
    const vetTimeoutMs = parseVetTimeout(args.flags["vet-timeout"], emit);
    const built = await buildReport({
      runDir: baseDir,
      vet: true,
      ...(vetTimeoutMs !== undefined ? { vetTimeoutMs } : {}),
      emit,
    });
    emit({
      type: "phase_end",
      phase: "report",
      durationMs: Date.now() - reportStartedAt,
      ts: Date.now(),
    });
    console.log(
      `report: ${built.markdownPath}  (findings=${built.report.totals.findings} verified=${built.report.totals.verified} subjective=${built.report.totals.subjective} regressed=${built.report.totals.regressed})`,
    );
  }

  // Post-run cleanup prompt. Skip in non-TTY (CI / agent-driven) so the
  // run terminates cleanly. Skip when --auto-clean (always trim) or
  // --no-clean-prompt (always keep) are set explicitly.
  await maybePromptCleanup(baseDir, {
    autoClean: args.flags["auto-clean"] === true,
    noPrompt: args.flags["no-clean-prompt"] === true,
  });
}

/**
 * Post-run cleanup prompt. Shows the user what this run cost on disk and
 * offers three options:
 *   k(eep)  — leave the run dir untouched [default]
 *   t(rim)  — drop the heavy per-step artifacts (DOM html, ax-tree json,
 *             axe json, network/console jsonl, video webm). Keeps
 *             screenshots + flow-result.json + REPORT.md.
 *   d(elete)- delete this run entirely
 *
 * Skipped in non-TTY (CI / agent) and when --auto-clean / --no-clean-prompt
 * are set. When --auto-clean is set, trim is performed silently.
 */
async function maybePromptCleanup(
  runDir: string,
  flags: { autoClean: boolean; noPrompt: boolean },
): Promise<void> {
  const { summarizeRun, trimRunArtifacts, deleteRun, formatBytes } =
    await import("./runner/cleanup.ts");
  const summary = await summarizeRun(runDir);

  if (flags.autoClean) {
    const freed = await trimRunArtifacts(runDir);
    console.log(`cleanup: trimmed ${formatBytes(freed)} of per-step artifacts (auto-clean).`);
    return;
  }
  if (flags.noPrompt) return;
  if (!process.stdin.isTTY || !process.stdout.isTTY) return;

  console.log(
    `\nthis run wrote ${formatBytes(summary.bytes)} across ${summary.files} files at ${runDir}`,
  );
  console.log(`cleanup? [k]eep / [t]rim per-step / [d]elete entire run  (default: keep)`);
  process.stdout.write("> ");

  const answer = await new Promise<string>((resolve) => {
    let buf = "";
    process.stdin.setEncoding("utf8");
    const onData = (chunk: string): void => {
      buf += chunk;
      const nl = buf.indexOf("\n");
      if (nl >= 0) {
        process.stdin.removeListener("data", onData);
        process.stdin.pause();
        resolve(buf.slice(0, nl).trim().toLowerCase());
      }
    };
    process.stdin.resume();
    process.stdin.on("data", onData);
    // Don't block forever: 30s default-keep timeout.
    setTimeout(() => {
      process.stdin.removeListener("data", onData);
      process.stdin.pause();
      resolve("k");
    }, 30_000).unref?.();
  });

  if (answer === "t" || answer === "trim") {
    const freed = await trimRunArtifacts(runDir);
    console.log(`cleanup: trimmed ${formatBytes(freed)} of per-step artifacts. report + screenshots kept.`);
  } else if (answer === "d" || answer === "delete") {
    try {
      const freed = await deleteRun(runDir);
      console.log(`cleanup: deleted ${formatBytes(freed)} (entire run).`);
    } catch (err) {
      console.error(`cleanup: refused — ${err instanceof Error ? err.message : String(err)}`);
    }
  } else {
    console.log(`cleanup: kept. run \`gauntlet doctor\` later to clean up old runs.`);
  }
}

async function cmdDoctor(args: ParsedArgs): Promise<void> {
  const {
    summarizeRun,
    pruneOldRuns,
    reapTmpLeaks,
    formatBytes,
  } = await import("./runner/cleanup.ts");
  const cwd = process.cwd();
  const runsDir = join(cwd, ".gauntlet", "runs");

  console.log(`gauntlet doctor — checking ${cwd}`);
  console.log("");

  // Inventory existing runs.
  let runs: string[] = [];
  try {
    const { readdirSync } = await import("node:fs");
    runs = readdirSync(runsDir)
      .filter((n) => /^\d{4}-\d{2}-\d{2}T/.test(n))
      .sort();
  } catch {
    /* no .gauntlet/runs */
  }

  if (runs.length === 0) {
    console.log("no runs found under .gauntlet/runs/");
  } else {
    let totalBytes = 0;
    for (const r of runs) {
      const s = await summarizeRun(join(runsDir, r));
      totalBytes += s.bytes;
    }
    console.log(`runs: ${runs.length} run dirs, ${formatBytes(totalBytes)} total`);
    console.log(`  oldest: ${runs[0]}`);
    console.log(`  newest: ${runs[runs.length - 1]}`);
  }
  console.log("");

  const pruneArg = args.flags["prune-runs"];
  const reapTmp = args.flags["reap-tmp"] === true;
  const all = args.flags.all === true;

  let didSomething = false;

  if (pruneArg !== undefined || all) {
    const keep = typeof pruneArg === "string" ? Number(pruneArg) : 5;
    if (!Number.isFinite(keep) || keep < 0) {
      console.error(`error: --prune-runs must be a non-negative integer, got ${pruneArg}`);
      process.exit(2);
    }
    const r = await pruneOldRuns(runsDir, keep);
    console.log(
      `prune-runs: kept latest ${keep}, deleted ${r.deleted.length} (${formatBytes(r.bytesFreed)} freed)`,
    );
    if (r.deleted.length > 0) {
      for (const d of r.deleted.slice(0, 5)) console.log(`  - ${d}`);
      if (r.deleted.length > 5) console.log(`  ... +${r.deleted.length - 5} more`);
    }
    didSomething = true;
  }

  if (reapTmp || all) {
    const r = await reapTmpLeaks();
    console.log(
      `reap-tmp: deleted ${r.deleted.length} stale tmpdirs (${formatBytes(r.bytesFreed)} freed)`,
    );
    didSomething = true;
  }

  if (!didSomething) {
    console.log("(no actions taken — pass --prune-runs [N], --reap-tmp, or --all)");
    console.log("");
    console.log("examples:");
    console.log("  gauntlet doctor --prune-runs 3   # keep latest 3 runs, delete the rest");
    console.log("  gauntlet doctor --reap-tmp        # clean stale Playwright tmpdirs");
    console.log("  gauntlet doctor --all             # both, with default keep=5");
  }

  // AI provider liveness check — catches a dead/expired API key here instead of
  // mid-run (production hit a 401 partway through a run this week).
  console.log("");
  const model = typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const code = await doctorProviderCheck(model, args.flags["skip-keys"] === true);
  // Only set on failure: leave exitCode unset on success so the entrypoint's
  // `process.exitCode ?? 0` stays 0 and we don't clobber any earlier code.
  if (code !== 0) process.exitCode = code;
}

/**
 * Run doctor's provider liveness check and map the outcome to an exit code.
 * Extracted + exported so the CI-gating contract (a dead/expired key -> exit 1,
 * not a green exit-0 the entrypoint then propagates) is unit-testable without
 * spawning the whole CLI. Returns 0 = OK/skipped, 1 = unresolvable provider or
 * failed key. Resolution of pickProvider is injectable for tests.
 */
export async function doctorProviderCheck(
  model: string,
  skipKeys: boolean,
  deps?: {
    resolve?: (model: string) => AiProvider;
    preflight?: (p: AiProvider) => Promise<{ ok: true } | { ok: false; error: string }>;
  },
): Promise<0 | 1> {
  if (skipKeys) {
    console.log("provider: skipped (--skip-keys)");
    return 0;
  }
  const resolve = deps?.resolve ?? pickProvider;
  const preflight =
    deps?.preflight ?? (await import("./ai/preflight.ts")).preflightProvider;
  let provider: AiProvider;
  try {
    provider = resolve(model);
  } catch (err) {
    console.log(`provider ${model}: FAILED — ${err instanceof Error ? err.message : String(err)}`);
    return 1;
  }
  const res = await preflight(provider);
  if (res.ok) {
    console.log(`provider ${provider.name}/${provider.model}: OK`);
    return 0;
  }
  console.log(`provider ${provider.name}/${provider.model}: FAILED — ${res.error}`);
  return 1;
}

/**
 * Parse the optional `--vet-timeout <ms>` flag into a per-finding budget for
 * vetAll. Reuses parsePositiveIntFlag for validation, but — unlike most
 * numeric flags — a bad value here warns and is ignored (falls back to the
 * vetter's built-in default) rather than aborting the whole report. Warns
 * through the event stream so the renderers own user-facing output.
 */
export function parseVetTimeout(
  raw: string | boolean | undefined,
  emit: EventEmitter,
): number | undefined {
  try {
    const ms = parsePositiveIntFlag("vet-timeout", raw, 0);
    return ms === 0 ? undefined : ms;
  } catch (err) {
    emit({
      type: "warn",
      message: `${err instanceof Error ? err.message : String(err)} Ignoring --vet-timeout; using default vetter budget.`,
      context: "flag",
      ts: Date.now(),
    });
    return undefined;
  }
}

async function cmdReport(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const target =
    typeof args.flags.run === "string"
      ? args.flags.run
      : args.positional[0] ?? (await findLatestRunDir(cwd));
  if (!target) {
    console.error("error: no run directory found. pass --run <path> or run gauntlet first.");
    process.exit(2);
  }
  const skipVet = args.flags["no-vet"] === true;
  const noColor = args.flags["no-color"] === true;
  const eventsLog =
    typeof args.flags["events-log"] === "string"
      ? args.flags["events-log"]
      : undefined;
  const emit = await buildEmitter({ noColor, ...(eventsLog ? { eventsLog } : {}) });
  console.log(`gauntlet report -> ${target}${skipVet ? " (vetting disabled)" : ""}`);
  const reportStartedAt = Date.now();
  emit({
    type: "phase_start",
    phase: "report",
    label: skipVet ? "synthesizing report (vetting disabled)" : "synthesizing report + vetting",
    ts: reportStartedAt,
  });
  // Pass `emit` so vetter heartbeat reaches the user (codex audit 2026-05-14).
  const vetTimeoutMs = parseVetTimeout(args.flags["vet-timeout"], emit);
  const built = await buildReport({
    runDir: target,
    vet: !skipVet,
    ...(vetTimeoutMs !== undefined ? { vetTimeoutMs } : {}),
    emit,
  });
  emit({
    type: "phase_end",
    phase: "report",
    durationMs: Date.now() - reportStartedAt,
    ts: Date.now(),
  });
  console.log(
    `\nreport: ${built.markdownPath}\njson:   ${built.jsonPath}\nfindings=${built.report.totals.findings} verified=${built.report.totals.verified} subjective=${built.report.totals.subjective} regressed=${built.report.totals.regressed} could_not_replay=${built.report.totals.couldNotReplay} unverified=${built.report.totals.unverified}`,
  );
  if (built.report.patterns.length > 0) {
    console.log(`\ncross-persona patterns:`);
    for (const p of built.report.patterns.slice(0, 5)) {
      console.log(`  ${p.signature.padEnd(50)} ${p.count}x (${p.personas.join(", ")})`);
    }
  }
}

async function cmdComment(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const runDir =
    typeof args.positional[0] === "string"
      ? args.positional[0]
      : typeof args.flags.run === "string"
        ? args.flags.run
        : await findLatestRunDir(cwd);
  if (!runDir) {
    console.error("error: no run directory found. pass `gauntlet comment <run-dir>` or run gauntlet first.");
    process.exit(2);
  }

  const prArg = args.flags.pr;
  const prNumber =
    typeof prArg === "string"
      ? parsePositiveIntFlag("pr", prArg, 0)
      : undefined;
  const maxFindings = parsePositiveIntFlag("max", args.flags.max, 5, { max: 100 });
  const artifactBase = typeof args.flags["artifact-base"] === "string" ? args.flags["artifact-base"] : undefined;
  const runUrl = typeof args.flags["run-url"] === "string" ? args.flags["run-url"] : undefined;
  const dryRun = args.flags["dry-run"] === true;
  const repo = typeof args.flags.repo === "string" ? args.flags.repo : undefined;

  let report;
  try {
    const raw = await readFile(join(runDir, "report.json"), "utf8");
    report = JSON.parse(raw);
  } catch {
    console.error(`error: ${runDir}/report.json not found. Run \`gauntlet report\` first.`);
    process.exit(2);
  }

  const body = renderPrComment({
    report,
    maxFindings,
    ...(artifactBase ? { artifactBase } : {}),
    ...(runUrl ? { runUrl } : {}),
    ...(prNumber !== undefined ? { prNumber } : {}),
  });

  if (dryRun || prNumber === undefined) {
    // No PR target — print the body for piping/inspection.
    if (prNumber === undefined && !dryRun) {
      console.error("note: no --pr given; printing comment body. Pass --pr <num> to actually post.");
    }
    console.log(body);
    return;
  }

  // Post via gh CLI. Requires gh authenticated in the workflow / shell.
  const ghArgs = ["pr", "comment", String(prNumber), "--body", body];
  if (repo) {
    ghArgs.push("--repo", repo);
  }
  const proc = spawnSync("gh", ghArgs, { stdio: ["ignore", "inherit", "inherit"] });
  if (proc.status !== 0) {
    console.error(
      `error: gh pr comment failed (exit ${proc.status}). Is gh installed and authenticated?`,
    );
    process.exit(proc.status ?? 1);
  }
  console.log(`posted gauntlet comment to PR #${prNumber}${repo ? ` on ${repo}` : ""}.`);
}

async function cmdBench(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const sitesPath =
    typeof args.flags.sites === "string"
      ? args.flags.sites
      : join(cwd, "bench", "sites.json");
  const limit = parseOptionalBoundedIntFlag("limit", args.flags.limit, 1, 1000);
  const onlyNames = splitCsv(args.flags.only);
  const personasPerSite = parsePositiveIntFlag(
    "personas",
    args.flags.personas,
    2,
    { max: 100 },
  );
  const flowsPerPersona = parsePositiveIntFlag(
    "flows",
    args.flags.flows,
    2,
    { max: 50 },
  );
  const model = typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const cacheEnabled = args.flags["no-cache"] !== true;

  const file = await loadSitesFile(sitesPath);
  let sites = file.sites;
  if (onlyNames.length > 0) {
    const set = new Set(onlyNames);
    sites = sites.filter((s) => set.has(s.name));
  }
  if (limit !== undefined) sites = sites.slice(0, limit);

  console.log(`gauntlet bench`);
  console.log(`  sites file: ${sitesPath}`);
  console.log(`  sites:      ${sites.length} (${sites.map((s) => s.name).join(", ")})`);
  console.log(`  personas:   ${personasPerSite} per site`);
  console.log(`  flows:      ${flowsPerPersona} per persona`);
  console.log(`  model:      ${model}`);

  configureAiCache({ enabled: cacheEnabled, cwd });
  const provider = pickProvider(model);
  const benchRoot = join(cwd, "bench-tmp");

  const result = await runBench({
    provider,
    sites,
    benchRoot,
    personasPerSite,
    flowsPerPersona,
    log: (line) => console.log(line),
  });

  const out = await saveBenchReport({
    outDir: join(cwd, ".gauntlet", "bench"),
    result,
  });
  console.log(`\n=== bench complete ===`);
  console.log(`  sites ok:     ${result.totals.sitesOk}`);
  console.log(`  sites error:  ${result.totals.sitesError}`);
  console.log(`  findings:     ${result.totals.findings}`);
  console.log(`  duration:     ${Math.round((result.finishedAt - result.startedAt) / 1000)}s`);
  console.log(`\nmarkdown: ${out.markdownPath}`);
  console.log(`json:     ${out.jsonPath}`);
}

async function cmdSeed(args: ParsedArgs): Promise<void> {
  const cwd =
    typeof args.positional[0] === "string"
      ? args.positional[0]
      : typeof args.flags.cwd === "string"
        ? args.flags.cwd
        : process.cwd();
  const urls = splitCsv(args.flags.url);
  const model = typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const numPersonas = parsePositiveIntFlag(
    "personas",
    args.flags.personas,
    4,
    { max: 100 },
  );
  const flowsPerPersona = parsePositiveIntFlag(
    "flows",
    args.flags.flows,
    2,
    { max: 50 },
  );
  const cacheEnabled = args.flags["no-cache"] !== true;

  if (urls.length === 0) {
    console.error("error: gauntlet seed needs at least one --url <url>");
    console.error("usage: gauntlet seed [<cwd>] --url <url> [<url> ...] [--personas N] [--flows N]");
    process.exit(2);
  }

  const noColor = args.flags["no-color"] === true;
  const eventsLog =
    typeof args.flags["events-log"] === "string"
      ? args.flags["events-log"]
      : undefined;
  const emit = await buildEmitter({ noColor, ...(eventsLog ? { eventsLog } : {}) });

  console.log(`gauntlet seed`);
  console.log(`  cwd:      ${cwd}`);
  console.log(`  urls:     ${urls.join(", ")}`);
  console.log(`  personas: ${numPersonas}`);
  console.log(`  flows:    ${flowsPerPersona}`);
  console.log(`  model:    ${model}`);
  console.log(`  cache:    ${cacheEnabled ? "on" : "off"}`);
  console.log("");

  configureAiCache({ enabled: cacheEnabled, cwd });
  const provider = pickProvider(model);

  const seedStartedAt = Date.now();
  emit({
    type: "phase_start",
    phase: "init",
    label: "seeding project (surfaces + personas + flows)",
    ts: seedStartedAt,
  });

  const result = await seedProject({
    cwd,
    provider,
    urls,
    numPersonas,
    flowsPerPersona,
    log: (line) => console.log(line),
  });

  console.log(`\nseed complete.`);
  console.log(`  surfaces: ${result.surfaces.length}`);
  console.log(`  personas: ${result.personas.length}`);
  console.log(`  flows:    ${result.flows.length}`);

  const authNeeded = result.surfaces.filter((s) => s.requires_auth);
  if (authNeeded.length > 0) {
    console.log(`\nnext: capture auth for behind-login surfaces:`);
    for (const s of authNeeded) {
      console.log(`  gauntlet auth ${s.id}${s.login_url ? ` --url ${s.login_url}` : ""}`);
    }
  }
  console.log(`\nthen run gauntlet against each surface:`);
  for (const s of result.surfaces) {
    console.log(`  gauntlet run --surface ${s.id}`);
  }
  emit({
    type: "phase_end",
    phase: "init",
    durationMs: Date.now() - seedStartedAt,
    ts: Date.now(),
  });
}

async function cmdCrossReport(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const explicitRuns = splitCsv(args.flags.runs);
  const surfaceIds = splitCsv(args.flags.surfaces);
  const opts: Parameters<typeof buildCrossSurfaceReport>[0] = { cwd };
  if (explicitRuns.length > 0) opts.runDirs = explicitRuns;
  if (surfaceIds.length > 0) opts.surfaceIds = surfaceIds;
  if (args.flags.vet === true) opts.vet = true;
  const vetTopN = parseOptionalBoundedIntFlag(
    "vet-top",
    args.flags["vet-top"],
    1,
    1000,
  );
  if (vetTopN !== undefined) opts.vetTopN = vetTopN;

  if (opts.vet) console.log("gauntlet cross-report (vetting enabled - launching Playwright)");

  const built = await buildCrossSurfaceReport(opts);
  console.log(`gauntlet cross-report`);
  console.log(`  surfaces:  ${built.report.surfaces.length}`);
  console.log(`  unique:    ${built.report.totalUniqueSignatures}`);
  console.log(`  patterns:  ${built.report.patterns.length} (signatures present on >=2 surfaces)`);
  console.log("");
  console.log(`markdown: ${built.markdownPath}`);
  console.log(`json:     ${built.jsonPath}`);
  if (built.report.patterns.length > 0) {
    console.log(`\ntop cross-surface patterns:`);
    for (const p of built.report.patterns.slice(0, 8)) {
      console.log(`  ${p.signature.padEnd(28)} ${p.surfaces.length} surfaces, ${p.totalCount} findings (${p.surfaces.join(", ")})`);
    }
  }
}

async function cmdAuth(args: ParsedArgs): Promise<void> {
  const surfaceId = args.positional[0];
  if (!surfaceId) {
    console.error("error: usage: gauntlet auth <surface-id> [--url <login-url>]");
    process.exit(2);
  }
  const cwd = process.cwd();
  let surface;
  try {
    surface = await loadSurface(surfaceId, cwd);
  } catch (err) {
    console.error(`error: cannot load surface "${surfaceId}": ${err instanceof Error ? err.message : String(err)}`);
    console.error(`hint: run \`gauntlet surfaces\` to see what's curated.`);
    process.exit(2);
  }

  const explicitUrl = typeof args.flags.url === "string" ? args.flags.url : undefined;
  const url = explicitUrl ?? surface.login_url ?? surface.base_url;
  if (!url) {
    console.error(
      `error: no URL for auth capture. Surface "${surfaceId}" has no login_url or base_url. Pass --url <login-page>.`,
    );
    process.exit(2);
  }

  console.log(`gauntlet auth -> surface=${surfaceId} url=${url}`);
  const result = await captureAuth({ cwd, surfaceId, url });
  console.log(
    `\ncaptured: cookies=${result.cookieCount} origins=${result.originCount}`,
  );
  console.log(`saved:    ${result.relativePath}`);

  surface.auth_state = result.relativePath;
  if (!surface.requires_auth) surface.requires_auth = true;
  if (!surface.login_url && explicitUrl) surface.login_url = explicitUrl;
  const written = await writeSurface(surface, cwd);
  console.log(`updated:  ${written} (auth_state=${result.relativePath})`);
  console.log(`\nnext: gauntlet run --surface ${surfaceId} ...`);
}

async function cmdSurfaces(): Promise<void> {
  const { surfaces, diagnostics } = await loadAllSurfacesWithDiagnostics();
  // Surface load errors before listing so the operator sees them even when
  // the rest of the roster looks healthy. A typo in one yaml shouldn't
  // silently disappear the surface from `gauntlet surfaces` output.
  for (const d of diagnostics) {
    console.error(`warn: skipping ${d.path}: ${d.reason}`);
  }
  if (surfaces.length === 0 && diagnostics.length === 0) {
    console.log("no surfaces curated yet. run `gauntlet init` to discover them.");
    return;
  }
  console.log("curated surfaces (.gauntlet/surfaces/):");
  for (const s of surfaces) {
    console.log(`  ${s.id.padEnd(24)} ${s.name}`);
    console.log(`  ${" ".repeat(24)}   audience: ${s.audience}`);
    if (s.base_url) console.log(`  ${" ".repeat(24)}   base_url: ${s.base_url}`);
  }
  if (diagnostics.length > 0) {
    process.exitCode = 1;
  }
}

async function cmdList(): Promise<void> {
  const curated = await listCuratedPersonas();
  let totalDiagnostics = 0;
  if (curated.length > 0) {
    console.log("curated personas (.gauntlet/personas/):");
    for (const id of curated) {
      const p = await loadPersona(id);
      const { flows, diagnostics } = await loadFlowsForPersonaWithDiagnostics(id);
      for (const d of diagnostics) {
        // Per-flow yaml errors are operator mistakes (hand-edits that
        // broke the schema). Surface them with file path + reason so they
        // can fix the file instead of staring at "0 flows".
        console.error(`warn: skipping ${d.path}: ${d.reason}`);
      }
      totalDiagnostics += diagnostics.length;
      const flowSuffix = flows.length > 0 ? `  [${flows.length} flow${flows.length === 1 ? "" : "s"}]` : "";
      console.log(
        `  ${id.padEnd(28)} ${p.character.name} (${p.character.age ?? "?"})${flowSuffix}`,
      );
    }
  }
  if (totalDiagnostics > 0) {
    process.exitCode = 1;
  }
  const allFlows = await listFlows();
  if (allFlows.length === 0 && curated.length > 0) {
    console.log("\nno flows yet. run `gauntlet flows` to design test flows per persona.");
  }
  const builtin = await listBuiltinPersonas();
  if (builtin.length > 0) {
    if (curated.length > 0) console.log("");
    console.log("built-in personas (docs / examples):");
    for (const id of builtin) {
      const p = await loadPersona(id);
      console.log(
        `  ${id.padEnd(28)} ${p.character.name} (${p.character.age ?? "?"}) - ${p.character.context.split("\n")[0]}`,
      );
    }
  }
  if (curated.length === 0) {
    console.log("\nno curated roster yet. run `gauntlet init` to build one.");
  }
}

async function cmdInit(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const urls = splitCsv(args.flags.url);
  const model =
    typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const requested = parsePositiveIntFlag("count", args.flags.count, 10, { max: 200 });
  // Operator-supplied "what should the testers focus on?" directive. Flows
  // forward into surface / persona / flow generation so the AI weights
  // discovery toward this area. Empty / unset = no directive.
  const focus = typeof args.flags.focus === "string" ? args.flags.focus.trim() : "";
  const cacheEnabled = args.flags["no-cache"] !== true;
  const probeEnabled = args.flags["no-probe"] !== true && urls.length > 0;
  // Stage isolation flags. Default: run both phases.
  const skipSurfaces = args.flags["skip-surfaces"] === true;
  const skipPersonas = args.flags["skip-personas"] === true;
  const refreshSurfaces = args.flags["refresh-surfaces"] === true;
  const replacePersonas = args.flags["replace-personas"] === true;
  // Narrow persona generation to one surface (when you want more personas
  // on the under-served surface without touching the others).
  const onlySurfaceId =
    typeof args.flags.surface === "string" ? args.flags.surface : undefined;
  if (skipSurfaces && skipPersonas) {
    console.error("error: --skip-surfaces + --skip-personas leaves nothing to do.");
    process.exit(2);
  }

  const noColor = args.flags["no-color"] === true;
  const eventsLog =
    typeof args.flags["events-log"] === "string"
      ? args.flags["events-log"]
      : undefined;
  const emit = await buildEmitter({ noColor, ...(eventsLog ? { eventsLog } : {}) });

  console.log(`gauntlet init`);
  console.log(`  cwd:    ${cwd}`);
  console.log(`  model:  ${model}`);
  console.log(`  cache:  ${cacheEnabled ? "on (.gauntlet/cache/ai/)" : "off"}`);
  console.log(`  probe:  ${probeEnabled ? "on (/admin, /login, /pricing, ...)" : "off"}`);
  if (urls.length > 0) console.log(`  urls:   ${urls.join(", ")}`);
  if (skipSurfaces) console.log(`  flag:   --skip-surfaces (reuse curated)`);
  if (skipPersonas) console.log(`  flag:   --skip-personas`);
  if (refreshSurfaces) console.log(`  flag:   --refresh-surfaces (regen)`);
  if (replacePersonas) console.log(`  flag:   --replace-personas (drop curated first)`);
  if (onlySurfaceId) console.log(`  flag:   --surface ${onlySurfaceId} (narrow persona gen)`);

  configureAiCache({ enabled: cacheEnabled, cwd });
  const provider = pickProvider(model);

  const initStartedAt = Date.now();
  emit({
    type: "phase_start",
    phase: "init",
    label: "reading project context (README, package.json, landings)",
    ts: initStartedAt,
  });
  const project = await readProject({ cwd, urls, probePaths: probeEnabled });
  const reachable = project.landings.filter((l) => l.reachable).length;
  const unreachable = project.landings.length - reachable;
  console.log(
    `  project=${project.projectName ?? "(unknown)"} frameworks=[${project.frameworks.join(", ")}] readme=${project.readmeExcerpt ? "yes" : "no"} landings=${reachable}+${unreachable} bytes=${project.totalBytes}`,
  );
  for (const l of project.landings) {
    if (!l.reachable) console.log(`    [${l.statusCode ?? "ERR"}] ${l.url} (${l.hint ?? "unreachable"})`);
    else if (l.hint) console.log(`    [${l.statusCode}] ${l.url} (${l.hint})`);
  }

  const templates = await loadTemplates();
  console.log(`  templates loaded: ${templates.length}`);

  // [Phase A2] Surfaces. Skip when --skip-surfaces; regen when
  // --refresh-surfaces; otherwise reuse curated. Use the diagnostic-aware
  // loader so a hand-edited surface yaml that broke its schema is surfaced
  // here instead of silently disappearing from the roster.
  const surfacesLoad = await loadAllSurfacesWithDiagnostics(cwd);
  for (const d of surfacesLoad.diagnostics) {
    console.error(`warn: skipping ${d.path}: ${d.reason}`);
  }
  let surfaces = surfacesLoad.surfaces;
  if (skipSurfaces) {
    if (surfaces.length === 0) {
      console.error(
        "\nerror: --skip-surfaces requires curated surfaces to exist. Run `gauntlet init` (without --skip-surfaces) first, or drop the flag.",
      );
      process.exit(2);
    }
    console.log(
      `\n[Phase A2] skipped (--skip-surfaces); reusing ${surfaces.length} curated surface${surfaces.length === 1 ? "" : "s"}.`,
    );
  } else if (surfaces.length === 0 || refreshSurfaces) {
    emit({
      type: "phase_start",
      phase: "init",
      label: "AI proposing surfaces from landings + README",
      ts: Date.now(),
    });
    const proposed = await generateSurfaces({
      provider,
      project,
      ...(focus ? { focus } : {}),
    });
    console.log(`  ${proposed.length} surface${proposed.length === 1 ? "" : "s"} proposed`);
    for (const s of proposed) {
      const auth = s.requires_auth ? " (requires_auth)" : "";
      console.log(`    - ${s.id} (${s.name})${auth} base=${s.base_url ?? "(unset)"}`);
      await writeSurface(s, cwd);
    }
    surfaces = proposed;
  } else {
    console.log(
      `\n[Phase A2] reusing ${surfaces.length} existing surface yaml${surfaces.length === 1 ? "" : "s"} (pass --refresh-surfaces to regenerate)`,
    );
  }

  if (skipPersonas) {
    console.log(
      `\n[Phase B] skipped (--skip-personas). Surfaces are written; rerun without the flag to generate personas.`,
    );
    emit({
      type: "phase_end",
      phase: "init",
      durationMs: Date.now() - initStartedAt,
      ts: Date.now(),
    });
    return;
  }

  // If --surface specified, narrow generation to that surface only.
  const narrowSurfaces =
    onlySurfaceId !== undefined
      ? surfaces.filter((s) => s.id === onlySurfaceId)
      : surfaces;
  if (onlySurfaceId !== undefined && narrowSurfaces.length === 0) {
    console.error(`\nerror: --surface ${onlySurfaceId} matches no curated surface.`);
    process.exit(2);
  }

  // --replace-personas: delete existing curated yamls scoped by --surface
  // when set, otherwise all. Borrows the surface field from disk so we
  // only drop personas of the targeted surface.
  if (replacePersonas) {
    const personasDir = join(cwd, ".gauntlet/personas");
    let dropped = 0;
    for (const id of await listCuratedIds(cwd)) {
      try {
        const p = await loadPersona(id, cwd);
        if (onlySurfaceId !== undefined && p.surface !== onlySurfaceId) continue;
        await Bun.file(join(personasDir, `${id}.yaml`)).delete();
        dropped += 1;
      } catch {
        /* ignore */
      }
    }
    console.log(`  --replace-personas: dropped ${dropped} existing persona yaml${dropped === 1 ? "" : "s"}.`);
  }

  const existingIds = await listCuratedIds(cwd);
  if (existingIds.length > 0) {
    console.log(
      `  already-curated (${existingIds.length}): ${existingIds.join(", ")}`,
    );
  }

  emit({
    type: "phase_start",
    phase: "init",
    label: `AI proposing candidate personas${onlySurfaceId ? ` on surface "${onlySurfaceId}"` : ""}`,
    ts: Date.now(),
  });
  const candidates = await generateCandidates({
    provider,
    project,
    templates,
    count: requested,
    existing: existingIds,
    ...(narrowSurfaces.length > 0 ? { surfaces: narrowSurfaces } : {}),
    ...(focus ? { focus } : {}),
  });
  console.log(`  got ${candidates.length} unique candidates.`);

  const result = await curate(candidates, {
    cwd,
    regenerate: async (slotId: string): Promise<PersonaCandidate | undefined> => {
      console.log(`regenerating slot ${slotId}...`);
      const fresh = await generateCandidates({
        provider,
        project,
        templates,
        count: 1,
        existing: [...existingIds, ...result.accepted.map((p) => p.id)],
        ...(narrowSurfaces.length > 0 ? { surfaces: narrowSurfaces } : {}),
        ...(focus ? { focus } : {}),
      });
      return fresh[0];
    },
  });

  console.log(
    `\ndone. accepted=${result.accepted.length} rejected=${result.rejected.length} edited=${result.edited.length}`,
  );
  if (result.accepted.length > 0) {
    console.log(`personas written to ${join(cwd, ".gauntlet/personas")}/`);
    console.log(
      "next: `gauntlet flows --personas " +
        result.accepted.map((p) => p.id).join(",") +
        "` to design test flows per persona.",
    );
  }
  emit({
    type: "phase_end",
    phase: "init",
    durationMs: Date.now() - initStartedAt,
    ts: Date.now(),
  });
}

async function cmdFlows(args: ParsedArgs): Promise<void> {
  const cwd = process.cwd();
  const model =
    typeof args.flags.model === "string" ? args.flags.model : DEFAULT_MODEL;
  const url = typeof args.flags.url === "string" ? args.flags.url : undefined;
  const count = parsePositiveIntFlag("count", args.flags.count, 3, { max: 50 });
  const focus = typeof args.flags.focus === "string" ? args.flags.focus.trim() : "";
  const cacheEnabled = args.flags["no-cache"] !== true;
  const replaceFlag = args.flags.replace === true;
  // Narrow flows generation to personas on one surface.
  const onlySurfaceId =
    typeof args.flags.surface === "string" ? args.flags.surface : undefined;

  const personaArg = args.flags.personas;
  let personaIds: string[];
  if (!personaArg || personaArg === true) {
    personaIds = await listCuratedIds(cwd);
    if (personaIds.length === 0) {
      console.error("error: no curated personas. run `gauntlet init` first.");
      process.exit(2);
    }
  } else {
    personaIds = String(personaArg).split(",").map((s) => s.trim()).filter(Boolean);
  }

  // Surface filter — keep only personas whose surface matches.
  if (onlySurfaceId !== undefined) {
    const kept: string[] = [];
    for (const id of personaIds) {
      try {
        const p = await loadPersona(id, cwd);
        if (p.surface === onlySurfaceId) kept.push(id);
      } catch {
        /* skip */
      }
    }
    if (kept.length === 0) {
      console.error(`error: no personas have surface="${onlySurfaceId}".`);
      process.exit(2);
    }
    personaIds = kept;
  }

  const noColor = args.flags["no-color"] === true;
  const eventsLog =
    typeof args.flags["events-log"] === "string"
      ? args.flags["events-log"]
      : undefined;
  const emit = await buildEmitter({ noColor, ...(eventsLog ? { eventsLog } : {}) });

  console.log(`gauntlet flows`);
  console.log(`  cwd:      ${cwd}`);
  console.log(`  model:    ${model}`);
  console.log(`  personas: ${personaIds.join(", ")}`);
  console.log(`  cache:    ${cacheEnabled ? "on" : "off"}`);
  if (replaceFlag) console.log(`  flag:     --replace (drop existing flows first)`);
  if (onlySurfaceId) console.log(`  flag:     --surface ${onlySurfaceId}`);

  // --replace: drop existing flows for the selected personas before regen,
  // so the curated set isn't appended-to.
  if (replaceFlag) {
    const flowsDirPath = join(cwd, ".gauntlet/flows");
    let dropped = 0;
    for (const personaId of personaIds) {
      const flows = await loadFlowsForPersona(personaId, cwd);
      for (const f of flows) {
        try {
          await Bun.file(join(flowsDirPath, `${f.id}.yaml`)).delete();
          dropped += 1;
        } catch {
          /* ignore */
        }
      }
    }
    console.log(`  --replace: dropped ${dropped} existing flow yaml${dropped === 1 ? "" : "s"}.`);
  }

  configureAiCache({ enabled: cacheEnabled, cwd });
  const provider = pickProvider(model);

  const flowsStartedAt = Date.now();
  emit({
    type: "phase_start",
    phase: "flows",
    label: "reading project context",
    ts: flowsStartedAt,
  });
  const project = await readProject({ cwd, urls: url ? [url] : [] });
  console.log(
    `  project=${project.projectName ?? "(unknown)"} bytes=${project.totalBytes}`,
  );

  const summary: { persona: string; accepted: number; rejected: number }[] = [];

  // Surface lookup cache. Surface-aware flow generation respects each
  // surface's features / excluded_features so the AI doesn't propose flows
  // targeting capabilities the persona's surface doesn't expose.
  const surfaceCache = new Map<string, Awaited<ReturnType<typeof loadSurface>> | undefined>();
  async function surfaceFor(id: string | undefined): Promise<
    Awaited<ReturnType<typeof loadSurface>> | undefined
  > {
    if (!id) return undefined;
    if (surfaceCache.has(id)) return surfaceCache.get(id);
    try {
      const s = await loadSurface(id, cwd);
      surfaceCache.set(id, s);
      return s;
    } catch {
      surfaceCache.set(id, undefined);
      return undefined;
    }
  }

  for (const id of personaIds) {
    const persona = await loadPersona(id, cwd);
    const surface = await surfaceFor(persona.surface);
    const surfaceTag = surface ? ` [surface=${surface.id}]` : persona.surface ? ` [surface=${persona.surface} (yaml missing)]` : "";
    emit({
      type: "phase_start",
      phase: "flows",
      label: `${persona.id} (${persona.character.name})${surfaceTag}`,
      ts: Date.now(),
    });
    const flowOpts: Parameters<typeof generateFlows>[0] = { provider, project, persona, count };
    if (surface) flowOpts.surface = surface;
    if (focus) flowOpts.focus = focus;
    const flows = await generateFlows(flowOpts);
    console.log(`  AI proposed ${flows.length} flow${flows.length === 1 ? "" : "s"}`);

    const result = await curateFlows(flows, {
      cwd,
      regenerate: async () => {
        console.log("regenerating flows for this persona...");
        return generateFlows(flowOpts);
      },
    });

    summary.push({
      persona: persona.id,
      accepted: result.accepted.length,
      rejected: result.rejected.length,
    });
  }

  console.log("\nflows summary:");
  for (const s of summary) {
    console.log(`  ${s.persona.padEnd(28)} accepted=${s.accepted} rejected=${s.rejected}`);
  }
  console.log(`\nflows written to ${join(cwd, ".gauntlet/flows")}/`);
  emit({
    type: "phase_end",
    phase: "flows",
    durationMs: Date.now() - flowsStartedAt,
    ts: Date.now(),
  });
}

function cmdHelp(): void {
  console.log(`gauntlet - persona-driven UX failure discovery

usage:
  gauntlet init [--url <urls>] [--skip-surfaces | --refresh-surfaces]
                [--skip-personas] [--surface <id>] [--replace-personas]
                [--model <id>] [--count N] [--focus <text>]
                [--no-cache] [--no-probe]
  gauntlet flows [--personas <ids>] [--surface <id>] [--replace]
                 [--model <id>] [--count N] [--focus <text>]
                 [--url <url>] [--no-cache]
  gauntlet run [<url> | --url <url> | --surface <id> | --pr <num>]
               [--personas <id[,id...]>]
               [--flows <id[,id...]>] [--features <name[,...]>]
               [--tags <tag[,...]>] [--exclude-tags <tag[,...]>]
               [--paths <path[,...]>]
  gauntlet report [<run-dir>] [--run <path>] [--no-vet] [--vet-timeout <ms>]
  gauntlet surfaces
  gauntlet auth <surface-id> [--url <login-url>]
  gauntlet seed [<cwd>] --url <urls> [--personas N] [--flows N]
  gauntlet bench [--sites <path>] [--limit N] [--only <names>] [--personas N]
  gauntlet cross-report [--surfaces <ids>] [--runs <dirs>] [--vet] [--vet-top N]
  gauntlet comment [<run-dir>] --pr <num> [--max N] [--artifact-base <url>]
                   [--run-url <url>] [--repo owner/name] [--dry-run]
  gauntlet list
  gauntlet help

init flags (target):
  --url <urls>          landing page(s) to fetch for product context. Multiple
                        accepted: \`--url https://x.com https://x.com/admin\`
                        or comma-separated. Pages that 401/403 or look like
                        login walls get flagged so surface-generator infers
                        requires_auth=true.
  --no-probe            skip auto-probing /admin, /login, /pricing, /dashboard
                        on each origin (probe is on by default; 404s dropped,
                        200/401/403 fed to the surface AI).

init flags (stage isolation):
  --skip-surfaces       Phase A2 off; reuse existing curated surfaces.
                        Useful when surfaces are good but you want fresh personas.
  --refresh-surfaces    Phase A2 on; regen surfaces even if curated.
                        Useful when surfaces need rework but personas are fine.
  --skip-personas       Phase B off; only generate surfaces. Exit after Phase A2.
  --surface <id>        Narrow Phase B to personas on this surface only.
                        Useful when one surface is under-served.
  --replace-personas    Delete existing curated personas before Phase B regen
                        (scoped by --surface when set; otherwise all).

init flags (misc):
  --model <id>          AI model for persona generation (default ${DEFAULT_MODEL})
  --count <n>           candidate count to request from AI (default 10).
                        Values >12 are batched internally with dedupe so you
                        can ask for 30, 50, etc. without hitting the
                        per-call schema cap.
  --focus <text>        steer surface + persona + flow discovery toward a
                        specific area, e.g. \`--focus "the destinations form
                        and post-error recovery"\`. Personas/flows still
                        cover the rest of the product, but several extra
                        candidates will be biased toward stressing this
                        area. Quote multi-word values.
  --no-cache            disable AI response cache (default: cache on)

auth flags:
  --url <url>        login page URL (defaults to surface.login_url or surface.base_url)
  saves Playwright storageState to .gauntlet/auth/<surface-id>.json
  updates the surface yaml with auth_state + requires_auth=true

flows flags:
  --personas <ids>      curated persona ids to design flows for (default: all)
  --surface <id>        narrow to personas whose surface = <id>
  --replace             drop existing flows for the selected personas before
                        regen (default: append to the curated set)
  --model <id>          AI model for flow generation (default ${DEFAULT_MODEL})
  --count <n>           flows per persona to propose (default 3)
  --focus <text>        steer flows toward a specific area where the
                        persona's goals plausibly intersect with it.
                        Persona realism still wins ties.
  --url <url>           landing page to include in product context (optional)
  --no-cache            disable AI response cache

run target (pick one; combinable):
  <url> | --url <url>   point gauntlet at any URL
  --surface <id>        use surface.base_url + auto-select surface-tagged personas
  --pr <num>            resolve preview URL via .gauntlet/config.json
                        pr_url_template, else scan PR comments for vercel /
                        netlify / render / cloudflare-pages / fly preview URLs

run who:
  --personas <ids>      comma-separated persona ids (default: all under surface)

run what (flow filters; combine with AND, --tags is OR within group):
  --flows <ids>         only these flow ids
  --features <names>    flows whose flow.feature is in this list
  --tags <tags>         flows whose flow.tags has ANY of these
  --exclude-tags <tags> drop flows whose flow.tags has ANY of these
  --paths <paths>       flows whose flow.paths overlap (supports * glob)

run misc:
  --steps <n>           legacy single-step capture step count (default 1)
  --headed              run browser visibly (default headless)
  --model <id>          AI model for in-flow actions (default ${DEFAULT_MODEL})
  --concurrency <n>     personas to run in parallel (default 2)
  --quiet               suppress per-step heartbeat lines
  --no-cache            disable AI response cache
  --no-flows            force legacy single-step capture even if flows exist
  --no-report           skip post-run report build
  --vet-timeout <ms>    per-finding vetter budget (default 60000). Raise for
                        heavy SPAs whose axe replay needs longer. Invalid
                        values warn and fall back to the default.
  --no-color            disable ANSI color in text renderer (NO_COLOR env honored too)
  --events-log <path>   append every event to this JSONL file. tail -f to drive
                        gauntlet from an agent (Claude) in real time.
  --record-video        opt in to Playwright WebM video recording per flow.
                        Default OFF — Playwright's ffmpeg gracefulClose has
                        no internal deadline and has wedged production runs
                        for 12+ minutes. Screenshots, axe, and DOM artifacts
                        do not depend on this flag.
  --auto-clean          after the run, automatically trim per-step heavy
                        artifacts (DOM/ax-tree/axe/network/console/video).
                        Keeps screenshots + flow-result.json + REPORT.md.
                        Use in CI / automation where you don't want a prompt.
  --no-clean-prompt     skip the post-run cleanup prompt entirely (always
                        keep). Default behavior in non-TTY environments.

doctor command — clean up gauntlet's filesystem footprint:
  gauntlet doctor                       summary only (no actions taken)
  gauntlet doctor --prune-runs [N]      keep latest N runs (default 5), delete the rest
  gauntlet doctor --reap-tmp            delete stale Playwright tmpdirs (>1h old)
  gauntlet doctor --all                 do both
  gauntlet doctor --skip-keys           skip the AI provider key/network check
  gauntlet doctor --model <id>          provider to key-check (default: ${DEFAULT_MODEL})
  (the provider key/network check runs by default unless --skip-keys)
  --no-supervisor       run flows in-process instead of as a supervised
                        subprocess (debug only). Default ON — each flow runs
                        in its own detached process group with a parent-side
                        silence watchdog (~75s) that SIGKILLs the entire
                        tree if the worker goes silent, guaranteeing no flow
                        can wedge the gauntlet binary indefinitely.

run examples:
  gauntlet run --url https://staging.example.com --features checkout
  gauntlet run --surface marketing --tags smoke
  gauntlet run --pr 123                          # full surface against PR preview
  gauntlet run --pr 123 --features checkout      # just the feature you changed
  gauntlet run --surface app --personas mary --flows mary--save-recipe

report flags:
  --run <path>       path to a run directory (default: latest under .gauntlet/runs/)
  --no-vet           skip replay vetting (faster, but findings stay unverified)
  --vet-timeout <ms> per-finding vetter budget (default 60000); invalid -> default
  --no-color         disable ANSI color in text renderer
  --events-log <p>   append every event to this JSONL file (for agent tailing)

instrumentation (works on init / flows / run / report / seed):
  --no-color            disable ANSI color in text renderer (NO_COLOR env also honored)
  --events-log <path>   append the full GauntletEvent stream to this JSONL file.
                        Designed for an agent (Claude) to \`tail -f\` while gauntlet
                        runs. The text renderer always writes to stdout in addition.
`);
}

async function main(): Promise<void> {
  const args = parseArgs(process.argv);
  switch (args.command) {
    case "run":
      await cmdRun(args);
      break;
    case "init":
      await cmdInit(args);
      break;
    case "flows":
      await cmdFlows(args);
      break;
    case "report":
      await cmdReport(args);
      break;
    case "doctor":
      await cmdDoctor(args);
      break;
    case "surfaces":
      await cmdSurfaces();
      break;
    case "auth":
      await cmdAuth(args);
      break;
    case "cross-report":
      await cmdCrossReport(args);
      break;
    case "seed":
      await cmdSeed(args);
      break;
    case "bench":
      await cmdBench(args);
      break;
    case "comment":
      await cmdComment(args);
      break;
    case "list":
      await cmdList();
      break;
    case "help":
    case "--help":
    case "-h":
      cmdHelp();
      break;
    default:
      console.error(`unknown command: ${args.command}`);
      cmdHelp();
      process.exit(2);
  }
}

// Only auto-run when invoked as the entrypoint. Tests import parseArgs from
// this module without wanting `main()` to fire and consume process.argv.
if (import.meta.main) {
  main()
  .then(() => {
    // Force exit: keep-alive HTTP sockets (Anthropic/OpenAI) and any lingering
    // Playwright handles can hold the event loop open even after all our work
    // is done. We've already awaited everything we care about. Honor any
    // exit code a command already set (e.g. doctor's failed key check) instead
    // of hard-coding 0 — otherwise a non-zero status never reaches CI/scripts.
    process.exit(process.exitCode ?? 0);
  })
  .catch((err) => {
    // Bad numeric flag values are operator errors, not crashes. Print the
    // friendly message + exit 2 (same convention as other "bad usage" exits)
    // instead of dumping a stack trace.
    if (err instanceof FlagParseError) {
      console.error(`error: ${err.message}`);
      process.exit(2);
    }
    console.error("fatal:", err);
    process.exit(1);
  });
}
