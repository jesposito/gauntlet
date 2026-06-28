/**
 * End-to-end exit-code contract for the CLI entrypoint. The whole doctor
 * feature (and the latent surfaces/list diagnostics) rests on
 * `process.exit(process.exitCode ?? 0)` actually propagating a non-zero code —
 * the old hard-coded process.exit(0) silently swallowed it. Spawn the real CLI
 * (the only way to exercise import.meta.main) and assert the child's exit code.
 *
 * Cheap + deterministic: doctor's bad-key path fails at pickProvider (no
 * ANTHROPIC_API_KEY -> throws synchronously), so no network call is made.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";

const CLI = fileURLToPath(new URL("../cli.ts", import.meta.url));

async function run(
  argv: string[],
  opts: { cwd: string; env?: Record<string, string | undefined> },
): Promise<{ code: number; stdout: string; stderr: string }> {
  const proc = Bun.spawn([process.execPath, "run", CLI, ...argv], {
    cwd: opts.cwd,
    env: { ...process.env, ...opts.env },
    stdout: "pipe",
    stderr: "pipe",
  });
  const [stdout, stderr] = await Promise.all([
    new Response(proc.stdout).text(),
    new Response(proc.stderr).text(),
  ]);
  const code = await proc.exited;
  return { code, stdout, stderr };
}

describe("CLI exit codes (import.meta.main propagation)", () => {
  test("doctor with no API key -> exit 1 and prints FAILED", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gauntlet-exit-doctor-"));
    try {
      const { code, stdout } = await run(["doctor"], {
        cwd,
        // Strip every provider key so pickProvider(default model) throws.
        env: { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined, GEMINI_API_KEY: undefined, GOOGLE_API_KEY: undefined },
      });
      expect(code).toBe(1);
      expect(stdout).toContain("FAILED");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("doctor --skip-keys -> exit 0 and prints skipped", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gauntlet-exit-skip-"));
    try {
      const { code, stdout } = await run(["doctor", "--skip-keys"], {
        cwd,
        env: { ANTHROPIC_API_KEY: undefined, OPENAI_API_KEY: undefined },
      });
      expect(code).toBe(0);
      expect(stdout).toContain("provider: skipped");
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });

  test("surfaces -> exit 1 on a malformed surface yaml, exit 0 when clean", async () => {
    const cwd = await mkdtemp(join(tmpdir(), "gauntlet-exit-surfaces-"));
    const surfDir = join(cwd, ".gauntlet", "surfaces");
    await mkdir(surfDir, { recursive: true });
    try {
      // Malformed: fails schema/parse -> diagnostic -> exitCode 1.
      await writeFile(join(surfDir, "broken.yaml"), "id: 123\nnot: [valid", "utf8");
      const broken = await run(["surfaces"], { cwd });
      expect(broken.code).toBe(1);

      // Clean roster -> exit 0.
      await rm(join(surfDir, "broken.yaml"));
      await writeFile(
        join(surfDir, "marketing.yaml"),
        "id: marketing\nname: Marketing site\naudience: prospective customers\nbase_url: https://example.com/\n",
        "utf8",
      );
      const clean = await run(["surfaces"], { cwd });
      expect(clean.code).toBe(0);
    } finally {
      await rm(cwd, { recursive: true, force: true });
    }
  });
});
