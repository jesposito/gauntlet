import { chromium } from "playwright";
import { mkdir, writeFile } from "node:fs/promises";
import { dirname, join, relative, isAbsolute, resolve } from "node:path";
import { existsSync } from "node:fs";

export interface CaptureAuthOptions {
  cwd: string;
  surfaceId: string;
  url: string;
  outputPath?: string;
}

export interface CaptureAuthResult {
  outputPath: string;
  relativePath: string;
  cookieCount: number;
  originCount: number;
}

const PROMPT = [
  "",
  "================================================================",
  "  gauntlet auth capture",
  "================================================================",
  "  A headed Chromium window has opened.",
  "  1. Log in normally (use whatever flow the surface requires).",
  "  2. When you reach a logged-in page, return to this terminal.",
  "  3. Press <Enter> here to save the session.",
  "",
  "  Press Ctrl+C to abort without saving.",
  "================================================================",
  "",
].join("\n");

function waitForEnter(): Promise<void> {
  return new Promise((res) => {
    const onData = (chunk: Buffer): void => {
      const s = chunk.toString("utf8");
      if (s.includes("\n") || s.includes("\r")) {
        process.stdin.removeListener("data", onData);
        if (process.stdin.isTTY) process.stdin.setRawMode(false);
        process.stdin.pause();
        res();
      }
    };
    if (process.stdin.isTTY) process.stdin.setRawMode(false);
    process.stdin.resume();
    process.stdin.on("data", onData);
  });
}

export async function captureAuth(opts: CaptureAuthOptions): Promise<CaptureAuthResult> {
  const defaultOut = join(".gauntlet", "auth", `${opts.surfaceId}.json`);
  const outAbs = isAbsolute(opts.outputPath ?? defaultOut)
    ? (opts.outputPath ?? defaultOut)
    : resolve(opts.cwd, opts.outputPath ?? defaultOut);
  const outRel = relative(opts.cwd, outAbs);

  // Auth state contains cookies + localStorage tokens — protect from
  // group/world readers on shared boxes.
  await mkdir(dirname(outAbs), { recursive: true, mode: 0o700 });

  const browser = await chromium.launch({ headless: false });
  const context = await browser.newContext();
  const page = await context.newPage();

  try {
    console.log(`opening: ${opts.url}`);
    await page.goto(opts.url, { waitUntil: "domcontentloaded", timeout: 30_000 });
  } catch (err) {
    console.warn(`warn: navigation failed: ${(err as Error).message} (browser still open for manual nav)`);
  }

  process.stdout.write(PROMPT);
  await waitForEnter();

  const state = await context.storageState();
  await writeFile(outAbs, JSON.stringify(state, null, 2), {
    encoding: "utf8",
    mode: 0o600,
  });

  await context.close();
  await browser.close();

  return {
    outputPath: outAbs,
    relativePath: outRel,
    cookieCount: state.cookies.length,
    originCount: state.origins.length,
  };
}

export function resolveAuthStatePath(
  cwd: string,
  authState: string | undefined,
): string | undefined {
  if (!authState) return undefined;
  const abs = isAbsolute(authState) ? authState : resolve(cwd, authState);
  if (!existsSync(abs)) {
    console.warn(
      `warn: auth_state file not found at ${abs}; running without auth. Run \`gauntlet auth\` first.`,
    );
    return undefined;
  }
  return abs;
}
