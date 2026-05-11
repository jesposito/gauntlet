import { describe, expect, test } from "bun:test";
import { buildCrossSurface, type SurfaceRun } from "./cross-surface.ts";
import type { RunReport } from "./schema.ts";

function mkRun(surfaceId: string, personaId: string, findings: { reason: string; axeRuleId?: string; title: string }[]): SurfaceRun {
  const report: RunReport = {
    runId: surfaceId,
    runDir: `/runs/${surfaceId}`,
    url: `https://${surfaceId}.example.com`,
    startedAt: 0,
    finishedAt: 0,
    personas: [
      {
        personaId,
        personaName: personaId,
        flows: [],
        findings: findings.map((f, i) => ({
          id: `${surfaceId}-${personaId}-${i}`,
          personaId,
          flowId: "test-flow",
          stepIndex: 0,
          url: `https://${surfaceId}.example.com/`,
          // eslint-disable-next-line @typescript-eslint/no-explicit-any
          reason: f.reason as any,
          severity: "moderate",
          title: f.title,
          detail: f.title,
          axeRuleId: f.axeRuleId,
          artifacts: {},
          replayStrategy: "none",
          vetting: { status: "unverified" },
        })),
      },
    ],
    patterns: [],
    totals: {
      findings: findings.length,
      verified: 0,
      subjective: 0,
      couldNotReplay: 0,
      regressed: 0,
      unverified: findings.length,
    },
  };
  return { surfaceId, runDir: `/runs/${surfaceId}`, report };
}

describe("buildCrossSurface", () => {
  test("identifies signature present on >= 2 surfaces as a pattern", () => {
    const runs = [
      mkRun("marketing", "mary", [
        { reason: "accessibility_violation", axeRuleId: "color-contrast", title: "Color contrast" },
      ]),
      mkRun("admin", "bob", [
        { reason: "accessibility_violation", axeRuleId: "color-contrast", title: "Color contrast" },
      ]),
    ];
    const r = buildCrossSurface(runs);
    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0]!.signature).toBe("axe:color-contrast");
    expect(r.patterns[0]!.surfaces.sort()).toEqual(["admin", "marketing"]);
    expect(r.patterns[0]!.totalCount).toBe(2);
    expect(r.patterns[0]!.personas.sort()).toEqual(["bob", "mary"]);
  });

  test("signatures present on only one surface are surface-unique, not patterns", () => {
    const runs = [
      mkRun("marketing", "mary", [
        { reason: "accessibility_violation", axeRuleId: "color-contrast", title: "Color contrast" },
      ]),
      mkRun("admin", "bob", [
        { reason: "accessibility_violation", axeRuleId: "button-name", title: "Button name" },
      ]),
    ];
    const r = buildCrossSurface(runs);
    expect(r.patterns).toHaveLength(0);
    expect(r.surfaceUnique.find((s) => s.surfaceId === "marketing")?.findings).toBe(1);
    expect(r.surfaceUnique.find((s) => s.surfaceId === "admin")?.findings).toBe(1);
  });

  test("totalCount sums across surfaces, not distinct surface count", () => {
    const runs = [
      mkRun("marketing", "mary", [
        { reason: "console_error", title: "x" },
        { reason: "console_error", title: "x" },
      ]),
      mkRun("admin", "bob", [{ reason: "console_error", title: "x" }]),
    ];
    const r = buildCrossSurface(runs);
    expect(r.patterns).toHaveLength(1);
    expect(r.patterns[0]!.totalCount).toBe(3);
    expect(r.patterns[0]!.surfaces.length).toBe(2);
  });

  test("sorts patterns by surface breadth then total count", () => {
    const runs = [
      mkRun("a", "p1", [
        { reason: "console_error", title: "narrow" },
        { reason: "console_error", title: "narrow" },
        { reason: "console_error", title: "narrow" },
        { reason: "accessibility_violation", axeRuleId: "color-contrast", title: "broad" },
      ]),
      mkRun("b", "p2", [
        { reason: "console_error", title: "narrow" },
        { reason: "accessibility_violation", axeRuleId: "color-contrast", title: "broad" },
      ]),
      mkRun("c", "p3", [
        { reason: "accessibility_violation", axeRuleId: "color-contrast", title: "broad" },
      ]),
    ];
    const r = buildCrossSurface(runs);
    expect(r.patterns[0]!.signature).toBe("axe:color-contrast"); // 3 surfaces beats 4-count narrow
    // Non-axe signatures now include path family + normalized message, so
    // the rolled-up console_error signature starts with the reason name.
    expect(r.patterns[1]!.signature.startsWith("console_error")).toBe(true);
  });

  test("empty runs returns empty report", () => {
    const r = buildCrossSurface([]);
    expect(r.surfaces).toEqual([]);
    expect(r.patterns).toEqual([]);
    expect(r.surfaceUnique).toEqual([]);
    expect(r.totalUniqueSignatures).toBe(0);
  });
});
