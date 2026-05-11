import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { runAxe } from "../runner/axe-scan.ts";
import type { Finding } from "./schema.ts";
import { FailureReason } from "../runner/failure-reasons.ts";

export interface VetResult {
  status: Finding["vetting"]["status"];
  note: string;
  rePassed?: boolean;
}

interface UrlSession {
  context: BrowserContext;
  page: Page;
  url: string;
  consoleErrors: string[];
  saw5xx: boolean;
  axeRuleIds: Set<string>;
  navigatedOk: boolean;
  navError: string | undefined;
}

async function openSession(browser: Browser, url: string, timeoutMs: number): Promise<UrlSession> {
  const context = await browser.newContext();
  const page = await context.newPage();
  const consoleErrors: string[] = [];
  let saw5xx = false;
  page.on("console", (m) => {
    if (m.type() === "error") consoleErrors.push(m.text());
  });
  page.on("response", (r) => {
    if (r.status() >= 500) saw5xx = true;
  });

  let navigatedOk = true;
  let navError: string | undefined;
  try {
    await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
    await page.waitForTimeout(800);
  } catch (err) {
    navigatedOk = false;
    navError = err instanceof Error ? err.message : String(err);
  }

  let axeRuleIds = new Set<string>();
  if (navigatedOk) {
    const axe = await runAxe(page);
    axeRuleIds = new Set(axe.violations.map((v) => v.id));
  }

  return {
    context,
    page,
    url,
    consoleErrors,
    saw5xx,
    axeRuleIds,
    navigatedOk,
    navError,
  };
}

async function closeSession(s: UrlSession): Promise<void> {
  await s.context.close().catch(() => undefined);
}

function vetFromSession(finding: Finding, s: UrlSession): VetResult {
  if (finding.replayStrategy === "none") {
    return { status: "subjective", note: "no replay strategy defined" };
  }
  if (finding.replayStrategy === "flow_replay") {
    return {
      status: "subjective",
      note: "flow_replay vetting not yet implemented; judge-derived finding flagged subjective",
    };
  }
  if (!s.navigatedOk) {
    return { status: "could_not_replay", note: `navigation failed: ${s.navError ?? "unknown"}` };
  }

  if (finding.replayStrategy === "axe_recheck") {
    const expected = finding.axeRuleId;
    if (!expected) return { status: "subjective", note: "axe rule id not on finding" };
    const rePassed = s.axeRuleIds.has(expected);
    return {
      status: rePassed ? "verified" : "regressed",
      note: rePassed
        ? `axe rule "${expected}" present on replay`
        : `axe rule "${expected}" no longer present on replay; finding may be stale`,
      rePassed,
    };
  }

  // navigation_only
  if (finding.reason === FailureReason.HTTP_ERROR && s.saw5xx) {
    return { status: "verified", note: "5xx response observed on replay", rePassed: true };
  }
  if (finding.reason === FailureReason.CONSOLE_ERROR && s.consoleErrors.length > 0) {
    return {
      status: "verified",
      note: `console error(s) on replay: ${s.consoleErrors[0]?.slice(0, 80)}`,
      rePassed: true,
    };
  }
  if (finding.reason === FailureReason.NAVIGATION_TIMEOUT) {
    return {
      status: "subjective",
      note: "page navigated on replay; original timeout may be intermittent",
      rePassed: false,
    };
  }
  return {
    status: "subjective",
    note: "transient condition; cannot deterministically replay",
  };
}

export interface VetOptions {
  headless?: boolean;
  timeoutMs?: number;
}

/**
 * Vet a batch of findings using a SHARED browser. Groups by URL so we only
 * navigate + re-run axe once per distinct URL, then map back to every finding
 * at that URL.
 */
export async function vetAll(findings: Finding[], opts: VetOptions = {}): Promise<Finding[]> {
  if (findings.length === 0) return findings;
  const headless = opts.headless ?? true;
  const timeoutMs = opts.timeoutMs ?? 30_000;

  const browser: Browser = await chromium.launch({ headless });
  const sessions = new Map<string, UrlSession>();
  const out: Finding[] = [];

  try {
    for (const f of findings) {
      if (f.replayStrategy === "none" || f.replayStrategy === "flow_replay") {
        const v = vetFromSession(f, {
          context: null as never,
          page: null as never,
          url: "",
          consoleErrors: [],
          saw5xx: false,
          axeRuleIds: new Set(),
          navigatedOk: true,
          navError: undefined,
        });
        out.push({
          ...f,
          vetting: {
            status: v.status,
            note: v.note,
            ...(v.rePassed !== undefined ? { rePassed: v.rePassed } : {}),
          },
        });
        continue;
      }
      let session = sessions.get(f.url);
      if (!session) {
        session = await openSession(browser, f.url, timeoutMs);
        sessions.set(f.url, session);
      }
      const v = vetFromSession(f, session);
      out.push({
        ...f,
        vetting: {
          status: v.status,
          note: v.note,
          ...(v.rePassed !== undefined ? { rePassed: v.rePassed } : {}),
        },
      });
    }
  } finally {
    for (const s of sessions.values()) await closeSession(s);
    await browser.close().catch(() => undefined);
  }

  return out;
}

// Kept for callers that need single-finding vetting.
export async function vetFinding(opts: { finding: Finding; headless?: boolean; timeoutMs?: number }): Promise<VetResult> {
  const [vetted] = await vetAll([opts.finding], {
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  return {
    status: vetted!.vetting.status,
    note: vetted!.vetting.note ?? "",
    ...(vetted!.vetting.rePassed !== undefined ? { rePassed: vetted!.vetting.rePassed } : {}),
  };
}
