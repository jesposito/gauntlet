import type { Flow } from "./schema.ts";

export interface FlowFilterCriteria {
  flowIds?: string[];
  features?: string[];
  tags?: string[];
  excludeTags?: string[];
  paths?: string[];
}

function hasAny(needle: string[], haystack: string[]): boolean {
  if (needle.length === 0) return true;
  return needle.some((n) => haystack.includes(n));
}

function pathMatch(pattern: string, target: string): boolean {
  if (pattern === target) return true;
  if (!pattern.includes("*")) return target.startsWith(pattern);
  const re = new RegExp(
    "^" + pattern.replace(/[.+?^${}()|[\]\\]/g, "\\$&").replace(/\*/g, ".*") + "$",
  );
  return re.test(target);
}

function pathsOverlap(flowPaths: string[], queryPaths: string[]): boolean {
  if (queryPaths.length === 0) return true;
  if (flowPaths.length === 0) return false;
  return queryPaths.some((q) => flowPaths.some((fp) => pathMatch(fp, q) || pathMatch(q, fp)));
}

export interface FilterResult {
  kept: Flow[];
  dropped: { flow: Flow; reasons: string[] }[];
}

export function filterFlows(flows: Flow[], criteria: FlowFilterCriteria): FilterResult {
  const flowIds = criteria.flowIds ?? [];
  const features = criteria.features ?? [];
  const tags = criteria.tags ?? [];
  const excludeTags = criteria.excludeTags ?? [];
  const paths = criteria.paths ?? [];

  const kept: Flow[] = [];
  const dropped: { flow: Flow; reasons: string[] }[] = [];

  for (const flow of flows) {
    const reasons: string[] = [];

    if (flowIds.length > 0 && !flowIds.includes(flow.id)) {
      reasons.push(`flow id ${flow.id} not in --flows`);
    }
    if (features.length > 0) {
      if (!flow.feature || !features.includes(flow.feature)) {
        reasons.push(
          `flow.feature=${flow.feature ?? "(unset)"} not in --features [${features.join(", ")}]`,
        );
      }
    }
    if (tags.length > 0 && !hasAny(tags, flow.tags)) {
      reasons.push(
        `flow.tags=[${flow.tags.join(", ")}] has none of --tags [${tags.join(", ")}]`,
      );
    }
    if (excludeTags.length > 0 && hasAny(excludeTags, flow.tags)) {
      reasons.push(
        `flow.tags=[${flow.tags.join(", ")}] intersects --exclude-tags [${excludeTags.join(", ")}]`,
      );
    }
    if (paths.length > 0 && !pathsOverlap(flow.paths, paths)) {
      reasons.push(
        `flow.paths=[${flow.paths.join(", ")}] doesn't overlap --paths [${paths.join(", ")}]`,
      );
    }

    if (reasons.length === 0) kept.push(flow);
    else dropped.push({ flow, reasons });
  }

  return { kept, dropped };
}

export function describeCriteria(c: FlowFilterCriteria): string {
  const parts: string[] = [];
  if (c.flowIds?.length) parts.push(`flows=${c.flowIds.join(",")}`);
  if (c.features?.length) parts.push(`features=${c.features.join(",")}`);
  if (c.tags?.length) parts.push(`tags=${c.tags.join(",")}`);
  if (c.excludeTags?.length) parts.push(`exclude-tags=${c.excludeTags.join(",")}`);
  if (c.paths?.length) parts.push(`paths=${c.paths.join(",")}`);
  return parts.join(" ");
}
