import { afterAll, describe, expect, test } from "bun:test";
import { mkdir, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { resolveAuthStatePath } from "./capture.ts";

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
