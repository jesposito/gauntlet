import { describe, expect, test } from "bun:test";
import type { Flow } from "./schema.ts";
import { filterFlows } from "./filter.ts";

function makeFlow(over: Partial<Flow> & { id: string; persona_id: string }): Flow {
  return {
    id: over.id,
    persona_id: over.persona_id,
    title: over.title ?? "title",
    goal: over.goal ?? "goal",
    steps: over.steps ?? [
      {
        intent: "do thing",
        success_criteria: "thing done",
        give_up_criteria: [],
      },
    ],
    rationale: over.rationale ?? "because",
    feature: over.feature,
    tags: over.tags ?? [],
    paths: over.paths ?? [],
    starting_url_hint: over.starting_url_hint,
  };
}

describe("filterFlows", () => {
  const flows: Flow[] = [
    makeFlow({
      id: "mary--checkout",
      persona_id: "mary",
      feature: "checkout",
      tags: ["smoke", "critical"],
      paths: ["/checkout/*", "/cart"],
    }),
    makeFlow({
      id: "mary--signup",
      persona_id: "mary",
      feature: "signup",
      tags: ["smoke"],
      paths: ["/signup"],
    }),
    makeFlow({
      id: "bob--search",
      persona_id: "bob",
      feature: "search",
      tags: ["edge"],
      paths: ["/search"],
    }),
    makeFlow({ id: "bob--untagged", persona_id: "bob" }),
  ];

  test("no criteria keeps all", () => {
    const r = filterFlows(flows, {});
    expect(r.kept).toHaveLength(4);
    expect(r.dropped).toHaveLength(0);
  });

  test("--flows by id", () => {
    const r = filterFlows(flows, { flowIds: ["mary--checkout", "bob--search"] });
    expect(r.kept.map((f) => f.id).sort()).toEqual(["bob--search", "mary--checkout"]);
  });

  test("--features matches flow.feature", () => {
    const r = filterFlows(flows, { features: ["checkout", "search"] });
    expect(r.kept.map((f) => f.id).sort()).toEqual(["bob--search", "mary--checkout"]);
  });

  test("--features drops flows with no feature set", () => {
    const r = filterFlows(flows, { features: ["checkout"] });
    expect(r.kept.map((f) => f.id)).toEqual(["mary--checkout"]);
    expect(r.dropped.find((d) => d.flow.id === "bob--untagged")).toBeTruthy();
  });

  test("--tags OR semantics", () => {
    const r = filterFlows(flows, { tags: ["smoke"] });
    expect(r.kept.map((f) => f.id).sort()).toEqual(["mary--checkout", "mary--signup"]);
  });

  test("--exclude-tags removes matches", () => {
    const r = filterFlows(flows, { excludeTags: ["edge"] });
    expect(r.kept.map((f) => f.id).sort()).toEqual([
      "bob--untagged",
      "mary--checkout",
      "mary--signup",
    ]);
  });

  test("--tags + --exclude-tags combine (AND)", () => {
    const r = filterFlows(flows, { tags: ["smoke"], excludeTags: ["critical"] });
    expect(r.kept.map((f) => f.id)).toEqual(["mary--signup"]);
  });

  test("--paths glob match", () => {
    const r = filterFlows(flows, { paths: ["/checkout/confirm"] });
    expect(r.kept.map((f) => f.id)).toEqual(["mary--checkout"]);
  });

  test("--paths exact prefix match without star", () => {
    const r = filterFlows(flows, { paths: ["/signup"] });
    expect(r.kept.map((f) => f.id)).toEqual(["mary--signup"]);
  });

  test("--paths drops flows with no paths set when query provided", () => {
    const r = filterFlows(flows, { paths: ["/anything"] });
    expect(r.kept.find((f) => f.id === "bob--untagged")).toBeUndefined();
  });

  test("filters combine with AND", () => {
    const r = filterFlows(flows, {
      features: ["checkout", "signup"],
      tags: ["smoke"],
      excludeTags: ["critical"],
    });
    expect(r.kept.map((f) => f.id)).toEqual(["mary--signup"]);
  });

  test("dropped entries include reasons", () => {
    const r = filterFlows(flows, { features: ["checkout"] });
    const dropped = r.dropped.find((d) => d.flow.id === "mary--signup");
    expect(dropped?.reasons.some((r) => r.includes("feature"))).toBe(true);
  });
});
