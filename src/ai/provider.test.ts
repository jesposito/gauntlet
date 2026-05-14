import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { z } from "zod";
import type { GauntletEvent } from "../events.ts";
import { nullEmitter } from "../events.ts";
import { configureAiCache } from "./cache.ts";
import {
  type AiProvider,
  type ProposeOptions,
  setGlobalEventEmitter,
} from "./provider.ts";

/**
 * Re-implementing CachingProvider's wrapping behavior would defeat the test;
 * instead we exercise the exported pickProvider() path. But pickProvider()
 * requires a registered factory, and registering one mutates global state.
 * Cleanest path: import the class directly. It's not exported, so we re-derive
 * the wrapping by importing pickProvider from a tiny shim — no, simpler: the
 * CachingProvider is the wrapper installed by pickProvider, so we register a
 * factory whose inner provider is our stub, then call pickProvider() to get
 * the wrapped instance.
 */
import { registerProvider, pickProvider } from "./provider.ts";

class StubProvider implements AiProvider {
  readonly name = "stub";
  readonly model = "stub-model-1";
  calls = 0;
  constructor(private readonly value: unknown) {}
  async propose<T>(opts: ProposeOptions<T>): Promise<T> {
    this.calls += 1;
    return opts.schema.parse(this.value);
  }
}

const Schema = z.object({ ok: z.boolean() });
const value = { ok: true };

const tmpCwd = join(
  tmpdir(),
  `gauntlet-provider-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`,
);

let stub: StubProvider;
let providerId = "stub-test-provider";
let modelTag = "stub-test-model-1";

beforeEach(() => {
  stub = new StubProvider(value);
  // Register a unique factory per test so model prefix matching is isolated.
  modelTag = `stub-test-model-${Date.now()}-${Math.random().toString(36).slice(2, 6)}`;
  registerProvider({
    id: providerId,
    modelPrefixes: [modelTag],
    create: () => stub,
  });
});

afterEach(async () => {
  setGlobalEventEmitter(nullEmitter);
  // Reset cache config to disabled so the next test starts clean.
  configureAiCache({ enabled: false, cwd: tmpCwd });
  await rm(tmpCwd, { recursive: true, force: true });
});

describe("CachingProvider event emission", () => {
  test("emits ai_call_start + ai_call_end with matching callId when purpose set", async () => {
    const events: GauntletEvent[] = [];
    setGlobalEventEmitter((e) => events.push(e));
    configureAiCache({ enabled: false, cwd: tmpCwd });

    const provider = pickProvider(modelTag);
    await provider.propose({
      messages: [{ role: "user", content: "hi" }],
      schema: Schema,
      schemaName: "Test",
      purpose: "judge",
    });

    expect(events).toHaveLength(2);
    const start = events[0]!;
    const end = events[1]!;
    expect(start.type).toBe("ai_call_start");
    expect(end.type).toBe("ai_call_end");
    if (start.type !== "ai_call_start" || end.type !== "ai_call_end") {
      throw new Error("type-narrow guard");
    }
    expect(start.callId).toBe(end.callId);
    expect(start.purpose).toBe("judge");
    expect(start.model).toBe(stub.model);
    expect(end.cached).toBe(false);
    expect(end.durationMs).toBeGreaterThanOrEqual(0);
  });

  test("reports cached: false when inner provider is invoked", async () => {
    const events: GauntletEvent[] = [];
    setGlobalEventEmitter((e) => events.push(e));
    configureAiCache({ enabled: true, cwd: tmpCwd });

    const provider = pickProvider(modelTag);
    await provider.propose({
      messages: [{ role: "user", content: "fresh" }],
      schema: Schema,
      schemaName: "Test",
      purpose: "observe",
    });

    expect(stub.calls).toBe(1);
    const end = events.find((e) => e.type === "ai_call_end");
    expect(end).toBeDefined();
    if (end?.type !== "ai_call_end") throw new Error("type-narrow guard");
    expect(end.cached).toBe(false);
  });

  test("reports cached: true on cache hit", async () => {
    configureAiCache({ enabled: true, cwd: tmpCwd });
    const provider = pickProvider(modelTag);

    // Warm the cache (events emitted but irrelevant for this assertion).
    setGlobalEventEmitter(nullEmitter);
    await provider.propose({
      messages: [{ role: "user", content: "warm" }],
      schema: Schema,
      schemaName: "Test",
      purpose: "act",
    });
    expect(stub.calls).toBe(1);

    // Replay the SAME inputs — this should hit the cache and emit cached: true.
    const events: GauntletEvent[] = [];
    setGlobalEventEmitter((e) => events.push(e));
    await provider.propose({
      messages: [{ role: "user", content: "warm" }],
      schema: Schema,
      schemaName: "Test",
      purpose: "act",
    });

    expect(stub.calls).toBe(1); // inner NOT invoked again
    const end = events.find((e) => e.type === "ai_call_end");
    expect(end).toBeDefined();
    if (end?.type !== "ai_call_end") throw new Error("type-narrow guard");
    expect(end.cached).toBe(true);
  });

  test("emits NO events when purpose is omitted (back-compat)", async () => {
    const events: GauntletEvent[] = [];
    setGlobalEventEmitter((e) => events.push(e));
    configureAiCache({ enabled: false, cwd: tmpCwd });

    const provider = pickProvider(modelTag);
    await provider.propose({
      messages: [{ role: "user", content: "no-tag" }],
      schema: Schema,
      schemaName: "Test",
    });

    expect(events).toHaveLength(0);
  });
});
