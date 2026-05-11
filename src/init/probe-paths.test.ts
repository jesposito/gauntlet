import { describe, expect, test } from "bun:test";
import { planProbeCandidates, originOf, DEFAULT_PROBE_PATHS } from "./probe-paths.ts";

describe("originOf", () => {
  test("extracts origin from URL", () => {
    expect(originOf("https://app.example.com/admin/login")).toBe("https://app.example.com");
  });
  test("returns undefined for malformed URLs", () => {
    expect(originOf("not a url")).toBeUndefined();
  });
});

describe("planProbeCandidates", () => {
  test("expands every origin against every probe path", () => {
    const candidates = planProbeCandidates(["https://example.com/"]);
    expect(candidates).toContain("https://example.com/admin");
    expect(candidates).toContain("https://example.com/admin/login");
    expect(candidates).toContain("https://example.com/pricing");
    expect(candidates.length).toBe(DEFAULT_PROBE_PATHS.length);
  });

  test("skips paths the user already covered", () => {
    const candidates = planProbeCandidates([
      "https://example.com/",
      "https://example.com/admin/login",
    ]);
    expect(candidates).not.toContain("https://example.com/admin/login");
    expect(candidates).toContain("https://example.com/admin");
  });

  test("handles multiple origins independently", () => {
    const candidates = planProbeCandidates([
      "https://marketing.example.com",
      "https://app.example.com",
    ]);
    expect(candidates).toContain("https://marketing.example.com/admin");
    expect(candidates).toContain("https://app.example.com/admin");
  });

  test("normalises trailing slashes when comparing", () => {
    const candidates = planProbeCandidates(["https://example.com/admin/"]);
    expect(candidates).not.toContain("https://example.com/admin");
  });

  test("respects custom path list", () => {
    const candidates = planProbeCandidates(["https://example.com"], ["/api/health"]);
    expect(candidates).toEqual(["https://example.com/api/health"]);
  });

  test("returns empty for empty input", () => {
    expect(planProbeCandidates([])).toEqual([]);
  });
});
