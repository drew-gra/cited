/**
 * Layer 3 — Infrastructure / CDN fingerprint.
 *
 * Identifies which CDN, WAF, or hosting provider sits in front of the
 * origin by matching response-header signatures. Pure function: takes the
 * curated response headers captured by Layer 2 and returns the detected
 * CDN(s) with the evidence that triggered each match. No network I/O.
 *
 * Why this matters: CDN-level AI-bot blocking (Cloudflare's "Block AI
 * Scrapers" toggle, Akamai's bot manager, etc.) is invisible to Layer 1.
 * Knowing the CDN tells us whether to trust Layer 1's "open" verdicts or
 * whether to lean harder on Layer 4 (UA probing) to verify.
 */

export type CdnId =
  | "cloudflare"
  | "cloudfront"
  | "fastly"
  | "akamai"
  | "vercel"
  | "netlify"
  | "imperva"
  | "sucuri"
  | "unknown";

export type L3Evidence = {
  cdn: CdnId;
  header: string;
  value: string;
  reason: string;
};

export type L3Result = {
  rootDomain: string;
  fetchedAt: string;
  /** CDNs detected. May contain multiple when stacks are layered
   * (e.g., Cloudflare in front of a Vercel-hosted origin). */
  detected: CdnId[];
  evidence: L3Evidence[];
};

type Fingerprint = {
  cdn: CdnId;
  header: string;
  pattern?: RegExp;
  reason: string;
};

const FINGERPRINTS: Fingerprint[] = [
  // Cloudflare
  { cdn: "cloudflare", header: "cf-ray", reason: "cf-ray header present" },
  {
    cdn: "cloudflare",
    header: "cf-cache-status",
    reason: "cf-cache-status header present",
  },
  {
    cdn: "cloudflare",
    header: "server",
    pattern: /^cloudflare/i,
    reason: "Server: cloudflare",
  },
  // CloudFront / AWS
  {
    cdn: "cloudfront",
    header: "x-amz-cf-id",
    reason: "x-amz-cf-id header present",
  },
  {
    cdn: "cloudfront",
    header: "via",
    pattern: /CloudFront/i,
    reason: "Via header contains CloudFront",
  },
  // Fastly
  {
    cdn: "fastly",
    header: "x-served-by",
    pattern: /cache-/i,
    reason: "x-served-by contains cache- POP marker",
  },
  {
    cdn: "fastly",
    header: "x-fastly-request-id",
    reason: "x-fastly-request-id header present",
  },
  // x-timer is Fastly's debug timing header in the canonical
  // S<float>,VS<int>,VE<int> format. It survives on the final response
  // even when redirects drop the other Fastly indicators — required to
  // detect publishers like theguardian.com that redirect to a canonical
  // URL (e.g. /us, /uk) and whose final response carries only x-timer.
  {
    cdn: "fastly",
    header: "x-timer",
    pattern: /^S\d/,
    reason: "x-timer header in Fastly debug-timer format",
  },
  // Akamai
  {
    cdn: "akamai",
    header: "x-akamai-request-id",
    reason: "x-akamai-request-id header present",
  },
  {
    cdn: "akamai",
    header: "x-akamai-transformed",
    reason: "x-akamai-transformed header present",
  },
  {
    cdn: "akamai",
    header: "server",
    pattern: /AkamaiGHost/i,
    reason: "Server: AkamaiGHost",
  },
  // Vercel
  {
    cdn: "vercel",
    header: "x-vercel-id",
    reason: "x-vercel-id header present",
  },
  {
    cdn: "vercel",
    header: "server",
    pattern: /^Vercel/i,
    reason: "Server: Vercel",
  },
  // Netlify
  {
    cdn: "netlify",
    header: "x-nf-request-id",
    reason: "x-nf-request-id header present",
  },
  // Imperva / Incapsula
  {
    cdn: "imperva",
    header: "x-iinfo",
    reason: "x-iinfo header present (Imperva/Incapsula)",
  },
  // Sucuri
  {
    cdn: "sucuri",
    header: "x-sucuri-id",
    reason: "x-sucuri-id header present",
  },
  {
    cdn: "sucuri",
    header: "x-sucuri-cache",
    reason: "x-sucuri-cache header present",
  },
];

export function detectCdn(
  rootDomain: string,
  responseHeaders: Record<string, string>,
): L3Result {
  // Normalize keys to lowercase since callers may pass either form.
  const lower: Record<string, string> = {};
  for (const [k, v] of Object.entries(responseHeaders)) {
    lower[k.toLowerCase()] = v;
  }

  const detectedSet = new Set<CdnId>();
  const evidence: L3Evidence[] = [];

  for (const fp of FINGERPRINTS) {
    const headerVal = lower[fp.header];
    if (!headerVal) continue;
    if (fp.pattern && !fp.pattern.test(headerVal)) continue;
    detectedSet.add(fp.cdn);
    evidence.push({
      cdn: fp.cdn,
      header: fp.header,
      value: headerVal,
      reason: fp.reason,
    });
  }

  return {
    rootDomain,
    fetchedAt: new Date().toISOString(),
    detected: Array.from(detectedSet),
    evidence,
  };
}
