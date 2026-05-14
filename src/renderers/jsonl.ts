/**
 * JSONL renderer for the GauntletEvent stream. One event per line, every event
 * carries a ts. Designed for Claude (or any agent / CI) tailing a file — no
 * ANSI, no spinner, no buffering surprises.
 *
 * Usage:
 *   gauntlet run --events-log /tmp/gauntlet-events.jsonl
 *   tail -f /tmp/gauntlet-events.jsonl | jq -c '.'
 */

import { appendFileSync, openSync, closeSync } from "node:fs";
import type { EventEmitter, GauntletEvent } from "../events.ts";

export interface JsonlRendererOptions {
  /** Absolute path to the JSONL file. Created if missing, appended if exists. */
  path: string;
}

export function createJsonlRenderer(opts: JsonlRendererOptions): EventEmitter {
  // Touch + truncate? No — append. Multiple runs in the same path tail cleanly.
  // We pre-open + close on each write to avoid keeping a handle that survives
  // process death; the per-event syscall cost is dwarfed by AI calls.
  // For very high event rates we could keep an open handle behind a flag, but
  // gauntlet's event volume is modest (~hundreds per run).
  const fd = openSync(opts.path, "a");
  closeSync(fd);
  return (e: GauntletEvent): void => {
    try {
      appendFileSync(opts.path, JSON.stringify(e) + "\n");
    } catch {
      // Don't crash the run if the events log can't be written to. The text
      // renderer will still surface progress to the user.
    }
  };
}
