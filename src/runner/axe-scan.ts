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

/**
 * Defensive backstop: AxeBuilder.analyze() can hang indefinitely on heavy
 * SPAs that never settle (most often due to a long-running MutationObserver
 * inside axe's own injected runtime). Cap the call so a single bad page
 * can't freeze the runner OR the vetter. The thrown error lands in the
 * existing `catch` below and surfaces as `error` on the result, same as
 * any other axe failure — callers don't need to learn a new shape.
 *
 * --- HONEST CONTRACT (Codex audit 2026-05-14) ---
 * AxeBuilder.analyze() is NOT internally cancelable: axe-core injects a
 * runtime into the page and there's no public API to abort it mid-run.
 * `Promise.race` here unblocks the AWAITER after the timeout, but the
 * injected axe runtime keeps churning inside the page until the page or
 * context is closed. We mitigate by:
 *   1. Calling `page.evaluate(() => window.stop())` on timeout — this
 *      interrupts in-flight network and CAN nudge a stuck axe pass past
 *      a network-bound checkpoint, but is not a guaranteed cancel.
 *   2. The `signal?` parameter lets a caller wire in their own deadline
 *      (e.g. a per-finding wallclock); if the supplied signal aborts
 *      before our internal timer, we surface the abort as the error.
 * The real reaper for a genuinely-hung page is the flow-runner wallclock
 * alarm (`FLOW_WALLCLOCK_BUDGET_MS`) which closes the browser entirely.
 */
const AXE_ANALYZE_TIMEOUT_MS = 30_000;

export async function runAxe(page: Page, signal?: AbortSignal): Promise<AxeScanResult> {
  const ranAt = Date.now();
  const url = page.url();
  try {
    const analyze = new AxeBuilder({ page }).withTags(TAGS).analyze();
    let timer: ReturnType<typeof setTimeout> | undefined;
    let timedOut = false;
    const timeout = new Promise<never>((_, reject) => {
      timer = setTimeout(() => {
        timedOut = true;
        // Best-effort: window.stop() interrupts pending network in the page
        // which can free a network-blocked axe pass. Not a guaranteed cancel.
        page.evaluate(() => window.stop()).catch(() => undefined);
        reject(new Error(`axe analyze timeout: exceeded ${AXE_ANALYZE_TIMEOUT_MS}ms`));
      }, AXE_ANALYZE_TIMEOUT_MS);
    });
    const racers: Promise<unknown>[] = [analyze, timeout];
    if (signal) {
      if (signal.aborted) {
        throw new Error("axe analyze aborted by caller signal");
      }
      racers.push(
        new Promise<never>((_, reject) => {
          signal.addEventListener(
            "abort",
            () => reject(new Error("axe analyze aborted by caller signal")),
            { once: true },
          );
        }),
      );
    }
    const results = (await Promise.race(racers).finally(() => {
      if (timer) clearTimeout(timer);
    })) as Awaited<typeof analyze>;
    void timedOut;
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
