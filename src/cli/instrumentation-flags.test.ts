/**
 * Unit tests for the instrumentation flags wired into the long-running CLI
 * commands: --events-log <path> and --no-color. These flags reach
 * cmdRun / cmdInit / cmdFlows / cmdReport / cmdSeed via the generic
 * parseArgs pathway in cli.ts; they don't go through flag-parsers.ts (no
 * numeric validation needed). These tests pin the parser shape so the
 * renderer pipeline gets the exact value/boolean it expects.
 */

import { describe, expect, test } from "bun:test";
import { parseArgs } from "../cli.ts";

describe("--events-log parsing", () => {
  test("captures the path as a string flag", () => {
    const a = parseArgs(["bun", "cli.ts", "run", "--events-log", "/tmp/g.jsonl"]);
    expect(a.command).toBe("run");
    expect(a.flags["events-log"]).toBe("/tmp/g.jsonl");
  });

  test("captures absolute paths with hyphens", () => {
    const a = parseArgs([
      "bun",
      "cli.ts",
      "init",
      "--events-log",
      "/tmp/gauntlet-events-2026-05-13.jsonl",
    ]);
    expect(a.flags["events-log"]).toBe("/tmp/gauntlet-events-2026-05-13.jsonl");
  });

  test("absent when not passed (so buildEmitter skips JSONL renderer)", () => {
    const a = parseArgs(["bun", "cli.ts", "run", "--surface", "marketing"]);
    expect(a.flags["events-log"]).toBeUndefined();
  });

  test("coexists with --no-color and other flags", () => {
    const a = parseArgs([
      "bun",
      "cli.ts",
      "run",
      "--surface",
      "app",
      "--no-color",
      "--events-log",
      "/tmp/x.jsonl",
      "--quiet",
    ]);
    expect(a.flags["events-log"]).toBe("/tmp/x.jsonl");
    expect(a.flags["no-color"]).toBe(true);
    expect(a.flags["quiet"]).toBe(true);
    expect(a.flags["surface"]).toBe("app");
  });
});

describe("--no-color parsing", () => {
  test("is captured as a boolean true", () => {
    const a = parseArgs(["bun", "cli.ts", "report", "--no-color"]);
    expect(a.flags["no-color"]).toBe(true);
  });

  test("absent when not passed (so renderer keeps color on a TTY)", () => {
    const a = parseArgs(["bun", "cli.ts", "report"]);
    expect(a.flags["no-color"]).toBeUndefined();
  });

  test("works on every long-running command", () => {
    for (const cmd of ["run", "init", "flows", "report", "seed"]) {
      const a = parseArgs(["bun", "cli.ts", cmd, "--no-color"]);
      expect(a.command).toBe(cmd);
      expect(a.flags["no-color"]).toBe(true);
    }
  });
});
