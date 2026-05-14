import { chromium, type Browser, type BrowserContext, type LaunchOptions, type Page } from "playwright";
import { runAxe as runAxeReal } from "../runner/axe-scan.ts";
import type { Finding } from "./schema.ts";
import { FailureReason } from "../runner/failure-reasons.ts";
import { loadSurface } from "../surface/loader.ts";
import { resolveAuthStatePath } from "../auth/capture.ts";
import { nullEmitter, type EventEmitter } from "../events.ts";

/**
 * Test seam, mirrors src/runner/browser.ts. Production uses real chromium;
 * tests inject a fake launcher + fake axe scanner so vetAll can be exercised
 * end-to-end without spawning a real browser. See vetter.test.ts.
 */
export interface BrowserLauncher {
  launch(opts: LaunchOptions): Promise<Browser>;
}
let _launcher: BrowserLauncher = chromium;
export function _setBrowserLauncherForTesting(l: BrowserLauncher | undefined): void {
  _launcher = l ?? chromium;
}
type AxeFn = (page: Page) => Promise<{ violations: { id: string }[] }>;
let _runAxe: AxeFn = runAxeReal as unknown as AxeFn;
export function _setAxeRunnerForTesting(fn: AxeFn | undefined): void {
  _runAxe = fn ?? (runAxeReal as unknown as AxeFn);
}

/**
 * The vetter never produces `"unverified"` — that status only exists for
 * findings the report knows about but hasn't run through vetAll. Narrowing
 * the union here lets the event-emit sites pass `v.status` straight to a
 * VetStatus-typed event without a cast.
 */
export interface VetResult {
  status: Exclude<Finding["vetting"]["status"], "unverified">;
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
  storageStatePath: string | undefined,
  emit: EventEmitter,
): Promise<UrlSession> {
  // Track the partially-opened context so any throw between newContext and
  // the final return releases it. Without this, an axe failure (or any
  // post-newContext throw) would leak the BrowserContext until vetAll's
  // shared browser.close() reaped it at the end — pre-fix the per-finding
  // catch in vetAll only saw the error and never the orphan context.
  let context: BrowserContext | undefined;
  try {
    context = await browser.newContext(
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
    const navStart = Date.now();
    try {
      await page.goto(url, { waitUntil: "domcontentloaded", timeout: timeoutMs });
      await page.waitForTimeout(800);
    } catch (err) {
      navigatedOk = false;
      navError = err instanceof Error ? err.message : String(err);
    }
    emit({
      type: "vet_url_navigate",
      url,
      durationMs: Date.now() - navStart,
      ok: navigatedOk,
      ts: Date.now(),
    });

    let axeRuleIds = new Set<string>();
    if (navigatedOk) {
      emit({ type: "vet_url_axe_start", url, ts: Date.now() });
      const axeStart = Date.now();
      // Heartbeat every 5s during axe so non-TTY consumers (Claude tailing
      // JSONL, CI logs) see explicit "still alive" signals during slow scans.
      // unref() so the timer never keeps the loop alive on its own.
      const heartbeat = setInterval(() => {
        emit({
          type: "heartbeat",
          phase: "vet",
          label: `axe scan ${url}`,
          elapsedMs: Date.now() - axeStart,
          ts: Date.now(),
        });
      }, 5_000);
      if (typeof heartbeat.unref === "function") heartbeat.unref();
      let violationCount = 0;
      try {
        const axe = await _runAxe(page);
        axeRuleIds = new Set(axe.violations.map((v) => v.id));
        violationCount = axe.violations.length;
      } finally {
        clearInterval(heartbeat);
        emit({
          type: "vet_url_axe_end",
          url,
          violationCount,
          durationMs: Date.now() - axeStart,
          ts: Date.now(),
        });
      }
    }

    const session: UrlSession = {
      context,
      page,
      url,
      consoleErrors,
      saw5xx,
      axeRuleIds,
      navigatedOk,
      navError,
    };
    // Hand ownership of `context` to the returned session — clear local ref
    // so the catch below doesn't release a context the caller now owns.
    context = undefined;
    return session;
  } catch (err) {
    if (context) {
      // Best-effort release of the partial context. Never throw — the outer
      // catch is already handling a primary failure (timeout / axe blow-up /
      // newPage error). A leaked OS handle is preferable to masking the real
      // error with a close-time exception.
      await raceWithTimeout(
        `openSession.cleanup(${url})`,
        context.close(),
        CLOSE_TIMEOUT_MS,
        emit,
      );
    }
    throw err;
  }
}

/**
 * Bounded close, mirrors the discipline in src/runner/browser.ts. Without this
 * an orphaned BrowserContext (e.g. parent chromium already terminated due to
 * timeout / crash) can leave `context.close()` awaiting a Promise that never
 * resolves, freezing the entire vet pass after axe work is complete. Real-world
 * dogfood (audplexus 2026-05-14): 23-finding vetter hung 25+ minutes in
 * post-vetAll close. We'd rather leak the OS handle than block forever.
 */
const CLOSE_TIMEOUT_MS = 8_000;
async function closeSession(s: UrlSession, emit: EventEmitter): Promise<void> {
  await raceWithTimeout(`closeSession(${s.url})`, s.context.close(), CLOSE_TIMEOUT_MS, emit);
  emit({ type: "vet_url_close", url: s.url, ts: Date.now() });
}

async function closeBrowserBounded(browser: Browser, emit: EventEmitter): Promise<void> {
  await raceWithTimeout("browser.close", browser.close(), CLOSE_TIMEOUT_MS, emit);
}

/**
 * Same shape as withVetTimeout below but swallow-on-timeout: close paths must
 * not throw because the outer finally is still trying to release the next
 * resource. A timed-out close is logged and we continue.
 *
 * When `emit` is the nullEmitter (default — no event stream wired) we keep
 * the legacy console.warn output so existing callers and ad-hoc invocations
 * still surface the warning. When a real emitter is wired we route through
 * the event stream instead so the renderers own all user-facing output.
 */
export function raceWithTimeout(
  label: string,
  p: Promise<void>,
  ms: number,
  emit: EventEmitter = nullEmitter,
): Promise<void> {
  const usingEmitter = emit !== nullEmitter;
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<void>((resolve) => {
    timer = setTimeout(() => {
      const message = `${label} did not complete within ${ms}ms; continuing.`;
      if (usingEmitter) emit({ type: "warn", message, context: "close", ts: Date.now() });
      else console.warn(`[gauntlet] ${message}`);
      resolve();
    }, ms);
  });
  return Promise.race([
    p.catch((err) => {
      const detail = err instanceof Error ? err.message : String(err);
      const message = `${label} threw during close: ${detail}`;
      if (usingEmitter) emit({ type: "warn", message, context: "close", ts: Date.now() });
      else console.warn(`[gauntlet] ${message}`);
    }),
    timeout,
  ]).finally(() => {
    if (timer) clearTimeout(timer);
  });
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
  /**
   * Optional event emitter for narrating vetter progress in real time.
   * Defaults to nullEmitter (silent). Wire the CLI's renderer-multiplex
   * emitter here to surface per-URL navigate/axe boundaries, per-finding
   * verdicts, and 5-second heartbeats during slow axe scans.
   */
  emit?: EventEmitter;
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
  const emit = opts.emit ?? nullEmitter;
  const vetStart = Date.now();

  // Pre-group: count findings sharing each (url, surfaceId) key so the
  // first vet_url_start we emit for a session can carry the total findings
  // that will be served by it. Distinct sessionTotal is the unique-key count.
  const findingsPerKey = new Map<string, number>();
  for (const f of findings) {
    if (f.replayStrategy === "none" || f.replayStrategy === "flow_replay") continue;
    const key = `${f.url}|${f.surfaceId ?? ""}`;
    findingsPerKey.set(key, (findingsPerKey.get(key) ?? 0) + 1);
  }
  const sessionTotal = findingsPerKey.size;
  let sessionIndex = 0;

  emit({
    type: "vet_start",
    total: findings.length,
    distinctUrls: sessionTotal,
    ts: Date.now(),
  });

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

  const browser: Browser = await _launcher.launch({ headless });
  // Key sessions by (url, auth-state-path) so two findings from different
  // surfaces at the same URL don't get cross-contaminated cookies.
  const sessions = new Map<string, UrlSession>();
  // Map sessionKey -> remaining findings count, so vet_url_start can report
  // how many findings will be served by this session even though we group
  // by (url, auth-state) which is a superset key of (url, surfaceId).
  const out: Finding[] = [];
  let findingIndex = 0;

  try {
    for (const f of findings) {
      findingIndex += 1;
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
        emit({
          type: "vet_finding",
          findingIndex,
          total: findings.length,
          findingId: f.id,
          status: v.status,
          ...(f.axeRuleId ? { ruleId: f.axeRuleId } : {}),
          ts: Date.now(),
        });
        continue;
      }
      try {
        const authState = await authStateFor(f.surfaceId);
        const sessionKey = `${f.url}|${authState ?? ""}`;
        let session = sessions.get(sessionKey);
        if (!session) {
          sessionIndex += 1;
          // findingCount: count of findings sharing this URL (independent of
          // auth-state — close enough for a progress signal). Falls back to
          // the per-key tally we computed above when the surfaceId is unset.
          const fc = findingsPerKey.get(`${f.url}|${f.surfaceId ?? ""}`) ?? 1;
          emit({
            type: "vet_url_start",
            url: f.url,
            findingCount: fc,
            sessionIndex,
            sessionTotal,
            ts: Date.now(),
          });
          session = await withVetTimeout(
            `openSession(${f.url})`,
            openSession(browser, f.url, timeoutMs, authState, emit),
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
        emit({
          type: "vet_finding",
          findingIndex,
          total: findings.length,
          findingId: f.id,
          status: v.status,
          ...(f.axeRuleId ? { ruleId: f.axeRuleId } : {}),
          ts: Date.now(),
        });
      } catch (err) {
        // Per-finding timeout (or any other openSession failure) — record as
        // could_not_replay and keep going. The session, if partially opened,
        // is leaked here for the duration of this vetAll call; the outer
        // try/finally still reaps the browser at the end. Worth a follow-up
        // if vetter passes ever stretch into thousands of findings.
        const message = err instanceof Error ? err.message : String(err);
        emit({
          type: "warn",
          message: `vetter failure on ${f.url}: ${message}`,
          context: f.id,
          ts: Date.now(),
        });
        out.push({
          ...f,
          vetting: {
            status: "could_not_replay",
            note: `vetter failure: ${message}`,
          },
        });
        emit({
          type: "vet_finding",
          findingIndex,
          total: findings.length,
          findingId: f.id,
          status: "could_not_replay",
          ...(f.axeRuleId ? { ruleId: f.axeRuleId } : {}),
          ts: Date.now(),
        });
      }
    }
  } finally {
    for (const s of sessions.values()) await closeSession(s, emit);
    await closeBrowserBounded(browser, emit);
  }

  let verified = 0;
  let regressed = 0;
  let subjective = 0;
  let couldNotReplay = 0;
  for (const f of out) {
    switch (f.vetting.status) {
      case "verified":
        verified += 1;
        break;
      case "regressed":
        regressed += 1;
        break;
      case "subjective":
        subjective += 1;
        break;
      case "could_not_replay":
        couldNotReplay += 1;
        break;
    }
  }
  emit({
    type: "vet_end",
    verified,
    regressed,
    subjective,
    couldNotReplay,
    durationMs: Date.now() - vetStart,
    ts: Date.now(),
  });

  return out;
}

// Kept for callers that need single-finding vetting.
export async function vetFinding(opts: { finding: Finding; headless?: boolean; timeoutMs?: number }): Promise<VetResult> {
  const [vetted] = await vetAll([opts.finding], {
    ...(opts.headless !== undefined ? { headless: opts.headless } : {}),
    ...(opts.timeoutMs !== undefined ? { timeoutMs: opts.timeoutMs } : {}),
  });
  // vetAll never assigns "unverified" — that status only appears on findings
  // that were never run through the vetter. Cast to the narrowed VetResult
  // status to keep the public type honest.
  const status = vetted!.vetting.status as VetResult["status"];
  return {
    status,
    note: vetted!.vetting.note ?? "",
    ...(vetted!.vetting.rePassed !== undefined ? { rePassed: vetted!.vetting.rePassed } : {}),
  };
}
