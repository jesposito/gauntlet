/**
 * Detect whether a console-error / network-failure message is about an
 * EXTERNAL host (third-party CDN, font service, etc) vs the page's own origin.
 *
 * Used to downgrade the severity of "fonts.googleapis.com fail" style noise
 * that drowns out real product findings. Returns the external host's
 * hostname if one is found and differs from the page host; undefined
 * otherwise.
 */
// Naive registrable-domain: last two labels. Doesn't handle multi-label TLDs
// like .co.uk, but is correct for the typical SaaS hostnames we hit.
function registrableDomain(host: string): string {
  const parts = host.split(".");
  if (parts.length <= 2) return host;
  return parts.slice(-2).join(".");
}

export function detectExternalHost(message: string, pageUrl: string): string | undefined {
  let pageHost: string;
  try {
    pageHost = new URL(pageUrl).hostname;
  } catch {
    return undefined;
  }
  const pageReg = registrableDomain(pageHost);
  const urlMatches = message.match(/https?:\/\/[a-z0-9.-]+(?::\d+)?(?:\/[^\s'"`)]*)?/gi);
  if (!urlMatches) return undefined;
  for (const candidate of urlMatches) {
    try {
      const host = new URL(candidate).hostname;
      // Same hostname or same registrable domain = first-party family.
      if (host === pageHost) continue;
      if (registrableDomain(host) === pageReg) continue;
      return host;
    } catch {
      continue;
    }
  }
  return undefined;
}
