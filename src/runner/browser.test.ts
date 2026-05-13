import { afterEach, describe, expect, test } from "bun:test";
import { mkdtempSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setBrowserLauncherForTesting,
  runPersona,
  type BrowserLauncher,
} from "./browser.ts";
import type { Persona } from "../persona/schema.ts";

const persona: Persona = {
  id: "test-persona",
  character: {
    name: "Test",
    context: "test",
    voice: "test",
  },
  behavior: {
    goals: ["test"],
    device: "desktop",
    viewport: { width: 1280, height: 720 },
    network: "fast-fiber",
    input: "mouse",
    patience_threshold_seconds: 30,
    reading_level: "9th_grade",
    avoids: [],
    abandons_on: [],
    prefers: [],
  },
};

interface CallTracker {
  contextClosed: boolean;
  browserClosed: boolean;
}

/**
 * Build a stub Playwright launcher whose newContext throws — proving that
 * runPersona's outer try/finally still releases the browser even when the
 * post-launch path explodes (codex audit finding #6).
 *
 * Returns the launcher and a tracker the test asserts against. Stubs are
 * intentionally minimal — only the methods runPersona's setup path calls
 * before the injected throw need to exist.
 */
function makeFailingLauncher(failAt: "newContext" | "newPage"): {
  launcher: BrowserLauncher;
  tracker: CallTracker;
} {
  const tracker: CallTracker = { contextClosed: false, browserClosed: false };

  const fakeContext = {
    newPage: async () => {
      if (failAt === "newPage") throw new Error("simulated newPage failure");
      return {} as unknown;
    },
    newCDPSession: async () => ({ send: async () => undefined }),
    close: async () => {
      tracker.contextClosed = true;
    },
  };

  const fakeBrowser = {
    newContext: async () => {
      if (failAt === "newContext") throw new Error("simulated newContext failure");
      return fakeContext;
    },
    close: async () => {
      tracker.browserClosed = true;
    },
  };

  const launcher: BrowserLauncher = {
    launch: async () => fakeBrowser as never,
  };
  return { launcher, tracker };
}

describe("runPersona resource discipline", () => {
  afterEach(() => {
    _setBrowserLauncherForTesting(undefined);
  });

  test("closes browser when newContext throws (no context to close)", async () => {
    const { launcher, tracker } = makeFailingLauncher("newContext");
    _setBrowserLauncherForTesting(launcher);

    const runDir = mkdtempSync(join(tmpdir(), "gauntlet-browser-test-"));
    await expect(
      runPersona({
        url: "https://example.com",
        persona,
        runDir,
        maxSteps: 1,
      }),
    ).rejects.toThrow("simulated newContext failure");

    // Context never opened, so only browser.close() must fire.
    expect(tracker.contextClosed).toBe(false);
    expect(tracker.browserClosed).toBe(true);
  });

  test("closes context AND browser when newPage throws after context opens", async () => {
    const { launcher, tracker } = makeFailingLauncher("newPage");
    _setBrowserLauncherForTesting(launcher);

    const runDir = mkdtempSync(join(tmpdir(), "gauntlet-browser-test-"));
    await expect(
      runPersona({
        url: "https://example.com",
        persona,
        runDir,
        maxSteps: 1,
      }),
    ).rejects.toThrow("simulated newPage failure");

    expect(tracker.contextClosed).toBe(true);
    expect(tracker.browserClosed).toBe(true);
  });
});
