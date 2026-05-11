import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Browser } from "playwright";
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
import { act, observe } from "../agent/actions.ts";
import { judgeStep, type StepVerdict } from "./step-judge.ts";

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

export interface FlowRunOptions {
  url: string;
  persona: Persona;
  flow: Flow;
  provider: AiProvider;
  runDir: string;
  headless?: boolean;
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
  outcome: "completed" | "abandoned" | "patience_exceeded" | "error";
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

  await ensureRunDir(runDir);
  const startedAt = Date.now();
  const failures: FailureEvent[] = [];
  const stepResults: StepResult[] = [];

  const browser: Browser = await chromium.launch({ headless });
  const ua = DEVICE_USER_AGENTS[persona.behavior.device] ?? DEVICE_USER_AGENTS.desktop!;
  const context = await browser.newContext({
    viewport: persona.behavior.viewport,
    userAgent: ua,
    hasTouch:
      persona.behavior.input === "touch" ||
      persona.behavior.device === "tablet" ||
      persona.behavior.device === "mobile",
    isMobile:
      persona.behavior.device === "mobile" || persona.behavior.device === "tablet",
    recordVideo: { dir: join(runDir, "video") },
  });

  const netProfile = NETWORK_PROFILES[persona.behavior.network];
  if (!netProfile) {
    await context.close();
    await browser.close();
    throw new Error(`unknown network profile: ${persona.behavior.network}`);
  }

  const page = await context.newPage();
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
      failures.push({
        reason: FailureReason.CONSOLE_ERROR,
        message: msg.text(),
        timestamp: Date.now(),
        stepIndex: stepResults.length,
        url: page.url(),
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
  const startUrl = resolveStartUrl(url, flow.starting_url_hint);
  const personaRules = [
    ...persona.behavior.abandons_on,
    ...persona.behavior.avoids,
  ];

  let outcome: FlowRunResult["outcome"] = "completed";
  let outcomeReason: string | undefined;

  try {
    await page.goto(startUrl, { waitUntil: "domcontentloaded", timeout: 30_000 });
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
      const elapsedS = (Date.now() - startedAt) / 1000;
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

      const actionCtx = {
        provider,
        page,
        ...(persona.character.voice ? { personaVoice: persona.character.voice } : {}),
      };

      if (step.observation_target) {
        const obs = await observe(actionCtx, step.observation_target);
        if (!obs.match) {
          const verdict: StepVerdict = {
            status: "give_up",
            give_up_reason: `expected to see ${step.observation_target}, but it isn't on the page`,
            evidence: obs.reasoning,
          };
          const capture = await captureStep(page, cdp, captureCtx, i);
          stepResults.push({
            stepIndex: i,
            intent: step.intent,
            action: undefined,
            performed: false,
            verdict,
            capture,
          });
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

      const actionResult = await act(actionCtx, step.intent);
      try {
        await page.waitForLoadState("networkidle", { timeout: 5000 });
      } catch {
        // not a failure — many SPAs never idle
      }

      const capture = await captureStep(page, cdp, captureCtx, i);

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

      const verdict = await judgeStep({
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
      });

      stepResults.push({
        stepIndex: i,
        intent: step.intent,
        action: actionResult.action,
        performed: actionResult.performed,
        verdict,
        capture,
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

  await context.close();
  await browser.close();

  return {
    persona,
    flow,
    url,
    runDir,
    steps: stepResults,
    failures,
    outcome,
    outcomeReason,
    durationMs: Date.now() - startedAt,
  };
}
