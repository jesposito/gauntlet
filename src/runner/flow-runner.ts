import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Browser, BrowserContext } from "playwright";
import { chromium } from "playwright";
import type { Persona } from "../persona/schema.ts";
import type { Flow } from "../flow/schema.ts";
import type { AiProvider } from "../ai/provider.ts";
import { NETWORK_PROFILES } from "./network-profiles.ts";
import {
  type CaptureContext,
  type NetworkEntry,
  type StepCapture,
  captureStep,
  ensureRunDir,
} from "./capture.ts";
import { FailureReason, type FailureEvent } from "./failure-reasons.ts";
import { matchAxeViolationsToPersonaRules } from "./axe-scan.ts";
import { detectExternalHost } from "./external-host.ts";
import { classifyConsoleMessage } from "./console-class.ts";
import { waitForDomSettle } from "./page-settle.ts";
import { act, observe } from "../agent/actions.ts";
import { judgeStep, type StepVerdict } from "./step-judge.ts";

const STEP_OP_TIMEOUT_MS = 60_000;

/**
 * Hard wallclock cap per flow. Even if every step succeeds within the per-step
 * timeout, the cumulative budget is bounded so a runaway flow can't hold up
 * the concurrent pool indefinitely. Tuned to ~10x a typical persona patience.
 */
const FLOW_WALLCLOCK_BUDGET_MS = 5 * 60_000;

class StepTimeoutError extends Error {
  constructor(label: string, ms: number) {
    super(`${label} timed out after ${ms}ms`);
    this.name = "StepTimeoutError";
  }
}

function withTimeout<T>(p: Promise<T>, ms: number, label: string): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => rej(new StepTimeoutError(label, ms)), ms);
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Like withTimeout, but feeds an AbortSignal into the builder. On timeout the
 * signal is aborted so the underlying op (AI fetch, etc) actually stops
 * mutating state instead of running to completion in the background. Used
 * for observe/act/judgeStep where the work is an HTTP call to an AI provider.
 */
function withCancellableTimeout<T>(
  build: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      controller.abort();
      rej(new StepTimeoutError(label, ms));
    }, ms);
  });
  return Promise.race([build(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Cancellable timeout with one retry. AI providers occasionally rate-limit
 * or return slow over flaky transit; a single retry catches transient
 * issues without hiding real hangs (still bounded by the same per-attempt
 * timeout). The persistent failure still throws StepTimeoutError on the
 * second attempt, so the outer catch can bail cleanly.
 */
async function aiOpWithTimeout<T>(
  build: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  try {
    return await withCancellableTimeout(build, ms, label);
  } catch (err) {
    if (err instanceof StepTimeoutError) {
      // One retry. Fresh signal, fresh budget.
      return await withCancellableTimeout(build, ms, `${label} (retry)`);
    }
    throw err;
  }
}

const DEVICE_USER_AGENTS: Record<string, string> = {
  desktop:
    "Mozilla/5.0 (X11; Linux x86_64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  laptop:
    "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/131.0 Safari/537.36",
  tablet:
    "Mozilla/5.0 (iPad; CPU OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
  mobile:
    "Mozilla/5.0 (iPhone; CPU iPhone OS 17_0 like Mac OS X) AppleWebKit/605.1.15 (KHTML, like Gecko) Version/17.0 Mobile/15E148 Safari/604.1",
};

export type FlowEvent =
  | { type: "flow_start"; personaId: string; flowId: string; totalSteps: number }
  | { type: "step_start"; personaId: string; flowId: string; stepIndex: number; intent: string }
  | { type: "step_observe"; personaId: string; flowId: string; stepIndex: number; matched: boolean; reasoning: string }
  | { type: "step_act"; personaId: string; flowId: string; stepIndex: number; action: string | undefined; targetName: string | undefined; performed: boolean; error?: string }
  | { type: "step_verdict"; personaId: string; flowId: string; stepIndex: number; status: "success" | "in_progress" | "give_up"; evidence: string }
  | { type: "flow_end"; personaId: string; flowId: string; outcome: FlowRunResult["outcome"]; durationMs: number };

export type FlowEventHandler = (event: FlowEvent) => void;

export interface FlowRunOptions {
  url: string;
  persona: Persona;
  flow: Flow;
  provider: AiProvider;
  runDir: string;
  headless?: boolean;
  onEvent?: FlowEventHandler;
  storageStatePath?: string;
  surfaceId?: string;
}

export interface StepResult {
  stepIndex: number;
  intent: string;
  action: string | undefined;
  performed: boolean;
  verdict: StepVerdict;
  capture: StepCapture;
}

export interface FlowRunResult {
  persona: Persona;
  flow: Flow;
  url: string;
  runDir: string;
  steps: StepResult[];
  failures: FailureEvent[];
  outcome: "completed" | "abandoned" | "patience_exceeded" | "timeout" | "error";
  outcomeReason: string | undefined;
  durationMs: number;
}

function resolveStartUrl(baseUrl: string, hint: string | undefined): string {
  if (!hint) return baseUrl;
  if (/^https?:\/\//.test(hint)) return hint;
  if (hint === "homepage" || hint === "/" || hint === "home") return baseUrl;
  try {
    const base = new URL(baseUrl);
    if (hint.startsWith("/")) return new URL(hint, `${base.protocol}//${base.host}`).toString();
    return baseUrl;
  } catch {
    return baseUrl;
  }
}

export async function runFlow(opts: FlowRunOptions): Promise<FlowRunResult> {
  const { url, persona, flow, provider, runDir } = opts;
  const headless = opts.headless ?? true;
  const emit: FlowEventHandler = opts.onEvent ?? (() => undefined);

  await ensureRunDir(runDir);
  const startedAt = Date.now();
  const failures: FailureEvent[] = [];
  const stepResults: StepResult[] = [];
  emit({ type: "flow_start", personaId: persona.id, flowId: flow.id, totalSteps: flow.steps.length });

  // Resources held by this flow. Declared up-front so the outer try/finally
  // can close them even if mid-flow code throws an unexpected error (schema
  // parse failure, provider crash, disk full on captureStep, etc).
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;
  let outcome: FlowRunResult["outcome"] = "completed";
  let outcomeReason: string | undefined;
  let startUrl: string = url;
  /**
   * Wallclock alarm: if the flow body never returns control (Playwright op
   * wedged with no AbortSignal support, browser pseudo-hang, etc), this fires
   * at FLOW_WALLCLOCK_BUDGET_MS and aggressively closes the browser. Closing
   * a Playwright browser causes all in-flight ops to reject, which
   * propagates up to the loop catch and exits cleanly. Repro path that
   * required this: get-facet.com scroll_to + a subsequent captureStep
   * combination that didn't honor any of our inner timeouts (gauntlet-l5a).
   */
  let wallclockAlarm: ReturnType<typeof setTimeout> | undefined;
  let wallclockFired = false;

  try {

  browser = await chromium.launch({ headless });
  wallclockAlarm = setTimeout(() => {
    wallclockFired = true;
    // Best-effort force-close. Even if these reject, the in-flight ops
    // they were holding open will reject too, which unblocks the awaits
    // inside the step loop. No await — we don't want this setTimeout
    // callback itself blocked on close.
    browser?.close().catch(() => undefined);
  }, FLOW_WALLCLOCK_BUDGET_MS);
  const ua = DEVICE_USER_AGENTS[persona.behavior.device] ?? DEVICE_USER_AGENTS.desktop!;
  context = await browser.newContext({
    viewport: persona.behavior.viewport,
    userAgent: ua,
    hasTouch:
      persona.behavior.input === "touch" ||
      persona.behavior.device === "tablet" ||
      persona.behavior.device === "mobile",
    isMobile:
      persona.behavior.device === "mobile" || persona.behavior.device === "tablet",
    recordVideo: { dir: join(runDir, "video") },
    ...(opts.storageStatePath ? { storageState: opts.storageStatePath } : {}),
  });

  const netProfile = NETWORK_PROFILES[persona.behavior.network];
  if (!netProfile) {
    await context.close();
    await browser.close();
    throw new Error(`unknown network profile: ${persona.behavior.network}`);
  }

  const page = await context.newPage();
  // Scale Playwright's default action/navigation timeouts with the persona's
  // network profile so a slow-3g persona doesn't fail every selector lookup
  // at the 30s default. Floor 30s, cap 90s.
  const networkSlowdown = Math.max(1, Math.round((netProfile.latencyMs || 0) / 100));
  const scaledDefaultTimeout = Math.min(90_000, Math.max(30_000, 30_000 * networkSlowdown));
  page.setDefaultTimeout(scaledDefaultTimeout);
  page.setDefaultNavigationTimeout(scaledDefaultTimeout);
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: netProfile.offline,
    latency: netProfile.latencyMs,
    downloadThroughput: netProfile.downloadBps,
    uploadThroughput: netProfile.uploadBps,
  });

  const consoleLog: string[] = [];
  const networkLog: NetworkEntry[] = [];

  page.on("console", (msg) => {
    consoleLog.push(
      JSON.stringify({
        type: msg.type(),
        text: msg.text(),
        location: msg.location(),
        timestamp: Date.now(),
      }),
    );
    if (msg.type() === "error") {
      const text = msg.text();
      const externalHost = detectExternalHost(text, page.url());
      const cls = classifyConsoleMessage(text);
      const md: Record<string, unknown> = {};
      if (externalHost) md.externalHost = externalHost;
      if (cls.class !== "unknown") md.consoleClass = cls.class;
      if (cls.cspDirective) md.cspDirective = cls.cspDirective;
      if (cls.label !== "console error") md.consoleLabel = cls.label;
      failures.push({
        reason: FailureReason.CONSOLE_ERROR,
        message: text,
        timestamp: Date.now(),
        stepIndex: stepResults.length,
        url: page.url(),
        ...(Object.keys(md).length > 0 ? { metadata: md } : {}),
      });
    }
  });
  page.on("pageerror", (err) => {
    consoleLog.push(
      JSON.stringify({
        type: "pageerror",
        text: err.message,
        stack: err.stack,
        timestamp: Date.now(),
      }),
    );
    failures.push({
      reason: FailureReason.UNCAUGHT_EXCEPTION,
      message: err.message,
      timestamp: Date.now(),
      stepIndex: stepResults.length,
      url: page.url(),
    });
  });
  page.on("requestfailed", (req) => {
    networkLog.push({
      timestamp: Date.now(),
      method: req.method(),
      url: req.url(),
      failure: req.failure()?.errorText ?? "unknown",
    });
  });
  page.on("response", (resp) => {
    networkLog.push({
      timestamp: Date.now(),
      method: resp.request().method(),
      url: resp.url(),
      status: resp.status(),
      statusText: resp.statusText(),
    });
    if (resp.status() >= 500) {
      failures.push({
        reason: FailureReason.HTTP_ERROR,
        message: `${resp.status()} ${resp.statusText()} ${resp.url()}`,
        timestamp: Date.now(),
        stepIndex: stepResults.length,
        url: page.url(),
      });
    }
  });

  const captureCtx: CaptureContext = { runDir, consoleLog, networkLog };
  startUrl = resolveStartUrl(url, flow.starting_url_hint);
  const personaRules = [
    ...persona.behavior.abandons_on,
    ...persona.behavior.avoids,
  ];

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
    // SPAs render a near-empty shell at DOMContentLoaded and only hydrate
    // after JS runs. networkidle is unreliable for apps that poll (analytics,
    // telemetry, websockets) — DOM-mutation settle is more robust.
    await waitForDomSettle(page, { quietMs: 600, timeoutMs: 8_000 });
  } catch (err) {
    outcome = "error";
    outcomeReason = `navigation failed: ${err instanceof Error ? err.message : String(err)}`;
    failures.push({
      reason: FailureReason.NAVIGATION_TIMEOUT,
      message: outcomeReason,
      timestamp: Date.now(),
      stepIndex: 0,
      url: startUrl,
    });
  }

  if (outcome === "completed") {
    for (let i = 0; i < flow.steps.length; i++) {
      const step = flow.steps[i]!;
      emit({ type: "step_start", personaId: persona.id, flowId: flow.id, stepIndex: i, intent: step.intent });
      const elapsedS = (Date.now() - startedAt) / 1000;
      // Hard wallclock cap independent of persona patience: even if each
      // step succeeds within its timeout, the flow can't run longer than
      // FLOW_WALLCLOCK_BUDGET_MS total. Protects the concurrent pool slot.
      const elapsedMs = Date.now() - startedAt;
      if (elapsedMs > FLOW_WALLCLOCK_BUDGET_MS) {
        outcome = "timeout";
        outcomeReason = `flow wallclock budget (${FLOW_WALLCLOCK_BUDGET_MS / 1000}s) exceeded after ${(elapsedMs / 1000).toFixed(1)}s`;
        failures.push({
          reason: FailureReason.NAVIGATION_TIMEOUT,
          message: outcomeReason,
          timestamp: Date.now(),
          stepIndex: i,
          url: page.url(),
        });
        emit({ type: "step_verdict", personaId: persona.id, flowId: flow.id, stepIndex: i, status: "give_up", evidence: outcomeReason });
        break;
      }
      if (elapsedS > persona.behavior.patience_threshold_seconds) {
        outcome = "patience_exceeded";
        outcomeReason = `persona patience (${persona.behavior.patience_threshold_seconds}s) exceeded after ${elapsedS.toFixed(1)}s`;
        failures.push({
          reason: FailureReason.ABANDONED_BY_PERSONA,
          message: outcomeReason,
          timestamp: Date.now(),
          stepIndex: i,
          url: page.url(),
        });
        break;
      }

      // Build a rolling memo of the last 3 step outcomes. observe / act
      // see prior intent + action + outcome so they don't repeat a target
      // that already failed. Pattern D from docs/PRIOR-ART.md.
      const recentSteps = stepResults.slice(-3).map((s) => {
        const outcome: "success" | "in_progress" | "give_up" | "no_match" | "failed" =
          s.verdict.status === "success"
            ? "success"
            : s.verdict.status === "in_progress"
              ? "in_progress"
              : "give_up";
        return {
          intent: s.intent,
          ...(s.action ? { action: s.action } : {}),
          outcome,
          ...(s.verdict.evidence ? { evidence: s.verdict.evidence } : {}),
        };
      });
      const actionCtx = {
        provider,
        page,
        ...(persona.character.voice ? { personaVoice: persona.character.voice } : {}),
        ...(recentSteps.length > 0 ? { recentSteps } : {}),
      };

      try {
      if (step.observation_target) {
        const obs = await aiOpWithTimeout(
          (signal) => observe({ ...actionCtx, signal }, step.observation_target!),
          STEP_OP_TIMEOUT_MS,
          "observe",
        );
        emit({ type: "step_observe", personaId: persona.id, flowId: flow.id, stepIndex: i, matched: !!obs.match, reasoning: obs.reasoning });
        if (!obs.match) {
          const verdict: StepVerdict = {
            status: "give_up",
            give_up_reason: `expected to see ${step.observation_target}, but it isn't on the page`,
            evidence: obs.reasoning,
          };
          const capture = await withTimeout(
            captureStep(page, cdp, captureCtx, i),
            STEP_OP_TIMEOUT_MS,
            "captureStep(observe-give_up)",
          );
          stepResults.push({
            stepIndex: i,
            intent: step.intent,
            action: undefined,
            performed: false,
            verdict,
            capture,
          });
          emit({ type: "step_verdict", personaId: persona.id, flowId: flow.id, stepIndex: i, status: "give_up", evidence: verdict.evidence });
          failures.push({
            reason: FailureReason.ABANDONED_BY_PERSONA,
            message: `step ${i + 1}: ${verdict.give_up_reason}`,
            timestamp: Date.now(),
            stepIndex: i,
            url: page.url(),
            metadata: { evidence: verdict.evidence },
          });
          outcome = "abandoned";
          outcomeReason = verdict.give_up_reason;
          break;
        }
      }

      const actionResult = await aiOpWithTimeout(
        (signal) => act({ ...actionCtx, signal }, step.intent),
        STEP_OP_TIMEOUT_MS,
        "act",
      );
      emit({
        type: "step_act",
        personaId: persona.id,
        flowId: flow.id,
        stepIndex: i,
        action: actionResult.action,
        targetName: actionResult.target?.name,
        performed: actionResult.performed,
        ...(actionResult.error !== undefined ? { error: actionResult.error } : {}),
      });
      try {
        await waitForDomSettle(page, { quietMs: 400, timeoutMs: 5_000 });
      } catch {
        // not a failure — many SPAs never idle
      }

      const capture = await withTimeout(
        captureStep(page, cdp, captureCtx, i),
        STEP_OP_TIMEOUT_MS,
        "captureStep",
      );

      // Axe-derived failures (same logic as legacy runner).
      for (const v of capture.axe.violations) {
        if (v.impact === "serious" || v.impact === "critical") {
          failures.push({
            reason: FailureReason.ACCESSIBILITY_VIOLATION,
            message: `axe[${v.impact}] ${v.id}: ${v.help} (${v.nodeCount} node${v.nodeCount === 1 ? "" : "s"})`,
            timestamp: Date.now(),
            stepIndex: i,
            url: capture.url,
            metadata: {
              axeId: v.id,
              helpUrl: v.helpUrl,
              sampleTargets: v.sampleTargets,
              ...(v.thirdParty ? { thirdParty: true } : {}),
              ...(v.thirdPartySource ? { thirdPartySource: v.thirdPartySource } : {}),
            },
          });
        }
      }
      const personaHits = matchAxeViolationsToPersonaRules(
        capture.axe.violations,
        personaRules,
      );
      for (const hit of personaHits) {
        failures.push({
          reason: FailureReason.ABANDONED_BY_PERSONA,
          message: `${persona.id} would abandon: rule "${hit.rule}" matches axe "${hit.axeId}" (${hit.violation.help})`,
          timestamp: Date.now(),
          stepIndex: i,
          url: capture.url,
          metadata: {
            personaRule: hit.rule,
            axeId: hit.axeId,
            helpUrl: hit.violation.helpUrl,
          },
        });
      }

      const verdict = await aiOpWithTimeout(
        (signal) =>
          judgeStep({
            provider,
            page,
            step,
            stepIndex: i,
            totalSteps: flow.steps.length,
            ...(persona.character.voice ? { personaVoice: persona.character.voice } : {}),
            actionResult: {
              performed: actionResult.performed,
              ...(actionResult.action !== undefined ? { action: actionResult.action } : {}),
              ...(actionResult.error !== undefined ? { error: actionResult.error } : {}),
            },
            signal,
          }),
        STEP_OP_TIMEOUT_MS,
        "judgeStep",
      );

      stepResults.push({
        stepIndex: i,
        intent: step.intent,
        action: actionResult.action,
        performed: actionResult.performed,
        verdict,
        capture,
      });
      emit({
        type: "step_verdict",
        personaId: persona.id,
        flowId: flow.id,
        stepIndex: i,
        status: verdict.status,
        evidence: verdict.evidence,
      });

      if (verdict.status === "give_up") {
        failures.push({
          reason: FailureReason.ABANDONED_BY_PERSONA,
          message: `step ${i + 1}: ${verdict.give_up_reason ?? "give_up"} — ${verdict.evidence}`,
          timestamp: Date.now(),
          stepIndex: i,
          url: page.url(),
          metadata: { evidence: verdict.evidence },
        });
        outcome = "abandoned";
        outcomeReason = verdict.give_up_reason ?? "give_up";
        break;
      }
      } catch (err) {
        if (err instanceof StepTimeoutError) {
          failures.push({
            reason: FailureReason.NAVIGATION_TIMEOUT,
            message: `step ${i + 1}: ${err.message}`,
            timestamp: Date.now(),
            stepIndex: i,
            url: page.url(),
          });
          outcome = "timeout";
          outcomeReason = err.message;
          emit({ type: "step_verdict", personaId: persona.id, flowId: flow.id, stepIndex: i, status: "give_up", evidence: err.message });
          break;
        }
        throw err;
      }
    }
  }

  await writeFile(
    join(runDir, "flow-result.json"),
    JSON.stringify(
      {
        persona: persona.id,
        flow: flow.id,
        url,
        startUrl,
        ...(opts.surfaceId ? { surface: opts.surfaceId } : {}),
        startedAt,
        finishedAt: Date.now(),
        outcome,
        outcomeReason,
        steps: stepResults.map((s) => ({
          stepIndex: s.stepIndex,
          intent: s.intent,
          action: s.action,
          performed: s.performed,
          verdict: s.verdict,
        })),
        failures,
      },
      null,
      2,
    ),
    "utf8",
  );

  } finally {
    if (wallclockAlarm) clearTimeout(wallclockAlarm);
    if (wallclockFired && outcome === "completed") {
      // Wallclock alarm fired but the body didn't see it through outcome.
      // Mark the flow accordingly so the report reflects what happened.
      outcome = "timeout";
      outcomeReason = `flow wallclock alarm fired at ${FLOW_WALLCLOCK_BUDGET_MS / 1000}s — browser force-closed`;
    }
    // Close with hard timeouts; if Playwright hangs, force-kill the browser
    // process rather than blocking the entire run forever. Wrapped in
    // finally so non-timeout exceptions (provider crash, disk full, etc)
    // also release Playwright handles.
    const CLOSE_TIMEOUT_MS = 8_000;
    if (context) {
      try {
        await withTimeout(context.close(), CLOSE_TIMEOUT_MS, "context.close");
      } catch {
        /* ignore — proceed to browser.close which kills the process */
      }
    }
    if (browser) {
      try {
        await withTimeout(browser.close(), CLOSE_TIMEOUT_MS, "browser.close");
      } catch {
        /* ignore — process leak is preferable to hung run */
      }
    }
  }

  const durationMs = Date.now() - startedAt;
  emit({ type: "flow_end", personaId: persona.id, flowId: flow.id, outcome, durationMs });

  return {
    persona,
    flow,
    url,
    runDir,
    steps: stepResults,
    failures,
    outcome,
    outcomeReason,
    durationMs,
  };
}
