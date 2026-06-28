/**
 * Legacy single-step runs (browser.ts runPersona) write meta.json under the
 * persona dir but no flow-result.json. Regression guard: RunReport.url (and the
 * REPORT.md "- URL:" line) must be populated from meta.json for that path.
 */
import { describe, expect, test } from "bun:test";
import { mkdtemp, mkdir, writeFile, readFile, rm } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { buildReport } from "./build.ts";

describe("buildReport legacy (no-flows) url", () => {
  test("populates url from meta.json when there is no flow-result.json", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "gauntlet-legacy-url-"));
    const personaDir = join(runDir, "mary");
    await mkdir(personaDir, { recursive: true });
    // Mirrors what browser.ts runPersona writes for the legacy path.
    await writeFile(
      join(personaDir, "meta.json"),
      JSON.stringify({
        persona: "mary",
        url: "https://legacy.test/",
        startedAt: 1000,
        finishedAt: 2000,
        steps: 1,
        failures: 0,
      }),
      "utf8",
    );

    try {
      // vet:false — legacy run has no findings, and the assertion is about url,
      // not the vetting layer (so no browser launch needed).
      const built = await buildReport({ runDir, vet: false });
      expect(built.report.url).toBe("https://legacy.test/");
      expect(built.report.startedAt).toBe(1000);
      expect(built.report.finishedAt).toBe(2000);

      const md = await readFile(built.markdownPath, "utf8");
      expect(md).toContain("- URL: https://legacy.test/");
      expect(md).not.toContain("- URL: \n");
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  test("flow-result url wins over meta.json; window is min/max across both", async () => {
    // inferRunMeta reads meta.json unconditionally per persona (legacy
    // fallback). Lock the merge for the mixed-on-disk case so a regression in
    // the min/max ordering or the url precedence fails loudly:
    //   - url: the flow url is preserved (flows loop sets it before meta read)
    //   - startedAt: min across flow (1000) and meta (5)   -> 5
    //   - finishedAt: max across flow (2000) and meta (9999) -> 9999
    const runDir = await mkdtemp(join(tmpdir(), "gauntlet-merge-meta-"));
    const personaDir = join(runDir, "mary");
    const flowDir = join(personaDir, "browse");
    await mkdir(flowDir, { recursive: true });
    await writeFile(
      join(flowDir, "flow-result.json"),
      JSON.stringify({
        persona: "mary",
        flow: "browse",
        url: "https://flow.test/",
        outcome: "completed",
        steps: [],
        failures: [],
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      }),
      "utf8",
    );
    await writeFile(
      join(personaDir, "meta.json"),
      JSON.stringify({ persona: "mary", startedAt: 5, finishedAt: 9999 }),
      "utf8",
    );

    try {
      const built = await buildReport({ runDir, vet: false });
      expect(built.report.url).toBe("https://flow.test/");
      expect(built.report.startedAt).toBe(5);
      expect(built.report.finishedAt).toBe(9999);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });

  test("malformed meta.json is ignored; flow-derived values survive", async () => {
    const runDir = await mkdtemp(join(tmpdir(), "gauntlet-bad-meta-"));
    const personaDir = join(runDir, "mary");
    const flowDir = join(personaDir, "browse");
    await mkdir(flowDir, { recursive: true });
    await writeFile(
      join(flowDir, "flow-result.json"),
      JSON.stringify({
        persona: "mary",
        flow: "browse",
        url: "https://flow.test/",
        outcome: "completed",
        steps: [],
        failures: [],
        startedAt: 1000,
        finishedAt: 2000,
        durationMs: 1000,
      }),
      "utf8",
    );
    await writeFile(join(personaDir, "meta.json"), "{ not valid json", "utf8");

    try {
      const built = await buildReport({ runDir, vet: false });
      expect(built.report.url).toBe("https://flow.test/");
      expect(built.report.startedAt).toBe(1000);
      expect(built.report.finishedAt).toBe(2000);
    } finally {
      await rm(runDir, { recursive: true, force: true });
    }
  });
});
