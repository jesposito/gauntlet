import { chromium, type Browser, type BrowserContext, type Page } from "playwright";
import { runAxe } from "../runner/axe-scan.ts";
import type { Finding } from "./schema.ts";
import { FailureReason } from "../runner/failure-reasons.ts";
import { loadSurface } from "../surface/loader.ts";
import { resolveAuthStatePath } from "../auth/capture.ts";

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

async function openSession(
  browser: Browser,
  url: string,
  timeoutMs: number,
  storageStatePath?: string,
): Promise<UrlSession> {
  const context = await browser.newContext(
    storageStatePath ? { storageState: storageStatePath } : {},
  );
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
  /**
   * cwd used to resolve relative surface auth_state paths. Default = process.cwd().
   * Pass the run's project root when vetting reports built outside the user's cwd.
   */
  cwd?: string;
  /**
   * Per-finding wallclock budget. Mirrors the runner's classifyFlowError
   * pattern: if the per-finding session (open + navigate + axe + map) hangs
   * past this budget, the finding lands `could_not_replay` and the loop
   * continues. Without it a single hung axe call (most likely culprit:
   * `AxeBuilder.analyze()` against a heavy SPA) freezes the entire vetter.
   * Real-world dogfood (audplexus 2026-05-13, third run): vetter hung 20+
   * minutes holding chromium with no progress.
   */
  perFindingBudgetMs?: number;
}

/**
 * Per-finding wallclock for the vetter. Race the work against a setTimeout
 * reject so a hung Playwright op (most often `AxeBuilder.analyze()`) can't
 * stall the whole vetting pass. The promise-rejected path is what callers
 * branch on; the timer is cleared on resolve.
 */
export function withVetTimeout<T>(label: string, p: Promise<T>, ms: number): Promise<T> {
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, reject) => {
    timer = setTimeout(
      () => reject(new Error(`vet timeout: ${label} exceeded ${ms}ms`)),
      ms,
    );
  });
  return Promise.race([p, timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  // Per-finding budget = navigation timeout + axe room + slack. Default
  // 60s so a heavy SPA's axe scan can finish, but never indefinite.
  const perFindingBudgetMs = opts.perFindingBudgetMs ?? 60_000;
  const cwd = opts.cwd ?? process.cwd();

  // Resolve each finding's surface.auth_state once. Surfaces without
  // auth_state (or findings without surfaceId) get undefined and reuse
  // the unauthed session pool.
  const surfaceAuthByid = new Map<string, string | undefined>();
  async function authStateFor(surfaceId: string | undefined): Promise<string | undefined> {
    if (!surfaceId) return undefined;
    if (surfaceAuthByid.has(surfaceId)) return surfaceAuthByid.get(surfaceId);
    try {
      const s = await loadSurface(surfaceId, cwd);
      const abs = resolveAuthStatePath(cwd, s.auth_state);
      surfaceAuthByid.set(surfaceId, abs);
      return abs;
    } catch {
      surfaceAuthByid.set(surfaceId, undefined);
      return undefined;
    }
  }

  const browser: Browser = await chromium.launch({ headless });
  // Key sessions by (url, auth-state-path) so two findings from different
  // surfaces at the same URL don't get cross-contaminated cookies.
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
      try {
        const authState = await authStateFor(f.surfaceId);
        const sessionKey = `${f.url}|${authState ?? ""}`;
        let session = sessions.get(sessionKey);
        if (!session) {
          session = await withVetTimeout(
            `openSession(${f.url})`,
            openSession(browser, f.url, timeoutMs, authState),
            perFindingBudgetMs,
          );
          sessions.set(sessionKey, session);
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
      } catch (err) {
        // Per-finding timeout (or any other openSession failure) — record as
        // could_not_replay and keep going. The session, if partially opened,
        // is leaked here for the duration of this vetAll call; the outer
        // try/finally still reaps the browser at the end. Worth a follow-up
        // if vetter passes ever stretch into thousands of findings.
        const message = err instanceof Error ? err.message : String(err);
        out.push({
          ...f,
          vetting: {
            status: "could_not_replay",
            note: `vetter failure: ${message}`,
          },
        });
      }
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
