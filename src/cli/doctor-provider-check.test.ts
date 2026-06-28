/**
 * The doctor provider liveness check is the feature's whole point: catch a
 * dead/expired key in CI (exit 1) instead of mid-run. cmdDoctor sets
 * process.exitCode from this helper's return, and the import.meta.main
 * entrypoint propagates it via process.exit(process.exitCode ?? 0). These tests
 * pin the exit-code contract for every branch so a refactor that re-hardcodes
 * exit(0) or drops a branch fails here.
 */
import { describe, expect, test } from "bun:test";
import { doctorProviderCheck } from "../cli.ts";
import type { AiProvider } from "../ai/provider.ts";

const fakeProvider: AiProvider = {
  name: "fake",
  model: "fake-model",
  propose: async () => {
    throw new Error("propose should not be called when preflight is injected");
  },
};

describe("doctorProviderCheck", () => {
  test("ok preflight -> exit 0", async () => {
    const code = await doctorProviderCheck("fake-model", false, {
      resolve: () => fakeProvider,
      preflight: async () => ({ ok: true }),
    });
    expect(code).toBe(0);
  });

  test("failed key (preflight ok:false) -> exit 1", async () => {
    const code = await doctorProviderCheck("fake-model", false, {
      resolve: () => fakeProvider,
      preflight: async () => ({ ok: false, error: "anthropic 401: invalid x-api-key" }),
    });
    expect(code).toBe(1);
  });

  test("unresolvable provider (pickProvider throws) -> exit 1, never preflights", async () => {
    let preflighted = false;
    const code = await doctorProviderCheck("nonsense-model", false, {
      resolve: () => {
        throw new Error('no provider for model "nonsense-model"');
      },
      preflight: async () => {
        preflighted = true;
        return { ok: true };
      },
    });
    expect(code).toBe(1);
    expect(preflighted).toBe(false);
  });

  test("--skip-keys short-circuits to exit 0 without touching the provider", async () => {
    let resolved = false;
    const code = await doctorProviderCheck("fake-model", true, {
      resolve: () => {
        resolved = true;
        return fakeProvider;
      },
      preflight: async () => ({ ok: true }),
    });
    expect(code).toBe(0);
    expect(resolved).toBe(false);
  });
});
