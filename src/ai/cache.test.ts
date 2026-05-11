import { afterAll, describe, expect, test } from "bun:test";
import { rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { AiCache, hashKey } from "./cache.ts";

const cwd = join(tmpdir(), `gauntlet-cache-${Date.now()}-${Math.random().toString(36).slice(2, 8)}`);

afterAll(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("hashKey", () => {
  test("deterministic across runs", () => {
    const k1 = hashKey({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], schemaName: "S" });
    const k2 = hashKey({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], schemaName: "S" });
    expect(k1).toBe(k2);
  });
  test("changes when input changes", () => {
    const a = hashKey({ provider: "p", model: "m", messages: [{ role: "user", content: "hi" }], schemaName: "S" });
    const b = hashKey({ provider: "p", model: "m", messages: [{ role: "user", content: "bye" }], schemaName: "S" });
    expect(a).not.toBe(b);
  });
  test("schemaDescription affects hash", () => {
    const a = hashKey({ provider: "p", model: "m", messages: [], schemaName: "S" });
    const b = hashKey({ provider: "p", model: "m", messages: [], schemaName: "S", schemaDescription: "extra" });
    expect(a).not.toBe(b);
  });
});

describe("AiCache", () => {
  test("disabled returns undefined", async () => {
    const c = new AiCache({ enabled: false, cwd });
    expect(await c.get({ provider: "p", model: "m", messages: [], schemaName: "S" })).toBeUndefined();
    await c.set({ provider: "p", model: "m", messages: [], schemaName: "S" }, { x: 1 });
    expect(await c.get({ provider: "p", model: "m", messages: [], schemaName: "S" })).toBeUndefined();
  });
  test("set then get round-trips", async () => {
    const c = new AiCache({ enabled: true, cwd });
    const inputs = { provider: "p", model: "m", messages: [{ role: "user" as const, content: "x" }], schemaName: "S" };
    await c.set<{ greeting: string }>(inputs, { greeting: "hello" });
    const got = await c.get<{ greeting: string }>(inputs);
    expect(got).toEqual({ greeting: "hello" });
  });
  test("miss returns undefined", async () => {
    const c = new AiCache({ enabled: true, cwd });
    expect(await c.get({ provider: "z", model: "z", messages: [{ role: "user", content: "never-cached" }], schemaName: "Z" })).toBeUndefined();
  });
});
