/**
 * Race a builder against a timeout while feeding it an AbortSignal. On
 * timeout the signal is aborted so the underlying op (AI provider fetch,
 * etc) actually stops mutating state instead of running to completion in
 * the background. Mirrors the runner-side helper of the same shape in
 * `src/runner/flow-runner.ts` (`withCancellableTimeout` there). Kept in
 * its own module so init-phase generators can share the pattern without
 * importing the runner.
 *
 * On timeout, rejects with a clear `Error` whose message names the label
 * and elapsed budget. Caller can string-match if they want a specific
 * UX, but most call sites just bubble.
 *
 * NOTE: there is no built-in retry here. The runner's `aiOpWithTimeout`
 * adds one retry on top of this primitive; init generators deliberately
 * do NOT retry — a hung init AI call is rare, and a silent retry would
 * double the wallclock budget of `gauntlet init` without obvious cause.
 */
export function withCancellableTimeout<T>(
  build: (signal: AbortSignal) => Promise<T>,
  ms: number,
  label: string,
): Promise<T> {
  const controller = new AbortController();
  let timer: ReturnType<typeof setTimeout> | undefined;
  const timeout = new Promise<never>((_, rej) => {
    timer = setTimeout(() => {
      controller.abort();
      rej(new Error(`${label} exceeded ${ms}ms`));
    }, ms);
  });
  return Promise.race([build(controller.signal), timeout]).finally(() => {
    if (timer) clearTimeout(timer);
  }) as Promise<T>;
}

/**
 * Default per-AI-call budget for init-phase generators (surfaces, personas,
 * flows). These calls are inference-heavy; a slow model can legitimately
 * take ~60s for a flow batch. 120s gives slack while still bounding any
 * true network/provider hang. Codex audit 2026-05-14 flagged the absence
 * of any timeout here as Medium-high.
 */
export const INIT_AI_TIMEOUT_MS = 120_000;
