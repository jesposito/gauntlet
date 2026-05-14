import { describe, expect, test } from "bun:test";
import { raceWithTimeout, withVetTimeout } from "./vetter.ts";

describe("withVetTimeout", () => {
  // Real-world dogfood (audplexus 2026-05-13): the vetter hung 20+ minutes
  // holding chromium because AxeBuilder.analyze() never resolved. Without a
  // per-finding wallclock, one bad page freezes the entire vetting pass.
  test("resolves with the underlying value when work completes in time", async () => {
    const work = Promise.resolve("ok");
    const result = await withVetTimeout("fast", work, 1_000);
    expect(result).toBe("ok");
  });

  test("rejects with a labeled timeout when work exceeds the budget", async () => {
    const slow = new Promise<string>((resolve) =>
      setTimeout(() => resolve("too late"), 200),
    );
    await expect(withVetTimeout("axe-replay", slow, 25)).rejects.toThrow(
      /vet timeout: axe-replay exceeded 25ms/,
    );
  });

  test("propagates underlying rejection without conflating with timeout", async () => {
    const failing = Promise.reject(new Error("network down"));
    await expect(withVetTimeout("openSession", failing, 1_000)).rejects.toThrow(
      "network down",
    );
  });
});

describe("raceWithTimeout (close-side, swallow-on-timeout)", () => {
  // Real-world dogfood (audplexus 2026-05-14): vetter hung 25+ minutes in
  // closeSession after axe work was complete and chromium had already exited.
  // The close paths must not throw or block the outer finally — a leaked OS
  // handle is preferable to a frozen process the user can't tell anything
  // about.
  test("resolves cleanly when underlying close succeeds in time", async () => {
    let captured: string | undefined;
    const orig = console.warn;
    console.warn = (msg: string) => {
      captured = msg;
    };
    try {
      await raceWithTimeout("ok-close", Promise.resolve(), 1_000);
      expect(captured).toBeUndefined();
    } finally {
      console.warn = orig;
    }
  });

  test("warns and resolves (never rejects) when underlying close exceeds budget", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const stuck = new Promise<void>(() => {
        /* never resolves */
      });
      await raceWithTimeout("stuck-close", stuck, 25);
      expect(warnings.some((w) => /stuck-close did not complete within 25ms/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });

  test("warns and resolves when underlying close throws", async () => {
    const warnings: string[] = [];
    const orig = console.warn;
    console.warn = (msg: string) => {
      warnings.push(msg);
    };
    try {
      const failing = Promise.reject(new Error("orphan context"));
      await raceWithTimeout("error-close", failing, 1_000);
      expect(warnings.some((w) => /error-close threw during close: orphan context/.test(w))).toBe(true);
    } finally {
      console.warn = orig;
    }
  });
});
