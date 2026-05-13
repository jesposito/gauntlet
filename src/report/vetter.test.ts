import { describe, expect, test } from "bun:test";
import { withVetTimeout } from "./vetter.ts";

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
