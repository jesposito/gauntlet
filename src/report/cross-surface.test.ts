import { afterEach, describe, expect, mock, test } from "bun:test";
import { mkdtempSync, mkdirSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  buildCrossSurface,
  buildCrossSurfaceReport,
  type SurfaceRun,
} from "./cross-surface.ts";
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

/**
 * Schema-at-disk-boundary regression coverage for codex audit finding #9.
 * Pre-fix, `buildCrossSurfaceReport` JSON.parsed report.json files and cast
 * them to RunReport, so a corrupt artifact silently flowed through and
 * either crashed downstream code with confusing errors or produced wrong
 * rollups. Post-fix the corrupt artifact is logged and skipped, and the
 * good ones still aggregate.
 */
function writeRunReport(dir: string, report: unknown): void {
  mkdirSync(dir, { recursive: true });
  writeFileSync(join(dir, "report.json"), JSON.stringify(report), "utf8");
  // Also drop a flow-result so detectSurfaceForRun finds a surface id.
  const personaDir = join(dir, "persona-x", "flow-y");
  mkdirSync(personaDir, { recursive: true });
  writeFileSync(
    join(personaDir, "flow-result.json"),
    JSON.stringify({
      persona: "persona-x",
      flow: "flow-y",
      url: "https://x.example.com",
      surface: dir.endsWith("good") ? "good-surface" : "bad-surface",
      startedAt: 0,
      finishedAt: 1,
      outcome: "completed",
      steps: [],
      failures: [],
    }),
    "utf8",
  );
}

const validRunReport: RunReport = {
  runId: "r",
  runDir: "/runs/r",
  url: "https://good.example.com",
  startedAt: 0,
  finishedAt: 1,
  personas: [],
  patterns: [],
  totals: {
    findings: 0,
    verified: 0,
    subjective: 0,
    couldNotReplay: 0,
    regressed: 0,
    unverified: 0,
  },
};

describe("buildCrossSurfaceReport - schema validation at disk boundary", () => {
  afterEach(() => {
    mock.restore();
  });

  test("aggregates valid run when sibling run report is corrupt", async () => {
    const cwd = mkdtempSync(join(tmpdir(), "gauntlet-crosssurf-test-"));
    mkdirSync(join(cwd, ".gauntlet"), { recursive: true });
    const goodRun = join(cwd, "runs", "good");
    const badRun = join(cwd, "runs", "bad");
    writeRunReport(goodRun, validRunReport);
    // Corrupt report: missing required fields.
    writeRunReport(badRun, { runId: "bad", but: "no other fields" });

    const warn = mock(() => {});
    console.warn = warn as typeof console.warn;
    const result = await buildCrossSurfaceReport({
      cwd,
      runDirs: [goodRun, badRun],
    });

    // Good run made it into the rollup, bad one was dropped with a warning.
    expect(result.report.surfaces.length).toBe(1);
    expect(result.report.surfaces[0]!.surfaceId).toBe("good-surface");
    expect(warn).toHaveBeenCalled();
    const warnMsg = String((warn.mock.calls[0] ?? [""])[0]);
    expect(warnMsg).toContain("report.json");
  });
});
