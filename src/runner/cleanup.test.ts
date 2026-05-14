import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync, rmSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  deleteRun,
  formatBytes,
  pruneOldRuns,
  reapTmpLeaks,
  summarizeRun,
  trimRunArtifacts,
} from "./cleanup.ts";

describe("formatBytes", () => {
  test("scales unit by magnitude", () => {
    expect(formatBytes(0)).toBe("0 B");
    expect(formatBytes(512)).toBe("512 B");
    expect(formatBytes(2048)).toBe("2.0 KB");
    expect(formatBytes(5 * 1024 * 1024)).toBe("5.0 MB");
    expect(formatBytes(2.5 * 1024 * 1024 * 1024)).toBe("2.50 GB");
  });
});

describe("summarizeRun", () => {
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "gauntlet-clnup-summary-"));
    mkdirSync(join(runDir, "alice/flow1/steps/0000"), { recursive: true });
    writeFileSync(join(runDir, "alice/flow1/flow-result.json"), '{"x":1}');
    writeFileSync(join(runDir, "alice/flow1/steps/0000/dom.html"), "x".repeat(100));
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  test("returns total bytes + file count + report presence", async () => {
    const s = await summarizeRun(runDir);
    expect(s.runDir).toBe(runDir);
    expect(s.bytes).toBeGreaterThan(100);
    expect(s.files).toBe(2);
    expect(s.hasReport).toBe(false);
  });

  test("hasReport=true when REPORT.md exists", async () => {
    writeFileSync(join(runDir, "REPORT.md"), "# x");
    const s = await summarizeRun(runDir);
    expect(s.hasReport).toBe(true);
  });
});

describe("trimRunArtifacts", () => {
  let runDir: string;
  beforeEach(() => {
    runDir = mkdtempSync(join(tmpdir(), "gauntlet-clnup-trim-"));
    const stepDir = join(runDir, "alice/flow1/steps/0000");
    mkdirSync(stepDir, { recursive: true });
    // Heavy: should be deleted.
    writeFileSync(join(stepDir, "dom.html"), "x".repeat(1000));
    writeFileSync(join(stepDir, "ax-tree.json"), "x".repeat(500));
    writeFileSync(join(stepDir, "axe.json"), "x".repeat(300));
    writeFileSync(join(stepDir, "network.jsonl"), "x".repeat(200));
    writeFileSync(join(stepDir, "console.jsonl"), "x".repeat(100));
    writeFileSync(join(runDir, "alice/flow1/video.webm"), "x".repeat(2000));
    // Keep: not in heavy patterns.
    writeFileSync(join(runDir, "alice/flow1/flow-result.json"), '{"x":1}');
    writeFileSync(join(runDir, "REPORT.md"), "# r");
    writeFileSync(join(stepDir, "screenshot.png"), "x".repeat(50));
  });
  afterEach(() => {
    rmSync(runDir, { recursive: true, force: true });
  });

  test("deletes heavy artifacts but keeps report + flow-result + screenshots", async () => {
    const freed = await trimRunArtifacts(runDir);
    expect(freed).toBeGreaterThanOrEqual(1000 + 500 + 300 + 200 + 100 + 2000);
    const stepDir = join(runDir, "alice/flow1/steps/0000");
    expect(existsSync(join(stepDir, "dom.html"))).toBe(false);
    expect(existsSync(join(stepDir, "ax-tree.json"))).toBe(false);
    expect(existsSync(join(stepDir, "axe.json"))).toBe(false);
    expect(existsSync(join(stepDir, "network.jsonl"))).toBe(false);
    expect(existsSync(join(stepDir, "console.jsonl"))).toBe(false);
    expect(existsSync(join(runDir, "alice/flow1/video.webm"))).toBe(false);
    // Kept:
    expect(existsSync(join(runDir, "alice/flow1/flow-result.json"))).toBe(true);
    expect(existsSync(join(runDir, "REPORT.md"))).toBe(true);
    expect(existsSync(join(stepDir, "screenshot.png"))).toBe(true);
  });
});

describe("deleteRun", () => {
  test("refuses paths that don't look like a timestamped run dir", async () => {
    const fakeDir = mkdtempSync(join(tmpdir(), "gauntlet-clnup-safety-"));
    try {
      await expect(deleteRun(fakeDir)).rejects.toThrow(/not a timestamped run dir/);
      // Fake dir still exists.
      expect(existsSync(fakeDir)).toBe(true);
    } finally {
      rmSync(fakeDir, { recursive: true, force: true });
    }
  });

  test("deletes a properly-named run dir", async () => {
    const parent = mkdtempSync(join(tmpdir(), "gauntlet-clnup-del-"));
    const runDir = join(parent, "2026-05-14T04-06-05-496Z");
    mkdirSync(runDir, { recursive: true });
    writeFileSync(join(runDir, "REPORT.md"), "x".repeat(123));
    try {
      const freed = await deleteRun(runDir);
      expect(freed).toBeGreaterThanOrEqual(123);
      expect(existsSync(runDir)).toBe(false);
    } finally {
      rmSync(parent, { recursive: true, force: true });
    }
  });
});

describe("pruneOldRuns", () => {
  let runsDir: string;
  beforeEach(() => {
    runsDir = mkdtempSync(join(tmpdir(), "gauntlet-clnup-prune-"));
    for (const ts of [
      "2026-05-10T00-00-00-000Z",
      "2026-05-11T00-00-00-000Z",
      "2026-05-12T00-00-00-000Z",
      "2026-05-13T00-00-00-000Z",
      "2026-05-14T00-00-00-000Z",
    ]) {
      const d = join(runsDir, ts);
      mkdirSync(d, { recursive: true });
      writeFileSync(join(d, "REPORT.md"), "x");
    }
    // A non-timestamped sibling that must NOT be deleted.
    writeFileSync(join(runsDir, "dogfood-1606.log"), "log");
    mkdirSync(join(runsDir, "not-a-run"), { recursive: true });
  });
  afterEach(() => {
    rmSync(runsDir, { recursive: true, force: true });
  });

  test("keeps latest N runs and deletes older ones", async () => {
    const r = await pruneOldRuns(runsDir, 2);
    expect(r.deleted.sort()).toEqual([
      "2026-05-10T00-00-00-000Z",
      "2026-05-11T00-00-00-000Z",
      "2026-05-12T00-00-00-000Z",
    ]);
    expect(existsSync(join(runsDir, "2026-05-13T00-00-00-000Z"))).toBe(true);
    expect(existsSync(join(runsDir, "2026-05-14T00-00-00-000Z"))).toBe(true);
    // Non-run siblings preserved.
    expect(existsSync(join(runsDir, "dogfood-1606.log"))).toBe(true);
    expect(existsSync(join(runsDir, "not-a-run"))).toBe(true);
  });

  test("keepLatest=0 deletes all run dirs", async () => {
    const r = await pruneOldRuns(runsDir, 0);
    expect(r.deleted.length).toBe(5);
  });

  test("keepLatest >= count is a no-op", async () => {
    const r = await pruneOldRuns(runsDir, 100);
    expect(r.deleted.length).toBe(0);
  });
});

describe("reapTmpLeaks", () => {
  // We can't safely test against real /tmp without risking another run's
  // dirs. Smoke-test: confirm it returns clean shape on a TMPDIR with no
  // matching prefixes.
  test("returns empty when no matching tmpdirs exist", async () => {
    // The real /tmp has system dirs; we just confirm the function doesn't
    // throw and returns the documented shape.
    const r = await reapTmpLeaks(60 * 60 * 1000);
    expect(Array.isArray(r.deleted)).toBe(true);
    expect(typeof r.bytesFreed).toBe("number");
    expect(r.bytesFreed).toBeGreaterThanOrEqual(0);
  });
});
