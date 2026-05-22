export const TTL_SECONDS = {
  // L0 (preflight / news-outlet classification) stays cached for a week
  // because its signals — schema markup, Wikipedia presence, section
  // structure, hosting platform — move on month-scale and the same URL
  // shouldn't flip news/not-news between consecutive assessments.
  layer0: 7 * 24 * 60 * 60,
  layer1: 24 * 60 * 60,
  layer2: 24 * 60 * 60,
  layer3: 30 * 24 * 60 * 60,
  layer4: 7 * 24 * 60 * 60,
  layer5: 30 * 24 * 60 * 60,
} as const;

export const POLITENESS = {
  perDomainRequestsPerSecond: 1,
  fetchTimeoutMs: 8_000,
} as const;

export const ANTI_ABUSE = {
  freshAssessmentsPerHourPerIp: 20,
} as const;

export function userAgent(): string {
  return (
    process.env.CITED_USER_AGENT ??
    "AICitabilityBot/1.0 (+https://breadandlaw.com/cited)"
  );
}

// Baseline browser UA used (a) by Layer 4's UA-comparison probe phase as the
// "what a browser would see" reference, and (b) by Layer 4's sitemap /
// article-URL discovery so WAFs that drop the AICitabilityBot UA don't make
// L4 false-negative before the comparison phase even runs. Realistic
// recent-Chrome string; the exact UA matters less than not tripping
// "block all bots" CDN rules.
export const BASELINE_USER_AGENT =
  "Mozilla/5.0 (Macintosh; Intel Mac OS X 10_15_7) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36";
