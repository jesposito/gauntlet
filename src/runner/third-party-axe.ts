/**
 * Detect axe violations that live inside third-party iframe content (YouTube,
 * Vimeo, Stripe Elements, Cloudflare Turnstile, reCAPTCHA, Calendly, etc).
 * Host sites cannot fix DOM they do not own, so these findings drown out
 * fixable issues and erode trust in the report.
 *
 * Two detection signals:
 *
 * 1. Frame-piercing target chain. @axe-core/playwright returns `target` as
 *    an array of CSS selectors, one per frame boundary crossed. A target
 *    with length >= 2 originates inside an iframe by definition. This is
 *    the strongest signal and catches everything cleanly.
 *
 * 2. Known third-party class/id prefix. Defensive: covers cases where the
 *    iframe is same-origin (own subdomain) but the inner content is still
 *    an embedded widget we don't own. Less common but worth catching.
 */

interface AxeNodeLike {
  /** @axe-core/playwright returns target as string[] (frame chain) or string. */
  target?: unknown;
  /** The failing element's outer HTML. */
  html?: string;
}

/** Known third-party class/id patterns that signal embedded widget content. */
const THIRD_PARTY_PREFIXES: { name: string; pattern: RegExp }[] = [
  { name: "youtube", pattern: /\b(ytm-|ytp-|ytd-|movie_player|ytmVideoInfo)/ },
  { name: "vimeo", pattern: /\bvp-|\bvuplay-/ },
  { name: "stripe-elements", pattern: /__PrivateStripeElement|StripeElement/ },
  { name: "cloudflare-turnstile", pattern: /cf-turnstile/ },
  { name: "recaptcha", pattern: /\bg-recaptcha\b|grecaptcha-/ },
  { name: "hcaptcha", pattern: /\bh-captcha\b|hcaptcha-/ },
  { name: "calendly", pattern: /calendly-/ },
  { name: "intercom", pattern: /intercom-/ },
  { name: "typeform", pattern: /tf-v1-/ },
];

export interface ThirdPartyVerdict {
  thirdParty: boolean;
  /** Best-effort label for the embed host, when detectable. */
  source?: string;
  /** Which signal fired: frame-pierce | prefix-match | both. */
  reason?: "frame-pierce" | "prefix-match" | "both";
}

/**
 * Classify a single axe violation node. Returns thirdParty=false when no
 * signal fires, so the caller can keep it as a normal finding.
 */
export function classifyAxeNode(node: AxeNodeLike): ThirdPartyVerdict {
  const targetArr: string[] = Array.isArray(node.target)
    ? (node.target as unknown[]).filter((s): s is string => typeof s === "string")
    : typeof node.target === "string"
      ? [node.target]
      : [];
  const html = typeof node.html === "string" ? node.html : "";

  const framePierced = targetArr.length >= 2;
  let prefixMatch: string | undefined;
  for (const { name, pattern } of THIRD_PARTY_PREFIXES) {
    if (pattern.test(html) || targetArr.some((t) => pattern.test(t))) {
      prefixMatch = name;
      break;
    }
  }

  if (!framePierced && !prefixMatch) return { thirdParty: false };
  return {
    thirdParty: true,
    ...(prefixMatch ? { source: prefixMatch } : { source: "iframe" }),
    reason:
      framePierced && prefixMatch
        ? "both"
        : framePierced
          ? "frame-pierce"
          : "prefix-match",
  };
}

/**
 * Classify a whole violation by majority vote over its sampled nodes.
 * Returns a verdict + counts so callers can decide between "downgrade"
 * (some nodes third-party, some not) and "drop" (all third-party).
 */
export function classifyAxeViolation(nodes: AxeNodeLike[]): {
  thirdPartyMajority: boolean;
  allThirdParty: boolean;
  thirdPartyCount: number;
  totalCount: number;
  source?: string;
} {
  if (nodes.length === 0) {
    return { thirdPartyMajority: false, allThirdParty: false, thirdPartyCount: 0, totalCount: 0 };
  }
  let tp = 0;
  let source: string | undefined;
  for (const n of nodes) {
    const v = classifyAxeNode(n);
    if (v.thirdParty) {
      tp += 1;
      if (!source && v.source) source = v.source;
    }
  }
  return {
    thirdPartyMajority: tp * 2 >= nodes.length,
    allThirdParty: tp === nodes.length,
    thirdPartyCount: tp,
    totalCount: nodes.length,
    ...(source ? { source } : {}),
  };
}
