/**
 * Wait for the page DOM to stop mutating, capped by a hard timeout.
 *
 * `page.waitForLoadState("networkidle")` is the obvious tool but is well
 * known to be unreliable on real SPAs: anything that polls (telemetry,
 * websockets, analytics, GraphQL subscriptions) keeps the network busy
 * indefinitely and networkidle never fires until the global timeout.
 *
 * Mutation-based settle is more robust. We install a MutationObserver on
 * `document.body`, count mutations in a rolling window, and resolve when
 * we go `quietMs` milliseconds with zero mutations. Capped at `timeoutMs`
 * so the worst case (a page that legitimately animates forever) still
 * bounds the wait.
 */
import type { Page } from "playwright";

export interface WaitForDomSettleOptions {
  /** Required period of zero DOM mutations before considering the page settled. Default 600ms. */
  quietMs?: number;
  /** Hard cap on the wait, even if the DOM never settles. Default 8000ms. */
  timeoutMs?: number;
}

/**
 * Waits for `quietMs` of DOM mutation silence, capped at `timeoutMs`.
 * Returns the actual wait duration in ms. Never throws — on cap, returns
 * `timeoutMs` and lets the caller proceed (mutation-observer pages that
 * never quiet are real apps the runner still wants to scan).
 */
export async function waitForDomSettle(
  page: Page,
  opts: WaitForDomSettleOptions = {},
): Promise<number> {
  const quietMs = Math.max(50, opts.quietMs ?? 600);
  const timeoutMs = Math.max(quietMs, opts.timeoutMs ?? 8_000);
  const startedAt = Date.now();
  try {
    await page.evaluate(
      ({ quietMs, timeoutMs }) =>
        new Promise<void>((resolve) => {
          let lastMutationAt = performance.now();
          let resolved = false;
          const target = document.body || document.documentElement;
          if (!target) {
            resolve();
            return;
          }
          const observer = new MutationObserver(() => {
            lastMutationAt = performance.now();
          });
          observer.observe(target, {
            attributes: true,
            childList: true,
            subtree: true,
            characterData: true,
          });
          const startedAt = performance.now();
          const check = (): void => {
            if (resolved) return;
            const now = performance.now();
            if (now - startedAt >= timeoutMs) {
              resolved = true;
              observer.disconnect();
              resolve();
              return;
            }
            if (now - lastMutationAt >= quietMs) {
              resolved = true;
              observer.disconnect();
              resolve();
              return;
            }
            // Poll the gate ~10 Hz; the observer keeps lastMutationAt fresh.
            setTimeout(check, 100);
          };
          // Kick off the first check after one quiet window so the cold-start
          // case (no mutations at all) resolves promptly.
          setTimeout(check, Math.min(quietMs, 200));
        }),
      { quietMs, timeoutMs },
    );
  } catch {
    /* page may have closed mid-wait; the outer flow will catch it */
  }
  return Date.now() - startedAt;
}
