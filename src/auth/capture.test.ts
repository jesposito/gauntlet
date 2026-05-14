import { afterAll, afterEach, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  _setBrowserLauncherForTesting,
  captureAuth,
  resolveAuthStatePath,
} from "./capture.ts";

const root = join(tmpdir(), `gauntlet-auth-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

afterAll(async () => {
  await rm(root, { recursive: true, force: true });
});

describe("resolveAuthStatePath", () => {
  test("returns undefined when not set", () => {
    expect(resolveAuthStatePath(root, undefined)).toBeUndefined();
  });

  test("returns undefined when path does not exist (warns)", async () => {
    await mkdir(root, { recursive: true });
    const out = resolveAuthStatePath(root, ".gauntlet/auth/missing.json");
    expect(out).toBeUndefined();
  });

  test("returns absolute path when relative file exists", async () => {
    const d = join(root, "exists");
    await mkdir(join(d, ".gauntlet/auth"), { recursive: true });
    await writeFile(join(d, ".gauntlet/auth/x.json"), "{}");
    const out = resolveAuthStatePath(d, ".gauntlet/auth/x.json");
    expect(out).toBe(join(d, ".gauntlet/auth/x.json"));
  });

  test("respects absolute path", async () => {
    const d = join(root, "abs");
    await mkdir(d, { recursive: true });
    const target = join(d, "session.json");
    await writeFile(target, "{}");
    expect(resolveAuthStatePath(root, target)).toBe(target);
  });
});

// --------------------------------------------------------------------------
// Resource discipline (codex audit 2026-05-14, finding #2).
//
// Pre-fix captureAuth ran browser/context setup outside try/finally, so any
// throw between launch and the explicit close calls leaked the browser. The
// fix wraps the entire body in try/finally with bounded close — same shape
// as src/runner/browser.ts. These tests pin browser.close() is invoked even
// when context creation throws.
// --------------------------------------------------------------------------

describe("captureAuth resource discipline", () => {
  afterEach(() => {
    _setBrowserLauncherForTesting(undefined);
  });

  test("calls browser.close even when newContext throws", async () => {
    const d = join(root, "leak-test");
    await mkdir(d, { recursive: true });
    let browserClosed = false;
    const fakeBrowser = {
      newContext: async () => {
        throw new Error("context creation failed");
      },
      close: async () => {
        browserClosed = true;
      },
    };
    _setBrowserLauncherForTesting({
      launch: async () => fakeBrowser as never,
    });

    await expect(
      captureAuth({
        cwd: d,
        surfaceId: "leak",
        url: "https://example.com",
      }),
    ).rejects.toThrow("context creation failed");

    expect(browserClosed).toBe(true);
  });

  test("calls context.close and browser.close on the happy path", async () => {
    // Skip the prompt: stub stdin so waitForEnter resolves immediately.
    const d = join(root, "happy-test");
    await mkdir(d, { recursive: true });
    let browserClosed = false;
    let contextClosed = false;
    const fakePage = {
      goto: async () => null,
    };
    const fakeContext = {
      newPage: async () => fakePage,
      storageState: async () => ({ cookies: [], origins: [] }),
      close: async () => {
        contextClosed = true;
      },
    };
    const fakeBrowser = {
      newContext: async () => fakeContext,
      close: async () => {
        browserClosed = true;
      },
    };
    _setBrowserLauncherForTesting({
      launch: async () => fakeBrowser as never,
    });

    // Drive waitForEnter by writing a newline after a tick.
    setTimeout(() => process.stdin.emit("data", Buffer.from("\n")), 10);
    const result = await captureAuth({
      cwd: d,
      surfaceId: "happy",
      url: "https://example.com",
    });
    expect(result.cookieCount).toBe(0);
    expect(contextClosed).toBe(true);
    expect(browserClosed).toBe(true);
  });
});
