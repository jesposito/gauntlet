import { describe, expect, test } from "bun:test";
import { renderPrComment } from "./render.ts";
import type { RunReport, Finding } from "../report/schema.ts";

function mkFinding(over: Partial<Finding> & { id: string; personaId: string }): Finding {
  return {
    id: over.id,
    personaId: over.personaId,
    flowId: over.flowId ?? "test-flow",
    stepIndex: over.stepIndex,
    url: over.url ?? "https://example.com/admin",
    surfaceId: over.surfaceId,
    // eslint-disable-next-line @typescript-eslint/no-explicit-any
    reason: (over.reason ?? "accessibility_violation") as any,
    severity: over.severity ?? "serious",
    title: over.title ?? "Color contrast",
    detail: over.detail ?? "...",
    axeRuleId: over.axeRuleId,
    helpUrl: over.helpUrl,
    artifacts: over.artifacts ?? {},
    replayStrategy: over.replayStrategy ?? "axe_recheck",
    vetting: over.vetting ?? { status: "unverified" },
  };
}

function mkReport(findings: Finding[]): RunReport {
  return {
    runId: "x",
    runDir: "/x",
    url: "https://example.com",
    startedAt: 0,
    finishedAt: 0,
    personas: [
      {
        personaId: "mary",
        personaName: "Mary",
        flows: [
          {
            flowId: "mary--signup",
            title: "Signup",
            outcome: "abandoned",
            steps: 3,
            durationMs: 1000,
          },
        ],
        findings,
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
}

describe("renderPrComment", () => {
  test("zero findings says no findings", () => {
    const out = renderPrComment({ report: mkReport([]) });
    expect(out).toContain("Gauntlet");
    expect(out).toContain("No findings");
  });

  test("orders findings critical > serious > moderate > minor", () => {
    const out = renderPrComment({
      report: mkReport([
        mkFinding({ id: "a", personaId: "mary", severity: "minor", title: "minor thing" }),
        mkFinding({ id: "b", personaId: "mary", severity: "critical", title: "critical thing" }),
        mkFinding({ id: "c", personaId: "mary", severity: "serious", title: "serious thing" }),
      ]),
      maxFindings: 5,
    });
    const idxCritical = out.indexOf("critical thing");
    const idxSerious = out.indexOf("serious thing");
    const idxMinor = out.indexOf("minor thing");
    expect(idxCritical).toBeGreaterThan(-1);
    expect(idxCritical).toBeLessThan(idxSerious);
    expect(idxSerious).toBeLessThan(idxMinor);
  });

  test("highlights persona-abandon findings in a callout", () => {
    const out = renderPrComment({
      report: mkReport([
        // eslint-disable-next-line @typescript-eslint/no-explicit-any
        mkFinding({ id: "x", personaId: "mary", reason: "abandoned_by_persona" as any, severity: "serious", title: "Persona abandoned: couldn't find pricing in nav" }),
      ]),
    });
    expect(out).toContain("Persona quit at:");
    expect(out).toContain("Mary");
    expect(out).toContain("couldn't find pricing");
  });

  test("respects maxFindings cap and notes the overflow", () => {
    const findings: Finding[] = [];
    for (let i = 0; i < 8; i++) {
      findings.push(mkFinding({ id: `f${i}`, personaId: "mary", title: `bug ${i}` }));
    }
    const out = renderPrComment({ report: mkReport(findings), maxFindings: 3 });
    expect(out).toContain("bug 0");
    expect(out).toContain("bug 1");
    expect(out).toContain("bug 2");
    expect(out).not.toContain("bug 7");
    expect(out).toContain("+ 5 more");
  });

  test("links screenshots through artifactBase when supplied", () => {
    const out = renderPrComment({
      report: mkReport([
        mkFinding({
          id: "a",
          personaId: "mary",
          artifacts: { screenshot: "mary/signup/steps/0001/screenshot.png" },
        }),
      ]),
      artifactBase: "https://artifacts.example.com/run-42",
    });
    expect(out).toContain(
      "https://artifacts.example.com/run-42/mary/signup/steps/0001/screenshot.png",
    );
  });

  test("escapes pipes in finding titles so the table doesn't break", () => {
    const out = renderPrComment({
      report: mkReport([
        mkFinding({ id: "a", personaId: "mary", title: "weird | piped | title" }),
      ]),
    });
    expect(out).toContain("weird \\| piped \\| title");
  });
});
