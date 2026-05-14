import { describe, expect, test } from "bun:test";
import {
  INIT_AI_TIMEOUT_MS,
  withCancellableTimeout,
} from "./with-cancellable-timeout.ts";

describe("withCancellableTimeout", () => {
  test("resolves through when work completes within budget", async () => {
    const out = await withCancellableTimeout(
      async () => {
        await new Promise((r) => setTimeout(r, 5));
        return "ok";
      },
      1_000,
      "test",
    );
    expect(out).toBe("ok");
  });

  test("rejects with labeled timeout error when work never resolves", async () => {
    let started = 0;
    const startedAt = Date.now();
    // Pure never-resolving builder: no abort handler, so the timeout
    // reject is the only path to settlement. This matches the
    // worst-case the helper exists for — a wedged provider that
    // doesn't honour the abort signal at all.
    await expect(
      withCancellableTimeout(
        (_signal) => {
          started++;
          return new Promise<never>(() => {
            /* never resolves, never rejects */
          });
        },
        50,
        "init AI call test",
      ),
    ).rejects.toThrow(/init AI call test exceeded 50ms/);
    const elapsed = Date.now() - startedAt;
    // Sanity: the race resolved promptly on timeout. 200ms ceiling
    // gives plenty of slack on a slow CI box.
    expect(elapsed).toBeLessThan(200);
    expect(started).toBe(1);
  });

  test("aborts the signal on timeout so the underlying op can stop", async () => {
    let abortedFlag = false;
    await expect(
      withCancellableTimeout(
        (signal) => {
          signal.addEventListener("abort", () => {
            abortedFlag = true;
          });
          return new Promise<never>(() => {
            /* never resolves */
          });
        },
        25,
        "abort-test",
      ),
    ).rejects.toThrow();
    expect(abortedFlag).toBe(true);
  });

  test("clears the timer on successful resolution", async () => {
    // Hard to introspect the timer directly; assert the absence of any
    // unhandled rejection from a late-firing timeout by waiting past the
    // budget after success.
    const out = await withCancellableTimeout(
      async () => "fast",
      30,
      "clear-test",
    );
    expect(out).toBe("fast");
    await new Promise((r) => setTimeout(r, 60));
    // If the timer leaked, the process would have an unhandled rejection
    // by now; bun test surfaces those.
  });

  test("INIT_AI_TIMEOUT_MS default is 120s", () => {
    expect(INIT_AI_TIMEOUT_MS).toBe(120_000);
  });
});
