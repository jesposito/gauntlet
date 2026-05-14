import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtemp, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";

// Stub @axe-core/playwright so captureStep -> runAxe doesn't try to touch
// real axe internals against our minimal page double.
mock.module("@axe-core/playwright", () => ({
  AxeBuilder: class {
    withTags() {
      return this;
    }
    async analyze() {
      return { violations: [], passes: [], incomplete: [], inapplicable: [] };
    }
  },
}));

// Import AFTER the module mock so the module-resolution of capture.ts picks
// up our stub via runAxe's import.
const { captureStep, ensureRunDir } = await import("./capture.ts");

let tmpDirs: string[] = [];

afterEach(async () => {
  for (const d of tmpDirs) {
    await rm(d, { recursive: true, force: true });
  }
  tmpDirs = [];
});

async function newRunDir(): Promise<string> {
  const d = await mkdtemp(join(tmpdir(), "gauntlet-capture-test-"));
  tmpDirs.push(d);
  await ensureRunDir(d);
  return d;
}

/**
 * Minimal Page/CDPSession doubles for captureStep. Only the subset of
 * methods captureStep calls is implemented. The opts override which calls
 * "hang" (return a never-resolving promise) so we can prove the inner
 * timeout produces a sentinel rather than blocking the step.
 */
function makeFakes(opts: {
  hangContent?: boolean;
  hangCdpSend?: boolean;
  hangTitle?: boolean;
}) {
  const never = new Promise<never>(() => {
    /* never resolves */
  });
  const page = {
    url: () => "https://example.com/",
    async screenshot() {
      /* no-op */
    },
    content: () =>
      opts.hangContent ? (never as unknown as Promise<string>) : Promise.resolve("<html></html>"),
    title: () => (opts.hangTitle ? (never as unknown as Promise<string>) : Promise.resolve("Hi")),
  };
  const cdp = {
    send: (_method: string, _params?: unknown) =>
      opts.hangCdpSend ? (never as unknown as Promise<unknown>) : Promise.resolve({ nodes: [] }),
  };
  return { page: page as never, cdp: cdp as never };
}

const ctx = (runDir: string) => ({ runDir, consoleLog: [], networkLog: [] });

describe("captureStep inner timeouts", () => {
  test("page.content() hang yields sentinel DOM, does not block step", async () => {
    const runDir = await newRunDir();
    const { page, cdp } = makeFakes({ hangContent: true });

    const start = Date.now();
    const result = await captureStep(page, cdp, ctx(runDir), 0);
    const elapsed = Date.now() - start;

    // Capture timeout is 5_000ms. Allow generous slack for CI but assert we
    // didn't blow well past the inner deadline (i.e. we DID return early).
    expect(elapsed).toBeLessThan(8_000);

    const dom = await readFile(result.domPath, "utf8");
    expect(dom).toContain("capture timeout");
    // Other fields still present.
    expect(result.url).toBe("https://example.com/");
    expect(result.title).toBe("Hi");
  }, 15_000);

  test("cdp.send hang yields error sentinel for ax-tree, does not throw", async () => {
    const runDir = await newRunDir();
    const { page, cdp } = makeFakes({ hangCdpSend: true });

    const start = Date.now();
    const result = await captureStep(page, cdp, ctx(runDir), 1);
    const elapsed = Date.now() - start;

    // Two sequential CDP calls each get bounded at 5s, so worst-case is ~10s.
    // The point: NOT unbounded (would never return). Slack for CI noise.
    expect(elapsed).toBeLessThan(13_000);

    const ax = JSON.parse(await readFile(result.axTreePath, "utf8"));
    // First cdp call (Accessibility.enable) sentinel is undefined and gets
    // swallowed; the second (getFullAXTree) hits the timeout sentinel.
    // Either way, axTree should serialize without throwing — and the file
    // should reflect a partial-result shape.
    expect(ax === null || typeof ax === "object").toBe(true);
  }, 20_000);

  test("page.title() hang yields empty-string title, does not block step", async () => {
    const runDir = await newRunDir();
    const { page, cdp } = makeFakes({ hangTitle: true });

    const start = Date.now();
    const result = await captureStep(page, cdp, ctx(runDir), 2);
    const elapsed = Date.now() - start;

    expect(elapsed).toBeLessThan(8_000);
    expect(result.title).toBe("");
  }, 15_000);
});
