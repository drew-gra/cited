export const TTL_SECONDS = {
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
