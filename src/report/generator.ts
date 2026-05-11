import { readdir, readFile, stat } from "node:fs/promises";
import { join, relative } from "node:path";
import { createHash } from "node:crypto";
import { FailureReason, type FailureEvent } from "../runner/failure-reasons.ts";
import {
  type Finding,
  type PersonaReport,
  type Severity,
  type ReplayStrategy,
} from "./schema.ts";
import { loadPersona } from "../persona/loader.ts";

interface FlowResultFile {
  persona: string;
  flow: string;
  url: string;
  startUrl?: string;
  surface?: string;
  startedAt: number;
  finishedAt: number;
  outcome: "completed" | "abandoned" | "patience_exceeded" | "timeout" | "error";
  outcomeReason?: string;
  steps: Array<{
    stepIndex: number;
    intent: string;
    action?: string;
    performed: boolean;
    verdict: { status: string; give_up_reason?: string; evidence: string };
  }>;
  failures: FailureEvent[];
}

const SEVERITY_BY_REASON: Record<FailureReason, Severity> = {
  [FailureReason.NAVIGATION_TIMEOUT]: "critical",
  [FailureReason.HTTP_ERROR]: "serious",
  [FailureReason.CONSOLE_ERROR]: "moderate",
  [FailureReason.UNCAUGHT_EXCEPTION]: "serious",
  [FailureReason.NETWORK_FAILURE]: "moderate",
  [FailureReason.ACCESSIBILITY_VIOLATION]: "serious",
  [FailureReason.STUCK_NO_PROGRESS]: "serious",
  [FailureReason.ABANDONED_BY_PERSONA]: "serious",
  [FailureReason.GOAL_UNREACHABLE]: "critical",
  [FailureReason.LAYOUT_BROKEN]: "moderate",
  [FailureReason.KEYBOARD_TRAP]: "critical",
  [FailureReason.UNKNOWN]: "minor",
};

const REPLAY_BY_REASON: Record<FailureReason, ReplayStrategy> = {
  [FailureReason.NAVIGATION_TIMEOUT]: "navigation_only",
  [FailureReason.HTTP_ERROR]: "navigation_only",
  [FailureReason.CONSOLE_ERROR]: "navigation_only",
  [FailureReason.UNCAUGHT_EXCEPTION]: "navigation_only",
  [FailureReason.NETWORK_FAILURE]: "navigation_only",
  [FailureReason.ACCESSIBILITY_VIOLATION]: "axe_recheck",
  [FailureReason.STUCK_NO_PROGRESS]: "flow_replay",
  [FailureReason.ABANDONED_BY_PERSONA]: "flow_replay",
  [FailureReason.GOAL_UNREACHABLE]: "flow_replay",
  [FailureReason.LAYOUT_BROKEN]: "navigation_only",
  [FailureReason.KEYBOARD_TRAP]: "flow_replay",
  [FailureReason.UNKNOWN]: "none",
};

function bumpSeverityForAxe(reason: FailureReason, axeImpact: string | undefined): Severity {
  if (reason !== FailureReason.ACCESSIBILITY_VIOLATION) return SEVERITY_BY_REASON[reason];
  if (axeImpact === "critical") return "critical";
  if (axeImpact === "minor") return "minor";
  if (axeImpact === "moderate") return "moderate";
  return "serious";
}

function findingId(personaId: string, flowId: string, idx: number, reason: string, message: string): string {
  return createHash("sha256")
    .update(`${personaId}|${flowId}|${idx}|${reason}|${message}`)
    .digest("hex")
    .slice(0, 12);
}

interface MetaArtifacts {
  screenshotPath?: string;
  domPath?: string;
  axTreePath?: string;
  axeReportPath?: string;
}

async function lookupStepArtifacts(
  flowDir: string,
  stepIndex: number,
): Promise<MetaArtifacts> {
  const stepDir = join(flowDir, "steps", String(stepIndex).padStart(4, "0"));
  try {
    await stat(stepDir);
  } catch {
    return {};
  }
  return {
    screenshotPath: join(stepDir, "screenshot.png"),
    domPath: join(stepDir, "dom.html"),
    axTreePath: join(stepDir, "ax-tree.json"),
    axeReportPath: join(stepDir, "axe.json"),
  };
}

async function findVideoFile(flowDir: string): Promise<string | undefined> {
  const videoDir = join(flowDir, "video");
  try {
    const entries = await readdir(videoDir);
    const f = entries.find((e) => e.endsWith(".webm") || e.endsWith(".mp4"));
    return f ? join(videoDir, f) : undefined;
  } catch {
    return undefined;
  }
}

export async function buildPersonaReport(
  runDir: string,
  personaId: string,
): Promise<PersonaReport> {
  const personaDir = join(runDir, personaId);
  const persona = await loadPersona(personaId).catch(() => undefined);
  const personaName = persona?.character.name ?? personaId;

  const flowDirs: string[] = [];
  try {
    const entries = await readdir(personaDir);
    for (const e of entries) {
      const stPath = join(personaDir, e);
      const st = await stat(stPath).catch(() => undefined);
      if (st?.isDirectory()) flowDirs.push(stPath);
    }
  } catch {
    /* no flow runs */
  }

  const findings: Finding[] = [];
  const flowSummaries: PersonaReport["flows"] = [];

  for (const flowDir of flowDirs) {
    const flowResultPath = join(flowDir, "flow-result.json");
    let result: FlowResultFile;
    try {
      result = JSON.parse(await readFile(flowResultPath, "utf8")) as FlowResultFile;
    } catch {
      continue;
    }
    const flowId = result.flow;
    const videoPath = await findVideoFile(flowDir);
    flowSummaries.push({
      flowId,
      title: flowId,
      outcome: result.outcome,
      ...(result.outcomeReason !== undefined ? { outcomeReason: result.outcomeReason } : {}),
      steps: result.steps.length,
      durationMs: result.finishedAt - result.startedAt,
    });

    const dedupe = new Set<string>();
    // Dedup within a flow (e.g. axe re-running at step 0 and step 1 fires the
    // same rule on the same URL — collapse to one finding for that flow).
    for (const failure of result.failures) {
      const axeId =
        typeof failure.metadata?.axeId === "string"
          ? (failure.metadata.axeId as string)
          : undefined;
      const helpUrl =
        typeof failure.metadata?.helpUrl === "string"
          ? (failure.metadata.helpUrl as string)
          : undefined;
      const axeImpactMatch = failure.message.match(/^axe\[(\w+)\]/);
      const axeImpact = axeImpactMatch?.[1];
      let severity = bumpSeverityForAxe(failure.reason, axeImpact);
      const externalHost =
        typeof failure.metadata?.externalHost === "string"
          ? (failure.metadata.externalHost as string)
          : undefined;
      const isThirdPartyAxe =
        failure.reason === FailureReason.ACCESSIBILITY_VIOLATION &&
        failure.metadata?.thirdParty === true;
      // Downgrade console errors that originate from external hosts (CDNs,
      // fonts, etc) to "minor" — they're real signal but they're a noise
      // floor that drowns out actual product findings.
      if (failure.reason === FailureReason.CONSOLE_ERROR && externalHost) {
        severity = "minor";
      }
      // Downgrade axe findings that live entirely inside third-party iframe
      // content (YouTube, Stripe Elements, etc) — the host site cannot fix
      // DOM it does not own. Confirmed false-positive class from real dogfood.
      if (isThirdPartyAxe) {
        severity = "minor";
      }

      // For axe findings, dedup across steps (same rule + url = same bug).
      // For other failures, key on step to keep distinct occurrences.
      const dedupeKey = axeId
        ? `${failure.reason}|${axeId}|${failure.url}`
        : `${failure.reason}|${failure.url}|${failure.stepIndex}|${failure.message.slice(0, 80)}`;
      if (dedupe.has(dedupeKey)) continue;
      dedupe.add(dedupeKey);

      const stepArt = await lookupStepArtifacts(
        flowDir,
        Math.max(0, failure.stepIndex),
      );
      const id = findingId(personaId, flowId, failure.stepIndex, failure.reason, failure.message);
      const thirdPartySource =
        typeof failure.metadata?.thirdPartySource === "string"
          ? (failure.metadata.thirdPartySource as string)
          : undefined;
      const thirdPartyTag =
        isThirdPartyAxe && thirdPartySource ? ` [${thirdPartySource} embed]` : isThirdPartyAxe ? ` [third-party iframe]` : "";
      const title =
        failure.reason === FailureReason.ACCESSIBILITY_VIOLATION
          ? `${axeId ?? "axe"}: ${failure.message.split(": ").slice(1).join(": ").split(" (")[0]}${thirdPartyTag}`
          : failure.reason === FailureReason.ABANDONED_BY_PERSONA
            ? `Persona abandoned: ${failure.message.split(":").slice(1).join(":").trim().slice(0, 120)}`
            : `${failure.reason}: ${failure.message.slice(0, 80)}`;

      findings.push({
        id,
        personaId,
        flowId,
        ...(failure.stepIndex >= 0 ? { stepIndex: failure.stepIndex } : {}),
        url: failure.url,
        ...(result.surface ? { surfaceId: result.surface } : {}),
        reason: failure.reason,
        severity,
        title,
        detail: failure.message,
        ...(axeId !== undefined ? { axeRuleId: axeId } : {}),
        ...(helpUrl !== undefined ? { helpUrl } : {}),
        artifacts: {
          ...(stepArt.screenshotPath ? { screenshot: relative(runDir, stepArt.screenshotPath) } : {}),
          ...(stepArt.domPath ? { domHtml: relative(runDir, stepArt.domPath) } : {}),
          ...(stepArt.axTreePath ? { axTree: relative(runDir, stepArt.axTreePath) } : {}),
          ...(stepArt.axeReportPath ? { axeJson: relative(runDir, stepArt.axeReportPath) } : {}),
          flowResult: relative(runDir, flowResultPath),
          ...(videoPath ? { video: relative(runDir, videoPath) } : {}),
        },
        replayStrategy: REPLAY_BY_REASON[failure.reason],
        vetting: { status: "unverified" },
      });
    }
  }

  return {
    personaId,
    personaName,
    flows: flowSummaries,
    findings,
  };
}

export async function listPersonasInRun(runDir: string): Promise<string[]> {
  const out: string[] = [];
  try {
    const entries = await readdir(runDir);
    for (const e of entries) {
      const st = await stat(join(runDir, e)).catch(() => undefined);
      if (st?.isDirectory() && !e.startsWith(".")) out.push(e);
    }
  } catch {
    /* empty */
  }
  return out.sort();
}
