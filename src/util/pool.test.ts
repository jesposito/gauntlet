import { describe, expect, test } from "bun:test";
import { runWithConcurrency } from "./pool.ts";

describe("runWithConcurrency", () => {
  test("returns ordered results", async () => {
    const out = await runWithConcurrency([1, 2, 3, 4], 2, async (n) => n * 10);
    expect(out).toEqual([10, 20, 30, 40]);
  });

  test("honors concurrency limit", async () => {
    let inFlight = 0;
    let peak = 0;
    const items = Array.from({ length: 8 }, (_, i) => i);
    await runWithConcurrency(items, 3, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 10));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBeLessThanOrEqual(3);
    expect(peak).toBeGreaterThanOrEqual(2);
  });

  test("concurrency=1 runs serially", async () => {
    let inFlight = 0;
    let peak = 0;
    await runWithConcurrency([1, 2, 3], 1, async (n) => {
      inFlight += 1;
      peak = Math.max(peak, inFlight);
      await new Promise((r) => setTimeout(r, 5));
      inFlight -= 1;
      return n;
    });
    expect(peak).toBe(1);
  });

  test("propagates single error", async () => {
    let threw: Error | undefined;
    try {
      await runWithConcurrency([1, 2, 3], 2, async (n) => {
        if (n === 2) throw new Error("boom");
        return n;
      });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw?.message).toBe("boom");
  });

  test("aggregates multiple errors", async () => {
    let threw: Error | undefined;
    try {
      await runWithConcurrency([1, 2, 3], 3, async (n) => {
        throw new Error(`e${n}`);
      });
    } catch (err) {
      threw = err as Error;
    }
    expect(threw?.message).toContain("3 task(s) failed");
  });

  test("empty input returns empty", async () => {
    const out = await runWithConcurrency<number, number>([], 4, async (n) => n);
    expect(out).toEqual([]);
  });
});
