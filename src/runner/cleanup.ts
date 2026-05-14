/**
 * Cleanup helpers for gauntlet's filesystem footprint.
 *
 * What gauntlet leaks if you don't clean up:
 *   - .gauntlet/runs/<TS>/ artifacts: 1-10 MB per flow (DOM html, axe json,
 *     ax-tree json, network jsonl, console jsonl, screenshots, video webm
 *     when --record-video). Multiple flows × multiple runs = 100+ MB fast.
 *   - /tmp/gauntlet-browser-test-* and /tmp/playwright_chromiumdev_profile-*
 *     left by failed test/Playwright runs. Each ~1 MB but they accumulate.
 *   - Orphan chromium-headless processes when a flow is killed without
 *     clean shutdown. The supervisor SIGKILLs the process group on
 *     silence-watchdog fire, but if a user Ctrl-Cs gauntlet at the wrong
 *     moment, processes can survive.
 *
 * Each helper is conservative: refuses to delete anything outside the
 * expected paths, never touches user source code or curated yaml under
 * .gauntlet/{personas,surfaces,flows}/, and surfaces what was deleted so
 * the operator can verify.
 */

import { stat, readdir, rm } from "node:fs/promises";
import { join } from "node:path";
import { tmpdir } from "node:os";

export interface RunArtifactSummary {
  runDir: string;
  bytes: number;
  files: number;
  hasReport: boolean;
}

/** Recursively size a directory in bytes + file count. */
async function dirSize(path: string): Promise<{ bytes: number; files: number }> {
  let bytes = 0;
  let files = 0;
  const stack: string[] = [path];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(child);
      } else {
        try {
          const s = await stat(child);
          bytes += s.size;
          files += 1;
        } catch {
          /* race with concurrent delete; ignore */
        }
      }
    }
  }
  return { bytes, files };
}

/** Summarize a single run dir. */
export async function summarizeRun(runDir: string): Promise<RunArtifactSummary> {
  const { bytes, files } = await dirSize(runDir);
  let hasReport = false;
  try {
    await stat(join(runDir, "REPORT.md"));
    hasReport = true;
  } catch {
    /* no report */
  }
  return { runDir, bytes, files, hasReport };
}

/**
 * Trim per-step heavy artifacts (DOM, ax-tree, video, axe) from a run.
 * Keeps: flow-result.json, report.json, REPORT.md, screenshots (small + the
 * single most useful proof of what was on screen).
 *
 * Returns bytes freed.
 */
export async function trimRunArtifacts(runDir: string): Promise<number> {
  // Conservative: only delete files matching known artifact patterns.
  const HEAVY_PATTERNS = [
    /\/dom\.html$/,
    /\/ax-tree\.json$/,
    /\/axe\.json$/,
    /\/network\.jsonl$/,
    /\/console\.jsonl$/,
    /\.webm$/,
  ];
  let freed = 0;
  const stack: string[] = [runDir];
  while (stack.length > 0) {
    const cur = stack.pop()!;
    let entries;
    try {
      entries = await readdir(cur, { withFileTypes: true });
    } catch {
      continue;
    }
    for (const e of entries) {
      const child = join(cur, e.name);
      if (e.isDirectory()) {
        stack.push(child);
      } else if (HEAVY_PATTERNS.some((p) => p.test(child))) {
        try {
          const s = await stat(child);
          await rm(child, { force: true });
          freed += s.size;
        } catch {
          /* ignore */
        }
      }
    }
  }
  return freed;
}

/**
 * Delete a single run dir entirely. Refuses if path doesn't look like a
 * timestamped run dir (paranoid safety against accidental --run argument
 * pointing at the wrong place).
 */
export async function deleteRun(runDir: string): Promise<number> {
  const base = runDir.split("/").filter(Boolean).pop() ?? "";
  // Run dirs are ISO timestamps like 2026-05-14T04-06-05-496Z.
  if (!/^\d{4}-\d{2}-\d{2}T\d{2}-\d{2}-\d{2}-\d{3}Z$/.test(base)) {
    throw new Error(
      `refusing to delete ${runDir}: not a timestamped run dir (safety check)`,
    );
  }
  const { bytes } = await dirSize(runDir);
  await rm(runDir, { recursive: true, force: true });
  return bytes;
}

/**
 * Keep the latest N run dirs under .gauntlet/runs/, delete older ones.
 * Returns array of deleted run dir basenames + total bytes freed.
 */
export async function pruneOldRuns(
  runsDir: string,
  keepLatest: number,
): Promise<{ deleted: string[]; bytesFreed: number }> {
  if (keepLatest < 0) throw new Error(`keepLatest must be >= 0, got ${keepLatest}`);
  let entries;
  try {
    entries = await readdir(runsDir, { withFileTypes: true });
  } catch {
    return { deleted: [], bytesFreed: 0 };
  }
  // Run dirs are ISO timestamps; sort lexicographically = chronologically.
  const runs = entries
    .filter((e) => e.isDirectory())
    .filter((e) => /^\d{4}-\d{2}-\d{2}T/.test(e.name))
    .map((e) => e.name)
    .sort();
  const toDelete = runs.slice(0, Math.max(0, runs.length - keepLatest));
  let bytesFreed = 0;
  const deleted: string[] = [];
  for (const name of toDelete) {
    try {
      bytesFreed += await deleteRun(join(runsDir, name));
      deleted.push(name);
    } catch {
      /* skip on safety-check or fs error */
    }
  }
  return { deleted, bytesFreed };
}

/**
 * Reap leaked Playwright tmpdirs. Targets paths matching
 * /tmp/gauntlet-browser-test-* and /tmp/playwright_chromiumdev_profile-*.
 * Safety: only deletes entries that match the prefix and are older than
 * `minAgeMs` (default 1 hour) to avoid racing live test runs.
 */
export async function reapTmpLeaks(
  minAgeMs = 60 * 60 * 1000,
): Promise<{ deleted: string[]; bytesFreed: number }> {
  const TMP_PREFIXES = [
    "gauntlet-browser-test-",
    "playwright_chromiumdev_profile-",
    "gauntlet-crosssurf-test-",
    "gauntlet-",
  ];
  const TMP = tmpdir();
  let entries;
  try {
    entries = await readdir(TMP, { withFileTypes: true });
  } catch {
    return { deleted: [], bytesFreed: 0 };
  }
  const now = Date.now();
  let bytesFreed = 0;
  const deleted: string[] = [];
  for (const e of entries) {
    if (!e.isDirectory()) continue;
    if (!TMP_PREFIXES.some((p) => e.name.startsWith(p))) continue;
    const path = join(TMP, e.name);
    try {
      const s = await stat(path);
      if (now - s.mtimeMs < minAgeMs) continue; // too fresh, may be live
      const { bytes } = await dirSize(path);
      await rm(path, { recursive: true, force: true });
      bytesFreed += bytes;
      deleted.push(e.name);
    } catch {
      /* skip */
    }
  }
  return { deleted, bytesFreed };
}

/** Format bytes for human display. */
export function formatBytes(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  if (bytes < 1024 * 1024 * 1024) return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
  return `${(bytes / (1024 * 1024 * 1024)).toFixed(2)} GB`;
}
