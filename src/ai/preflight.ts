import { z } from "zod";
import type { AiProvider } from "./provider.ts";
import { withCancellableTimeout } from "./with-cancellable-timeout.ts";

/**
 * Default preflight budget. Short on purpose: this is a liveness probe, not a
 * real inference call, so a healthy provider answers fast. A dead/expired key
 * 401s immediately; a network black hole is what the timeout catches.
 */
export const PREFLIGHT_TIMEOUT_MS = 10_000;

const PreflightSchema = z.object({ ok: z.boolean() });

/**
 * Run ONE minimal provider.propose() to prove the API key + network path work
 * before a long run commits to them. A dead/expired key (production saw a
 * mid-run 401 this week) fails fast here with a one-line message instead of
 * blowing up halfway through a flow.
 *
 * Never throws — auth, network, timeout, and schema failures all collapse to
 * { ok: false, error }. Callers branch on `ok`, they don't try/catch.
 */
export async function preflightProvider(
  provider: AiProvider,
  opts?: { signal?: AbortSignal; timeoutMs?: number },
): Promise<{ ok: true } | { ok: false; error: string }> {
  const timeoutMs = opts?.timeoutMs ?? PREFLIGHT_TIMEOUT_MS;
  try {
    await withCancellableTimeout(
      (timeoutSignal) =>
        provider.propose({
          messages: [
            { role: "system", content: "Reply with JSON only." },
            { role: "user", content: 'Return {"ok": true}.' },
          ],
          schema: PreflightSchema,
          schemaName: "Preflight",
          schemaDescription: 'Object {"ok": boolean}. Always return ok=true.',
          maxTokens: 16,
          temperature: 0,
          signal: combineSignals(opts?.signal, timeoutSignal),
        }),
      timeoutMs,
      "AI provider preflight",
    );
    return { ok: true };
  } catch (err) {
    return { ok: false, error: oneLine(err) };
  }
}

/** Collapse any thrown value to a single trimmed line for clean CLI output. */
function oneLine(err: unknown): string {
  const msg = err instanceof Error ? err.message : String(err);
  return msg.replace(/\s+/g, " ").trim() || "unknown error";
}

/**
 * Forward the caller's abort to the inner propose alongside the timeout's own
 * signal. `withCancellableTimeout` only feeds us the timeout signal; without
 * this a caller-initiated cancel wouldn't reach the in-flight fetch.
 */
function combineSignals(
  caller: AbortSignal | undefined,
  timeout: AbortSignal,
): AbortSignal {
  if (!caller) return timeout;
  // AbortSignal.any landed in Bun/Node; use it when present, else bridge.
  const anyFn = (AbortSignal as { any?: (s: AbortSignal[]) => AbortSignal }).any;
  if (anyFn) return anyFn([caller, timeout]);
  const ctrl = new AbortController();
  const onAbort = () => ctrl.abort();
  if (caller.aborted || timeout.aborted) ctrl.abort();
  else {
    caller.addEventListener("abort", onAbort, { once: true });
    timeout.addEventListener("abort", onAbort, { once: true });
  }
  return ctrl.signal;
}
