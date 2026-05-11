/**
 * Common URL paths to probe for surface discovery. Aim to surface auth-walled
 * admin/login pages that the user didn't pass to `gauntlet init --url`.
 *
 * Kept short (8 entries) so a probe pass against 1-3 origins stays cheap.
 * Skip 404s. 200/401/403 are all interesting (200 = real surface, 401/403 =
 * auth-walled surface, both signal additional audience views worth modeling).
 */
export const DEFAULT_PROBE_PATHS: readonly string[] = [
  "/admin",
  "/admin/login",
  "/login",
  "/signin",
  "/dashboard",
  "/pricing",
  "/app",
  "/_/login", // PocketBase superuser
];

const KEEP_STATUSES = new Set<number>([200, 301, 302, 401, 403]);

export function originOf(url: string): string | undefined {
  try {
    const u = new URL(url);
    return `${u.protocol}//${u.host}`;
  } catch {
    return undefined;
  }
}

/**
 * Given a list of user-supplied landing URLs, propose additional candidate
 * URLs to probe by combining each unique origin with the default path list.
 * Skips paths the user already covered.
 */
export function planProbeCandidates(
  userUrls: string[],
  paths: readonly string[] = DEFAULT_PROBE_PATHS,
): string[] {
  const userSet = new Set(userUrls);
  const userPathsByOrigin = new Map<string, Set<string>>();
  for (const u of userUrls) {
    try {
      const url = new URL(u);
      const origin = `${url.protocol}//${url.host}`;
      const pathname = url.pathname.replace(/\/$/, "");
      let set = userPathsByOrigin.get(origin);
      if (!set) {
        set = new Set();
        userPathsByOrigin.set(origin, set);
      }
      set.add(pathname);
    } catch {
      /* ignore malformed */
    }
  }
  const candidates: string[] = [];
  for (const [origin, used] of userPathsByOrigin) {
    for (const path of paths) {
      const candidate = `${origin}${path}`;
      const normalized = path.replace(/\/$/, "");
      if (used.has(normalized)) continue; // user already passed this path
      if (userSet.has(candidate)) continue; // exact duplicate
      candidates.push(candidate);
    }
  }
  return candidates;
}

export interface ProbeResult {
  url: string;
  statusCode: number | undefined;
  reachable: boolean;
  worthIncluding: boolean;
}

/**
 * HEAD/GET the candidate URL and decide whether to feed it to the surface
 * generator. Returns reachable=false silently for network errors so the
 * caller can keep going.
 */
export async function probeOne(
  candidate: string,
  timeoutMs: number = 5_000,
): Promise<ProbeResult> {
  try {
    const res = await fetch(candidate, {
      method: "GET",
      redirect: "manual",
      headers: { "user-agent": "gauntlet-init/probe" },
      signal: AbortSignal.timeout(timeoutMs),
    });
    const worthIncluding = KEEP_STATUSES.has(res.status);
    return {
      url: candidate,
      statusCode: res.status,
      reachable: res.status < 500 && res.status !== 404,
      worthIncluding,
    };
  } catch {
    return { url: candidate, statusCode: undefined, reachable: false, worthIncluding: false };
  }
}

/**
 * Probe every candidate with bounded concurrency. Returns only the candidates
 * worth including (interesting status codes); silently drops 404s and errors.
 */
export async function probeAll(
  candidates: string[],
  options: { concurrency?: number; timeoutMs?: number } = {},
): Promise<ProbeResult[]> {
  const concurrency = Math.max(1, options.concurrency ?? 3);
  const timeoutMs = options.timeoutMs ?? 5_000;
  const results: ProbeResult[] = [];
  let cursor = 0;
  async function spawn(): Promise<void> {
    while (true) {
      const idx = cursor++;
      if (idx >= candidates.length) return;
      const r = await probeOne(candidates[idx]!, timeoutMs);
      results.push(r);
    }
  }
  const n = Math.min(concurrency, candidates.length);
  await Promise.all(Array.from({ length: n }, () => spawn()));
  return results.filter((r) => r.worthIncluding);
}
