import type { CDPSession, Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";
import { runAxe, type AxeScanResult } from "./axe-scan.ts";

export interface StepCapture {
  stepIndex: number;
  timestamp: number;
  url: string;
  title: string;
  screenshotPath: string;
  domPath: string;
  axTreePath: string;
  axeReportPath: string;
  consoleLogPath: string;
  networkLogPath: string;
  axe: AxeScanResult;
}

export interface CaptureContext {
  runDir: string;
  consoleLog: string[];
  networkLog: NetworkEntry[];
}

export interface NetworkEntry {
  timestamp: number;
  method: string;
  url: string;
  status?: number;
  statusText?: string;
  failure?: string;
}

export async function ensureRunDir(runDir: string): Promise<void> {
  await mkdir(runDir, { recursive: true });
}

/**
 * Per-op timeout for "should-be-instant" data fetches inside captureStep
 * (page.content, CDP accessibility tree, page.title). The outer flow-runner
 * already wraps captureStep in a 60s `withTimeout`, but `Promise.race` only
 * unblocks the AWAITER — the underlying Playwright call keeps running and
 * can hold the page in a state where subsequent steps wedge too. Bounding
 * each inner op makes captureStep best-effort: a stalled sub-op produces a
 * sentinel and the rest of the capture proceeds, instead of stalling the
 * whole step until the outer 60s alarm.
 *
 * Codex audit 2026-05-14 flagged page.content (line 79), cdp.send accessibility
 * (line 82), and page.title (line 105) as having no inner deadline.
 */
const CAPTURE_OP_TIMEOUT_MS = 5_000;

/**
 * Race a promise against a per-op timer. On timeout, resolve to `sentinel`
 * (NOT throw) and warn — captureStep is best-effort and a partial result is
 * better than aborting the entire step. The underlying op may keep running
 * in the background; that's an acceptable leak vs. cascading hangs because
 * Playwright drops these handles when the page/context closes.
 */
async function withCaptureTimeout<T>(
  label: string,
  p: Promise<T>,
  sentinel: T,
  ms: number = CAPTURE_OP_TIMEOUT_MS,
): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<{ __timedOut: true }>((resolve) => {
    timer = setTimeout(() => resolve({ __timedOut: true }), ms);
  });
  try {
    const winner = await Promise.race([
      p.then((v) => ({ __timedOut: false as const, v })),
      timeout,
    ]);
    if ("v" in winner) return winner.v;
    console.warn(`captureStep: ${label} exceeded ${ms}ms — using sentinel`);
    return sentinel;
  } finally {
    if (timer) clearTimeout(timer);
  }
}

export async function captureStep(
  page: Page,
  cdp: CDPSession,
  ctx: CaptureContext,
  stepIndex: number,
): Promise<StepCapture> {
  const ts = Date.now();
  const stepDir = join(ctx.runDir, "steps", String(stepIndex).padStart(4, "0"));
  await mkdir(stepDir, { recursive: true });

  const screenshotPath = join(stepDir, "screenshot.png");
  const domPath = join(stepDir, "dom.html");
  const axTreePath = join(stepDir, "ax-tree.json");
  const axeReportPath = join(stepDir, "axe.json");
  const consoleLogPath = join(stepDir, "console.jsonl");
  const networkLogPath = join(stepDir, "network.jsonl");

  // SPAs with streaming content can keep painting forever; bound the
  // screenshot wait and fall back to a still-frame on timeout.
  try {
    await page.screenshot({ path: screenshotPath, fullPage: false, timeout: 10_000 });
  } catch (err) {
    try {
      await page.screenshot({
        path: screenshotPath,
        fullPage: false,
        timeout: 4_000,
        animations: "disabled",
        caret: "hide",
      });
    } catch {
      // give up on this step's screenshot rather than fail the whole run
      await writeFile(
        screenshotPath.replace(/\.png$/, ".error.txt"),
        `screenshot failed: ${err instanceof Error ? err.message : String(err)}`,
        "utf8",
      );
    }
  }

  const html = await withCaptureTimeout(
    "page.content",
    page.content(),
    "<!-- capture timeout: page.content exceeded budget -->",
  );
  await writeFile(domPath, html, "utf8");

  let axTree: unknown = null;
  try {
    await withCaptureTimeout(
      "cdp.Accessibility.enable",
      cdp.send("Accessibility.enable").then(() => undefined),
      undefined,
    );
    axTree = await withCaptureTimeout(
      "cdp.Accessibility.getFullAXTree",
      cdp.send("Accessibility.getFullAXTree") as Promise<unknown>,
      { error: "capture timeout: cdp.send(Accessibility.getFullAXTree) exceeded budget" },
    );
  } catch (err) {
    axTree = { error: err instanceof Error ? err.message : String(err) };
  }
  await writeFile(axTreePath, JSON.stringify(axTree, null, 2), "utf8");

  const axe = await runAxe(page);
  await writeFile(axeReportPath, JSON.stringify(axe, null, 2), "utf8");

  await writeFile(consoleLogPath, ctx.consoleLog.join("\n"), "utf8");
  await writeFile(
    networkLogPath,
    ctx.networkLog.map((e) => JSON.stringify(e)).join("\n"),
    "utf8",
  );

  const title = await withCaptureTimeout("page.title", page.title(), "");

  return {
    stepIndex,
    timestamp: ts,
    url: page.url(),
    title,
    screenshotPath,
    domPath,
    axTreePath,
    axeReportPath,
    consoleLogPath,
    networkLogPath,
    axe,
  };
}
