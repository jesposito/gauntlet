/**
 * Strict numeric-flag parsers.
 *
 * The CLI used to call `Number(...)` directly on flag values, which silently
 * accepts NaN, Infinity, negatives, decimals, and empty strings. Downstream
 * code then did things like `Math.max(1, NaN)` which is still `NaN` — and a
 * `concurrency=NaN` collapsed the runner pool to nothing. These helpers
 * centralize the validation so a bad flag fails loudly instead of corrupting
 * a run.
 *
 * Both parsers throw `FlagParseError` on bad input; CLI callers catch it,
 * print a clean stderr line, and exit non-zero — no stack traces.
 */

export class FlagParseError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FlagParseError";
  }
}

/**
 * Coerce the raw flag value (which the arg parser may store as `string |
 * boolean | undefined`) into a string we can validate. `true` (bare `--flag`
 * with no value) is treated as a parse error since numeric flags always
 * require a value.
 */
function rawToString(name: string, raw: unknown): string | undefined {
  if (raw === undefined) return undefined;
  if (raw === true) {
    throw new FlagParseError(
      `--${name} requires a value (got bare flag with no argument).`,
    );
  }
  if (typeof raw === "string") {
    const trimmed = raw.trim();
    if (trimmed === "") {
      throw new FlagParseError(`--${name} requires a value (got empty string).`);
    }
    return trimmed;
  }
  throw new FlagParseError(`--${name} has an unexpected value type.`);
}

interface PositiveIntOptions {
  /** Inclusive upper bound. When set, values above this are rejected. */
  max?: number;
}

/**
 * Parse a flag that must be a positive integer (>= 1). When the flag is
 * absent (raw === undefined), returns the default. NaN, Infinity, negatives,
 * zero, decimals, and out-of-range values all throw `FlagParseError`.
 */
export function parsePositiveIntFlag(
  name: string,
  raw: string | boolean | undefined,
  defaultValue: number,
  opts: PositiveIntOptions = {},
): number {
  const str = rawToString(name, raw);
  if (str === undefined) return defaultValue;
  return validatePositiveInt(name, str, opts);
}

/**
 * Parse a flag that's optional but, when present, must be a positive integer
 * within `[min, max]`. Distinct from `parsePositiveIntFlag` because absence
 * is meaningful (e.g. `--limit` unset means "no limit"). Returns `undefined`
 * when the flag is absent.
 */
export function parseOptionalBoundedIntFlag(
  name: string,
  raw: string | boolean | undefined,
  min: number,
  max: number,
): number | undefined {
  const str = rawToString(name, raw);
  if (str === undefined) return undefined;
  if (!Number.isInteger(min) || !Number.isInteger(max) || min < 1 || max < min) {
    throw new Error(
      `internal: parseOptionalBoundedIntFlag bad bounds [${min}, ${max}] for --${name}`,
    );
  }
  const value = validatePositiveInt(name, str, { max });
  if (value < min) {
    throw new FlagParseError(
      `--${name}=${str} is below the minimum (${min}).`,
    );
  }
  return value;
}

function validatePositiveInt(
  name: string,
  str: string,
  opts: PositiveIntOptions,
): number {
  // Reject anything that isn't a clean integer literal. Number() would
  // happily turn "1.5" into 1.5 and "1e10" into 10000000000; we don't
  // want either silently accepted on a flag like --concurrency.
  if (!/^[+-]?\d+$/.test(str)) {
    throw new FlagParseError(
      `--${name}=${str} is not a valid integer (expected a positive whole number).`,
    );
  }
  const n = Number(str);
  if (!Number.isFinite(n)) {
    // /^\d+$/ guards against NaN/Infinity, but be paranoid.
    throw new FlagParseError(`--${name}=${str} is not a finite number.`);
  }
  if (n < 1) {
    throw new FlagParseError(
      `--${name}=${str} must be >= 1 (got ${n}).`,
    );
  }
  if (opts.max !== undefined && n > opts.max) {
    throw new FlagParseError(
      `--${name}=${str} exceeds the maximum (${opts.max}).`,
    );
  }
  return n;
}
