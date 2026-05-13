import {
  chromium,
  type Browser,
  type BrowserContext,
  type ConsoleMessage,
  type LaunchOptions,
  type Page,
  type Request,
  type Response,
} from "playwright";
import { join } from "node:path";
import { writeFile } from "node:fs/promises";
import type { Persona } from "../persona/schema.ts";
import { NETWORK_PROFILES } from "./network-profiles.ts";
import {
  type CaptureContext,
  type NetworkEntry,
  captureStep,
  ensureRunDir,
} from "./capture.ts";
import { FailureReason, type FailureEvent } from "./failure-reasons.ts";
import { matchAxeViolationsToPersonaRules } from "./axe-scan.ts";
import { detectExternalHost } from "./external-host.ts";
import { classifyConsoleMessage } from "./console-class.ts";

/**
 * Bounded close. Mirrors the discipline in flow-runner.ts: if Playwright
 * hangs while releasing the context/browser we'd rather leak the OS process
 * than block the entire run forever.
 */
const CLOSE_TIMEOUT_MS = 8_000;
function closeWithTimeout(label: string, p: Promise<void>): Promise<void> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => resolve(), CLOSE_TIMEOUT_MS);
  });
  return Promise.race([
    p.catch((err) => {
      // Surface unusual close errors but don't reject — the outer finally
      // must continue closing the next resource.
      // eslint-disable-next-line no-console
      console.warn(`[gauntlet] ${label} threw during close: ${err instanceof Error ? err.message : String(err)}`);
    }),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
}

/**
 * Test seam. Production code uses the real Playwright `chromium`. Tests
 * inject a stub launcher to assert resource discipline (close is invoked on
 * exceptional paths) without spinning a real browser.
 */
export interface BrowserLauncher {
  launch(opts: LaunchOptions): Promise<Browser>;
}
let _launcher: BrowserLauncher = chromium;
export function _setBrowserLauncherForTesting(l: BrowserLauncher | undefined): void {
  _launcher = l ?? chromium;
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

export interface RunOptions {
  url: string;
  persona: Persona;
  runDir: string;
  maxSteps?: number;
  headless?: boolean;
  storageStatePath?: string;
}

export interface RunResult {
  persona: Persona;
  url: string;
  runDir: string;
  steps: number;
  failures: FailureEvent[];
  abandoned: boolean;
  durationMs: number;
}

export async function runPersona(opts: RunOptions): Promise<RunResult> {
  const { url, persona, runDir } = opts;
  const maxSteps = opts.maxSteps ?? 1;
  const headless = opts.headless ?? true;

  await ensureRunDir(runDir);
  const startedAt = Date.now();
  const failures: FailureEvent[] = [];

  // Resources held for the lifetime of this persona run. Declared outside
  // the try so the outer finally can release them even if anything from
  // page setup through capture/judge/writeFile throws. Mirrors the
  // discipline in flow-runner.ts (do not modify that file — see CLAUDE.md).
  let browser: Browser | undefined;
  let context: BrowserContext | undefined;

  try {
  browser = await _launcher.launch({ headless });
  const ua = DEVICE_USER_AGENTS[persona.behavior.device] ?? DEVICE_USER_AGENTS.desktop!;
  context = await browser.newContext({
    viewport: persona.behavior.viewport,
    userAgent: ua,
    hasTouch:
      persona.behavior.input === "touch" || persona.behavior.device === "tablet" ||
      persona.behavior.device === "mobile",
    isMobile:
      persona.behavior.device === "mobile" || persona.behavior.device === "tablet",
    recordVideo: { dir: join(runDir, "video") },
    ...(opts.storageStatePath ? { storageState: opts.storageStatePath } : {}),
  });

  const netProfile = NETWORK_PROFILES[persona.behavior.network];
  if (!netProfile) {
    throw new Error(`unknown network profile: ${persona.behavior.network}`);
  }

  const page: Page = await context.newPage();
  const cdp = await context.newCDPSession(page);
  await cdp.send("Network.emulateNetworkConditions", {
    offline: netProfile.offline,
    latency: netProfile.latencyMs,
    downloadThroughput: netProfile.downloadBps,
    uploadThroughput: netProfile.uploadBps,
  });

  const consoleLog: string[] = [];
  const networkLog: NetworkEntry[] = [];

  page.on("console", (msg: ConsoleMessage) => {
    const entry = {
      type: msg.type(),
      text: msg.text(),
      location: msg.location(),
      timestamp: Date.now(),
    };
    consoleLog.push(JSON.stringify(entry));
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
        stepIndex: -1,
        url: page.url(),
        ...(Object.keys(md).length > 0 ? { metadata: md } : {}),
      });
    }
  });

  page.on("pageerror", (err: Error) => {
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
      stepIndex: -1,
      url: page.url(),
    });
  });

  page.on("requestfailed", (req: Request) => {
    networkLog.push({
      timestamp: Date.now(),
      method: req.method(),
      url: req.url(),
      failure: req.failure()?.errorText ?? "unknown",
    });
    failures.push({
      reason: FailureReason.NETWORK_FAILURE,
      message: `${req.method()} ${req.url()} -> ${req.failure()?.errorText ?? "unknown"}`,
      timestamp: Date.now(),
      stepIndex: -1,
      url: page.url(),
    });
  });

  page.on("response", (resp: Response) => {
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
        stepIndex: -1,
        url: page.url(),
      });
    }
  });

  const captureCtx: CaptureContext = { runDir, consoleLog, networkLog };

  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    failures.push({
      reason: FailureReason.NAVIGATION_TIMEOUT,
      message: err instanceof Error ? err.message : String(err),
      timestamp: Date.now(),
      stepIndex: 0,
      url,
    });
  }

  const personaRules = [
    ...persona.behavior.abandons_on,
    ...persona.behavior.avoids,
  ];
  for (let i = 0; i < maxSteps; i++) {
    const cap = await captureStep(page, cdp, captureCtx, i);
    for (const v of cap.axe.violations) {
      if (v.impact === "serious" || v.impact === "critical") {
        failures.push({
          reason: FailureReason.ACCESSIBILITY_VIOLATION,
          message: `axe[${v.impact}] ${v.id}: ${v.help} (${v.nodeCount} node${v.nodeCount === 1 ? "" : "s"})`,
          timestamp: Date.now(),
          stepIndex: i,
          url: cap.url,
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
      cap.axe.violations,
      personaRules,
    );
    for (const hit of personaHits) {
      failures.push({
        reason: FailureReason.ABANDONED_BY_PERSONA,
        message: `${persona.id} would abandon: rule "${hit.rule}" matches axe "${hit.axeId}" (${hit.violation.help})`,
        timestamp: Date.now(),
        stepIndex: i,
        url: cap.url,
        metadata: {
          personaRule: hit.rule,
          axeId: hit.axeId,
          helpUrl: hit.violation.helpUrl,
        },
      });
    }
  }

  await writeFile(
    join(runDir, "meta.json"),
    JSON.stringify(
      {
        persona: persona.id,
        url,
        startedAt,
        finishedAt: Date.now(),
        steps: maxSteps,
        failures: failures.length,
      },
      null,
      2,
    ),
    "utf8",
  );

  return {
    persona,
    url,
    runDir,
    steps: maxSteps,
    failures,
    abandoned: false,
    durationMs: Date.now() - startedAt,
  };
  } finally {
    // Release Playwright resources even on exceptional paths (capture failure,
    // disk full on writeFile, AI/CDP throw, etc). Bounded so a hung close
    // doesn't wedge the run.
    if (context) {
      await closeWithTimeout("context.close", context.close());
    }
    if (browser) {
      await closeWithTimeout("browser.close", browser.close());
    }
  }
}
