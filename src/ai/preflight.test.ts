import { describe, expect, test } from "bun:test";
import { preflightProvider } from "./preflight.ts";
import type { AiProvider, ProposeOptions } from "./provider.ts";

function fakeProvider(
  propose: <T>(opts: ProposeOptions<T>) => Promise<T>,
): AiProvider {
  return { name: "fake", model: "fake-model", propose };
}

describe("preflightProvider", () => {
  test("resolves -> { ok: true }", async () => {
    const provider = fakeProvider(async (opts) =>
      opts.schema.parse({ ok: true }),
    );
    const res = await preflightProvider(provider);
    expect(res).toEqual({ ok: true });
  });

  test("rejected propose (401) -> ok:false, error mentions 401", async () => {
    const provider = fakeProvider(async () => {
      throw new Error("anthropic 401: invalid x-api-key");
    });
    const res = await preflightProvider(provider);
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error).toContain("401");
  });

  test("hanging propose -> times out -> ok:false", async () => {
    let aborted = false;
    const provider = fakeProvider(
      (opts) =>
        new Promise((_, reject) => {
          // Honor the abort so the hung op actually stops (no leaked timer).
          opts.signal?.addEventListener("abort", () => {
            aborted = true;
            reject(new Error("aborted"));
          });
        }),
    );
    const res = await preflightProvider(provider, { timeoutMs: 20 });
    expect(res.ok).toBe(false);
    // The op was cancelled, not run to completion — that's the whole point.
    expect(aborted).toBe(true);
  });

  test("propose that ignores abort still times out -> ok:false w/ timeout msg", async () => {
    // Real production hang: a fetch black hole that never settles and never
    // observes the signal. The timeout itself must reject the race.
    const provider = fakeProvider(() => new Promise(() => {}));
    const res = await preflightProvider(provider, { timeoutMs: 20 });
    expect(res.ok).toBe(false);
    if (!res.ok) expect(res.error.toLowerCase()).toContain("exceeded");
  });

  test("never throws on a non-Error rejection", async () => {
    const provider = fakeProvider(async () => {
      throw "string failure";
    });
    const res = await preflightProvider(provider);
    expect(res).toEqual({ ok: false, error: "string failure" });
  });

  test("caller-supplied signal reaches the inner propose (combineSignals)", async () => {
    // The opts.signal forwarding path was untested: every other test omits it,
    // so combineSignals' caller-merge branch never ran. Abort the caller while
    // the provider hangs honoring its signal; the abort must reach propose.
    const ctrl = new AbortController();
    let sawAbort = false;
    const provider = fakeProvider(
      (opts) =>
        new Promise((_, reject) => {
          opts.signal?.addEventListener("abort", () => {
            sawAbort = true;
            reject(new Error("aborted by caller"));
          });
        }),
    );
    // Long timeout so the TIMEOUT can't be what ends the call — only the caller.
    const p = preflightProvider(provider, { signal: ctrl.signal, timeoutMs: 10_000 });
    ctrl.abort();
    const res = await p;
    expect(res.ok).toBe(false);
    expect(sawAbort).toBe(true);
  });

  test("already-aborted caller signal -> ok:false (short-circuit)", async () => {
    // Mirror real fetch: an already-aborted signal rejects immediately rather
    // than waiting for an 'abort' event that already fired.
    const provider = fakeProvider(
      (opts) =>
        new Promise((_, reject) => {
          if (opts.signal?.aborted) {
            reject(new Error("aborted"));
            return;
          }
          opts.signal?.addEventListener("abort", () => reject(new Error("aborted")));
        }),
    );
    const res = await preflightProvider(provider, {
      signal: AbortSignal.abort(),
      timeoutMs: 10_000,
    });
    expect(res.ok).toBe(false);
  });
});
