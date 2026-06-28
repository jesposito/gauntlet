/**
 * --vet-timeout flag parsing.
 *
 * parseVetTimeout is the warn-and-ignore wrapper that turns the raw flag value
 * into vetAll's perFindingBudgetMs. Unlike most numeric flags (which throw
 * FlagParseError and abort), a bad --vet-timeout must NOT kill the report — it
 * warns through the event stream and falls back to the vetter's own default.
 */
import { describe, expect, test } from "bun:test";
import { parseArgs, parseVetTimeout } from "../cli.ts";
import type { GauntletEvent } from "../events.ts";

describe("parseVetTimeout", () => {
  test("absent flag -> undefined (vetAll uses its built-in default), no warn", () => {
    const events: GauntletEvent[] = [];
    expect(parseVetTimeout(undefined, (e) => events.push(e))).toBeUndefined();
    expect(events).toHaveLength(0);
  });

  test("valid positive integer -> that number", () => {
    const events: GauntletEvent[] = [];
    expect(parseVetTimeout("90000", (e) => events.push(e))).toBe(90000);
    expect(events).toHaveLength(0);
  });

  test.each([["0"], ["-5"], ["1.5"], ["abc"], [true]] as const)(
    "invalid value %p -> undefined + a single warn event",
    (raw) => {
      const events: GauntletEvent[] = [];
      expect(parseVetTimeout(raw, (e) => events.push(e))).toBeUndefined();
      const warns = events.filter((e) => e.type === "warn");
      expect(warns).toHaveLength(1);
      expect(
        (warns[0] as Extract<GauntletEvent, { type: "warn" }>).message,
      ).toMatch(/vet-timeout/);
    },
  );

  test("parseArgs captures --vet-timeout as a string value (not a bare bool)", () => {
    const a = parseArgs(["bun", "cli.ts", "report", "--vet-timeout", "5000"]);
    expect(a.flags["vet-timeout"]).toBe("5000");
    expect(parseVetTimeout(a.flags["vet-timeout"], () => {})).toBe(5000);
  });
});
