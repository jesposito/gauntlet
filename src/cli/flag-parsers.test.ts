import { describe, expect, test } from "bun:test";
import {
  FlagParseError,
  parseOptionalBoundedIntFlag,
  parsePositiveIntFlag,
} from "./flag-parsers.ts";

describe("parsePositiveIntFlag", () => {
  test("returns default when raw is undefined", () => {
    expect(parsePositiveIntFlag("steps", undefined, 1)).toBe(1);
  });

  test("parses a valid positive integer string", () => {
    expect(parsePositiveIntFlag("steps", "5", 1)).toBe(5);
  });

  test("trims whitespace", () => {
    expect(parsePositiveIntFlag("steps", "  3  ", 1)).toBe(3);
  });

  test("accepts explicit + sign", () => {
    expect(parsePositiveIntFlag("steps", "+7", 1)).toBe(7);
  });

  test("rejects NaN-producing input", () => {
    expect(() => parsePositiveIntFlag("concurrency", "abc", 2)).toThrow(
      FlagParseError,
    );
  });

  test("rejects negative", () => {
    expect(() => parsePositiveIntFlag("steps", "-1", 1)).toThrow(
      /--steps=-1 must be >= 1/,
    );
  });

  test("rejects zero", () => {
    expect(() => parsePositiveIntFlag("steps", "0", 1)).toThrow(
      /--steps=0 must be >= 1/,
    );
  });

  test("rejects decimal", () => {
    expect(() => parsePositiveIntFlag("steps", "1.5", 1)).toThrow(
      /not a valid integer/,
    );
  });

  test("rejects scientific notation", () => {
    expect(() => parsePositiveIntFlag("steps", "1e3", 1)).toThrow(
      /not a valid integer/,
    );
  });

  test("rejects empty string", () => {
    expect(() => parsePositiveIntFlag("steps", "", 1)).toThrow(
      /requires a value/,
    );
  });

  test("rejects bare boolean flag (no value)", () => {
    expect(() => parsePositiveIntFlag("steps", true, 1)).toThrow(
      /requires a value/,
    );
  });

  test("enforces optional max", () => {
    expect(() => parsePositiveIntFlag("count", "999", 10, { max: 100 })).toThrow(
      /exceeds the maximum \(100\)/,
    );
    expect(parsePositiveIntFlag("count", "100", 10, { max: 100 })).toBe(100);
  });

  test("error messages name the flag", () => {
    try {
      parsePositiveIntFlag("vet-top", "nope", 5);
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(FlagParseError);
      expect((e as Error).message).toContain("--vet-top");
    }
  });
});

describe("parseOptionalBoundedIntFlag", () => {
  test("returns undefined when absent", () => {
    expect(parseOptionalBoundedIntFlag("limit", undefined, 1, 100)).toBeUndefined();
  });

  test("parses valid value within range", () => {
    expect(parseOptionalBoundedIntFlag("limit", "50", 1, 100)).toBe(50);
  });

  test("rejects value below min", () => {
    expect(() => parseOptionalBoundedIntFlag("vet-top", "0", 1, 50)).toThrow(
      /must be >= 1/,
    );
  });

  test("rejects value above max", () => {
    expect(() => parseOptionalBoundedIntFlag("vet-top", "999", 1, 50)).toThrow(
      /exceeds the maximum/,
    );
  });

  test("accepts boundary values", () => {
    expect(parseOptionalBoundedIntFlag("limit", "1", 1, 100)).toBe(1);
    expect(parseOptionalBoundedIntFlag("limit", "100", 1, 100)).toBe(100);
  });

  test("rejects NaN", () => {
    expect(() => parseOptionalBoundedIntFlag("limit", "NaN", 1, 100)).toThrow(
      FlagParseError,
    );
  });
});
