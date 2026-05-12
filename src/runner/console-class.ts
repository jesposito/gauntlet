/**
 * Categorize a console-error message into a stable class so the report
 * + cross-surface signature can distinguish:
 *
 *   - CSP violations (config gap, host can fix)
 *   - Resource-blocked-by-extension (user config, host can't fix)
 *   - Preload warnings (warn-class, not error)
 *   - Mixed-content / cookie-same-site (browser policy, host can fix)
 *   - Generic 4xx/5xx network errors (real product errors)
 *   - Plain Error / TypeError / ReferenceError (real product errors)
 *   - Unknown (catchall)
 *
 * This is feature-detection on the message text, not a parse — we want
 * to be liberal in what we accept so the labels stay useful across
 * Chrome version bumps.
 */

export type ConsoleClass =
  | "csp_violation"
  | "extension_blocked"
  | "preload_unused"
  | "mixed_content"
  | "cookie_policy"
  | "network_error"
  | "uncaught_exception"
  | "unknown";

interface ConsoleClassification {
  class: ConsoleClass;
  /** When applicable, the CSP directive (e.g. "font-src", "connect-src"). */
  cspDirective?: string;
  /** Short human-readable tag (e.g. "CSP font-src"). */
  label: string;
}

export function classifyConsoleMessage(message: string): ConsoleClassification {
  const m = message;

  // CSP violations are the highest-signal category: they come with a
  // directive name and the host site can fix them by widening the header.
  const cspMatch = m.match(
    /Content Security Policy directive[^"']*["']([a-z-]+)/i,
  );
  if (cspMatch && cspMatch[1]) {
    return {
      class: "csp_violation",
      cspDirective: cspMatch[1],
      label: `CSP ${cspMatch[1]}`,
    };
  }
  if (/Refused to (load|connect|run|apply)/i.test(m) && /Content Security Policy/i.test(m)) {
    return { class: "csp_violation", label: "CSP" };
  }
  if (/ERR_BLOCKED_BY_CSP/i.test(m)) {
    return { class: "csp_violation", label: "CSP (blocked)" };
  }

  // Browser extensions blocking resources — not a host problem.
  if (/(chrome-extension|moz-extension|safari-web-extension):/i.test(m)) {
    return { class: "extension_blocked", label: "extension-blocked" };
  }
  if (/ERR_BLOCKED_BY_CLIENT/i.test(m)) {
    return { class: "extension_blocked", label: "ad-blocker / extension" };
  }

  // Preload warnings — usually noisy, almost always fine.
  if (/preload(ed)? .*(was not used|is found, but is not used|but no consumer)/i.test(m)) {
    return { class: "preload_unused", label: "preload unused" };
  }
  if (/preload .* but the request credentials mode/i.test(m)) {
    return { class: "preload_unused", label: "preload mismatch" };
  }

  // Mixed-content (http resource on https page) — host can fix.
  if (/Mixed Content[: ]/i.test(m)) {
    return { class: "mixed_content", label: "mixed content" };
  }
  if (/blocked because (this|the) request[^.]*was made over HTTP/i.test(m)) {
    return { class: "mixed_content", label: "mixed content" };
  }

  // Cookie / SameSite policy — host can fix but easy to overlook.
  if (/Cookie [^\n]+ (rejected|set without|SameSite)/i.test(m)) {
    return { class: "cookie_policy", label: "cookie policy" };
  }
  if (/SameSite=None .* Secure/i.test(m)) {
    return { class: "cookie_policy", label: "cookie SameSite" };
  }

  // Generic network failures — real but coarse.
  if (
    /Failed to load resource/i.test(m) ||
    /net::ERR_/i.test(m) ||
    /\b[45]\d\d\b.*(error|status)/i.test(m)
  ) {
    return { class: "network_error", label: "network error" };
  }

  // Uncaught exception class (TypeError, ReferenceError, SyntaxError, etc).
  if (/(Uncaught|Unhandled).*(Error|Exception)/i.test(m)) {
    return { class: "uncaught_exception", label: "uncaught exception" };
  }
  if (/(TypeError|ReferenceError|SyntaxError|RangeError):/i.test(m)) {
    return { class: "uncaught_exception", label: "uncaught exception" };
  }

  return { class: "unknown", label: "console error" };
}
