import type { CDPSession, Page } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { join } from "node:path";

export interface StepCapture {
  stepIndex: number;
  timestamp: number;
  url: string;
  title: string;
  screenshotPath: string;
  domPath: string;
  axTreePath: string;
  consoleLogPath: string;
  networkLogPath: string;
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
  const consoleLogPath = join(stepDir, "console.jsonl");
  const networkLogPath = join(stepDir, "network.jsonl");

  await page.screenshot({ path: screenshotPath, fullPage: false });

  const html = await page.content();
  await writeFile(domPath, html, "utf8");

  let axTree: unknown = null;
  try {
    await cdp.send("Accessibility.enable");
    axTree = await cdp.send("Accessibility.getFullAXTree");
  } catch (err) {
    axTree = { error: err instanceof Error ? err.message : String(err) };
  }
  await writeFile(axTreePath, JSON.stringify(axTree, null, 2), "utf8");

  await writeFile(consoleLogPath, ctx.consoleLog.join("\n"), "utf8");
  await writeFile(
    networkLogPath,
    ctx.networkLog.map((e) => JSON.stringify(e)).join("\n"),
    "utf8",
  );

  return {
    stepIndex,
    timestamp: ts,
    url: page.url(),
    title: await page.title(),
    screenshotPath,
    domPath,
    axTreePath,
    consoleLogPath,
    networkLogPath,
  };
}
