import { z } from "zod";
import { FailureReason } from "../runner/failure-reasons.ts";

export const SeveritySchema = z.enum(["critical", "serious", "moderate", "minor"]);
export type Severity = z.infer<typeof SeveritySchema>;

export const VettingStatusSchema = z.enum([
  "unverified",
  "verified",
  "subjective",
  "could_not_replay",
  "regressed",
]);
export type VettingStatus = z.infer<typeof VettingStatusSchema>;

export const ReplayStrategySchema = z.enum([
  "axe_recheck",
  "flow_replay",
  "navigation_only",
  "none",
]);
export type ReplayStrategy = z.infer<typeof ReplayStrategySchema>;

/**
 * Category for persona-abandonment findings. The step judge classifies why
 * the persona gave up so the reporter can separate real defects from
 * confusing-but-present UX, feature gaps that belong in product backlog, and
 * persona-expectation noise that should not be reported as a defect.
 *
 *   bug          — affordance broken or genuinely missing.
 *   confusing_ux — affordance exists on the page but persona couldn't find
 *                  it (collapsed disclosure, ambiguous label, hover-only).
 *                  Real, but polish — not a defect.
 *   feature_gap  — persona's expectation is reasonable; product doesn't have
 *                  the feature. Route to product, not eng.
 *   not_a_bug    — persona expected something the product never claimed
 *                  (wrong terminology, unmet state preconditions, etc).
 *                  Noise — auto-downgraded so it doesn't drown real findings.
 */
export const FindingCategorySchema = z.enum([
  "bug",
  "confusing_ux",
  "feature_gap",
  "not_a_bug",
]);
export type FindingCategory = z.infer<typeof FindingCategorySchema>;

export const FindingSchema = z.object({
  id: z.string(),
  personaId: z.string(),
  flowId: z.string().optional(),
  stepIndex: z.number().int().optional(),
  url: z.string(),
  /**
   * Surface this finding originated from, when the flow was scoped to one.
   * Used by the vetter to load the surface's auth_state so replays of
   * behind-login findings actually hit the authed view, not the login wall.
   */
  surfaceId: z.string().optional(),
  reason: z.nativeEnum(FailureReason),
  severity: SeveritySchema,
  /**
   * Persona-abandonment classification, set only when the step judge fired
   * a give_up verdict. Optional because axe / console / navigation findings
   * don't go through the persona-judge path.
   */
  category: FindingCategorySchema.optional(),
  title: z.string(),
  detail: z.string(),
  axeRuleId: z.string().optional(),
  helpUrl: z.string().optional(),
  artifacts: z.object({
    screenshot: z.string().optional(),
    domHtml: z.string().optional(),
    axTree: z.string().optional(),
    axeJson: z.string().optional(),
    flowResult: z.string().optional(),
    video: z.string().optional(),
  }),
  replayStrategy: ReplayStrategySchema,
  vetting: z.object({
    status: VettingStatusSchema,
    note: z.string().optional(),
    rePassed: z.boolean().optional(),
  }),
});
export type Finding = z.infer<typeof FindingSchema>;

export const PersonaReportSchema = z.object({
  personaId: z.string(),
  personaName: z.string(),
  flows: z.array(
    z.object({
      flowId: z.string(),
      title: z.string(),
      outcome: z.enum(["completed", "abandoned", "patience_exceeded", "timeout", "error"]),
      outcomeReason: z.string().optional(),
      steps: z.number().int(),
      durationMs: z.number().int(),
    }),
  ),
  findings: z.array(FindingSchema),
});
export type PersonaReport = z.infer<typeof PersonaReportSchema>;

export const CrossPersonaPatternSchema = z.object({
  signature: z.string().describe("Stable key for the finding (e.g. axe rule id + url)"),
  title: z.string(),
  count: z.number().int(),
  personas: z.array(z.string()),
  representativeFindingId: z.string(),
});
export type CrossPersonaPattern = z.infer<typeof CrossPersonaPatternSchema>;

export const RunReportSchema = z.object({
  runId: z.string(),
  runDir: z.string(),
  url: z.string(),
  startedAt: z.number(),
  finishedAt: z.number(),
  personas: z.array(PersonaReportSchema),
  patterns: z.array(CrossPersonaPatternSchema),
  totals: z.object({
    findings: z.number().int(),
    verified: z.number().int(),
    subjective: z.number().int(),
    couldNotReplay: z.number().int(),
    regressed: z.number().int(),
    unverified: z.number().int(),
  }),
});
export type RunReport = z.infer<typeof RunReportSchema>;
