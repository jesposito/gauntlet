import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdir, mkdtemp, rm, writeFile } from "node:fs/promises";
import { tmpdir } from "node:os";
import { join } from "node:path";
import {
  flowsDir,
  formatLoadError,
  listFlows,
  loadFlowsForPersona,
  loadFlowsForPersonaWithDiagnostics,
  writeFlow,
} from "./loader.ts";
import { ZodError } from "zod";
import { FlowSchema } from "./schema.ts";

const VALID_FLOW_YAML = `id: mary--checkout
persona_id: mary
title: Mary checks out
goal: Mary wants to buy the thing.
steps:
  - intent: Mary clicks the cart icon to begin checkout.
    success_criteria: A cart drawer or page appears.
rationale: Tests the primary purchase funnel.
`;

let cwd: string;

beforeEach(async () => {
  cwd = await mkdtemp(join(tmpdir(), "gauntlet-flow-loader-"));
});

afterEach(async () => {
  await rm(cwd, { recursive: true, force: true });
});

describe("listFlows", () => {
  test("missing directory returns empty silently (fresh project)", async () => {
    const ids = await listFlows(cwd);
    expect(ids).toEqual([]);
  });

  test("lists yaml files only", async () => {
    await mkdir(flowsDir(cwd), { recursive: true });
    await writeFile(join(flowsDir(cwd), "a.yaml"), VALID_FLOW_YAML);
    await writeFile(join(flowsDir(cwd), "b.yml"), VALID_FLOW_YAML);
    await writeFile(join(flowsDir(cwd), "README.md"), "ignore me");
    const ids = await listFlows(cwd);
    expect(ids).toEqual(["a", "b"]);
  });
});

describe("loadFlowsForPersonaWithDiagnostics", () => {
  test("missing directory: silent (no flows, no diagnostics)", async () => {
    const result = await loadFlowsForPersonaWithDiagnostics("mary", cwd);
    expect(result.flows).toEqual([]);
    expect(result.diagnostics).toEqual([]);
  });

  test("valid flow loads cleanly", async () => {
    await mkdir(flowsDir(cwd), { recursive: true });
    await writeFile(join(flowsDir(cwd), "mary--checkout.yaml"), VALID_FLOW_YAML);
    const result = await loadFlowsForPersonaWithDiagnostics("mary", cwd);
    expect(result.diagnostics).toEqual([]);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]?.id).toBe("mary--checkout");
  });

  test("broken yaml produces a diagnostic with file path and reason", async () => {
    await mkdir(flowsDir(cwd), { recursive: true });
    const path = join(flowsDir(cwd), "broken.yaml");
    await writeFile(path, "id: broken\n  bad indent: [unterminated");
    const result = await loadFlowsForPersonaWithDiagnostics("mary", cwd);
    expect(result.flows).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d.type).toBe("flow-load-error");
    expect(d.flowId).toBe("broken");
    expect(d.path).toBe(path);
    expect(d.reason.length).toBeGreaterThan(0);
  });

  test("schema-invalid yaml produces a diagnostic naming the bad field", async () => {
    await mkdir(flowsDir(cwd), { recursive: true });
    // Missing required `success_criteria` on the step.
    const bad = `id: mary--bad
persona_id: mary
title: Bad
goal: This will not validate.
steps:
  - intent: do a thing
rationale: r
`;
    const path = join(flowsDir(cwd), "mary--bad.yaml");
    await writeFile(path, bad);
    const result = await loadFlowsForPersonaWithDiagnostics("mary", cwd);
    expect(result.flows).toEqual([]);
    expect(result.diagnostics).toHaveLength(1);
    const d = result.diagnostics[0]!;
    expect(d.flowId).toBe("mary--bad");
    expect(d.reason).toContain("schema validation failed");
    // The Zod path mentions which step + field went wrong.
    expect(d.reason).toContain("success_criteria");
  });

  test("diagnostics do not block valid sibling flows from loading", async () => {
    await mkdir(flowsDir(cwd), { recursive: true });
    await writeFile(join(flowsDir(cwd), "good.yaml"), VALID_FLOW_YAML);
    await writeFile(join(flowsDir(cwd), "broken.yaml"), "::: not yaml :::");
    const result = await loadFlowsForPersonaWithDiagnostics("mary", cwd);
    expect(result.flows).toHaveLength(1);
    expect(result.diagnostics).toHaveLength(1);
  });

  test("legacy loadFlowsForPersona returns just the flows (back-compat)", async () => {
    await mkdir(flowsDir(cwd), { recursive: true });
    await writeFile(join(flowsDir(cwd), "good.yaml"), VALID_FLOW_YAML);
    const flows = await loadFlowsForPersona("mary", cwd);
    expect(flows).toHaveLength(1);
  });
});

describe("formatLoadError", () => {
  test("formats a ZodError with the field path", () => {
    let captured: ZodError | undefined;
    try {
      FlowSchema.parse({ id: "x" });
    } catch (e) {
      if (e instanceof ZodError) captured = e;
    }
    expect(captured).toBeDefined();
    const msg = formatLoadError(captured);
    expect(msg).toContain("schema validation failed");
  });

  test("non-Zod errors fall through to .message", () => {
    expect(formatLoadError(new Error("boom"))).toBe("boom");
  });
});

describe("writeFlow round-trip", () => {
  test("writeFlow creates a file that loads back through the diagnostic loader", async () => {
    const flow = FlowSchema.parse({
      id: "mary--rt",
      persona_id: "mary",
      title: "Round trip",
      goal: "Goes around comes around.",
      steps: [{ intent: "click", success_criteria: "ok" }],
      rationale: "tests round-trip",
    });
    await writeFlow(flow, cwd);
    const result = await loadFlowsForPersonaWithDiagnostics("mary", cwd);
    expect(result.diagnostics).toEqual([]);
    expect(result.flows).toHaveLength(1);
    expect(result.flows[0]?.id).toBe("mary--rt");
  });
});
