/**
 * Typed disk reads for report artifacts. Every JSON file written by the
 * runner (flow-result.json, report.json, etc) gets validated with a Zod
 * schema before its fields are touched. This is the boundary where stale,
 * partial, or hand-edited artifacts get caught — bypassing it with
 * `JSON.parse(...) as Foo` makes a corrupt single artifact silently
 * misshape an entire run report (codex audit finding #9).
 *
 * Policy: corrupt single-flow artifact = skip with warning so a report
 * can still ship if 1 of N flows wrote a bad file. Loud warning so the
 * skip is never silent. Callers that prefer hard-fail can use the
 * `*OrThrow` variants directly.
 */
import { readFile } from "node:fs/promises";
import type { ZodSchema } from "zod";
import {
  FlowResultFileSchema,
  RunReportSchema,
  type FlowResultFile,
  type RunReport,
} from "./schema.ts";

function describeError(err: unknown): string {
  if (err instanceof Error) {
    // ZodError.message is already a multi-line JSON dump of the issues.
    // Trim it to one screen so the warning stays scannable in CI logs.
    const msg = err.message;
    return msg.length > 500 ? msg.slice(0, 500) + "…" : msg;
  }
  return String(err);
}

/** Parse JSON-on-disk against a Zod schema. Throws on read or parse error. */
export async function readJsonValidated<T>(
  path: string,
  schema: ZodSchema<T>,
): Promise<T> {
  const raw = await readFile(path, "utf8");
  let parsed: unknown;
  try {
    parsed = JSON.parse(raw);
  } catch (err) {
    throw new Error(
      `[gauntlet] artifact at ${path} is not valid JSON: ${describeError(err)}`,
    );
  }
  const result = schema.safeParse(parsed);
  if (!result.success) {
    throw new Error(
      `[gauntlet] artifact at ${path} did not match schema:\n${result.error.message}`,
    );
  }
  return result.data;
}

/**
 * Read+validate, returning undefined and emitting a console warning on any
 * failure (missing file, bad JSON, schema mismatch). Use when one corrupt
 * artifact among N should not abort the entire report.
 */
export async function readJsonValidatedOrWarn<T>(
  path: string,
  schema: ZodSchema<T>,
  contextLabel: string,
): Promise<T | undefined> {
  try {
    return await readJsonValidated(path, schema);
  } catch (err) {
    // eslint-disable-next-line no-console
    console.warn(
      `[gauntlet] skipping ${contextLabel}: ${describeError(err)}`,
    );
    return undefined;
  }
}

/** Convenience: read a flow-result.json with skip-on-error semantics. */
export function readFlowResultOrWarn(path: string): Promise<FlowResultFile | undefined> {
  return readJsonValidatedOrWarn(path, FlowResultFileSchema, `flow result at ${path}`);
}

/** Convenience: read a report.json with skip-on-error semantics. */
export function readRunReportOrWarn(path: string): Promise<RunReport | undefined> {
  return readJsonValidatedOrWarn(path, RunReportSchema, `run report at ${path}`);
}
