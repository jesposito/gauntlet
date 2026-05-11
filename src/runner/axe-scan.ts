import { AxeBuilder } from "@axe-core/playwright";
import type { Page } from "playwright";
import { classifyAxeViolation } from "./third-party-axe.ts";

export interface AxeViolation {
  id: string;
  impact: "minor" | "moderate" | "serious" | "critical" | null;
  help: string;
  helpUrl: string;
  nodeCount: number;
  sampleTargets: string[];
  /**
   * True when every / a majority of the violating nodes live inside a
   * third-party iframe (YouTube, Stripe Elements, etc) that the host can't
   * fix. Generator downgrades these to severity=minor so they don't drown
   * out fixable findings.
   */
  thirdParty?: boolean;
  /** Best-effort embed-host label (youtube, stripe-elements, iframe, ...). */
  thirdPartySource?: string;
  /** Count of third-party nodes among the violation's nodes. */
  thirdPartyNodeCount?: number;
}

export interface AxeScanResult {
  ranAt: number;
  url: string;
  violations: AxeViolation[];
  passes: number;
  incomplete: number;
  inapplicable: number;
  error?: string;
}

const TAGS = ["wcag2a", "wcag2aa", "wcag21a", "wcag21aa", "wcag22aa", "best-practice"];

export async function runAxe(page: Page): Promise<AxeScanResult> {
  const ranAt = Date.now();
  const url = page.url();
  try {
    const results = await new AxeBuilder({ page }).withTags(TAGS).analyze();
    const violations: AxeViolation[] = results.violations.map((v) => {
      const tp = classifyAxeViolation(
        v.nodes.map((n) => ({
          target: n.target,
          html: n.html,
        })),
      );
      return {
        id: v.id,
        impact: (v.impact as AxeViolation["impact"]) ?? null,
        help: v.help,
        helpUrl: v.helpUrl,
        nodeCount: v.nodes.length,
        sampleTargets: v.nodes
          .slice(0, 3)
          .map((n) =>
            Array.isArray(n.target) ? n.target.join(" ") : String(n.target),
          ),
        ...(tp.thirdPartyMajority ? { thirdParty: true } : {}),
        ...(tp.source ? { thirdPartySource: tp.source } : {}),
        ...(tp.thirdPartyCount > 0 ? { thirdPartyNodeCount: tp.thirdPartyCount } : {}),
      };
    });
    return {
      ranAt,
      url,
      violations,
      passes: results.passes.length,
      incomplete: results.incomplete.length,
      inapplicable: results.inapplicable.length,
    };
  } catch (err) {
    return {
      ranAt,
      url,
      violations: [],
      passes: 0,
      incomplete: 0,
      inapplicable: 0,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

/**
 * Map a persona's `abandons_on` / `avoids` rule (snake_case shorthand) to the
 * matching axe rule id, when one exists. Lets personas reference WCAG ground
 * truth without callers learning axe's vocabulary.
 */
export const PERSONA_RULE_TO_AXE_ID: Record<string, string> = {
  form_field_missing_label: "label",
  unlabeled_icon_buttons: "button-name",
  primary_action_has_no_accessible_name: "button-name",
  color_only_signals: "link-in-text-block",
  duplicate_link_text: "identical-links-same-purpose",
  heading_outline_is_unparseable: "heading-order",
  focus_invisible_for_three_consecutive_stops: "focus-order-semantics",
  keyboard_trap: "no-keyboard-trap",
};

export function matchAxeViolationsToPersonaRules(
  violations: AxeViolation[],
  rules: string[],
): { rule: string; axeId: string; violation: AxeViolation }[] {
  const hits: { rule: string; axeId: string; violation: AxeViolation }[] = [];
  const byId = new Map(violations.map((v) => [v.id, v]));
  for (const rule of rules) {
    const axeId = PERSONA_RULE_TO_AXE_ID[rule];
    if (!axeId) continue;
    const v = byId.get(axeId);
    if (v) hits.push({ rule, axeId, violation: v });
  }
  return hits;
}
