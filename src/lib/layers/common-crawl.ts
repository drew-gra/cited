/**
 * Layer 5 — Common Crawl presence check.
 *
 * Queries the Common Crawl CDX API across the last six monthly CC-MAIN
 * indexes for the outlet's root domain and counts how many records each
 * snapshot has. The aggregate answers "is this domain in Common Crawl's
 * recent corpus, and is the trend going up or down?"
 *
 * Why this matters: Common Crawl feeds many open and proprietary AI training
 * corpora. A domain that's absent from recent CC indexes (or trending down)
 * is leading-indicator-evidence that models trained primarily on CC won't
 * have seen the site's recent content.
 *
 * Common Crawl's CDX API is hosted at index.commoncrawl.org — a different
 * host from the target domain — so our per-domain politeness rule doesn't
 * apply. We fetch the six index queries in parallel.
 */

import { z } from "zod";
import { userAgent } from "../policy";

export const coverageBucketSchema = z.enum([
  "absent",
  "low",
  "moderate",
  "high",
]);
export const trendSchema = z.enum([
  "absent",
  "decreasing",
  "steady",
  "increasing",
  "insufficient_data",
]);

export const ccIndexResultSchema = z.object({
  indexName: z.string(),
  records: z.number(),
  capped: z.boolean(),
  earliestSeen: z.string().nullable(),
  latestSeen: z.string().nullable(),
  error: z.string().optional(),
});

// Runtime schema for the persisted L5 signal. Source of truth.
export const l5ResultSchema = z.object({
  rootDomain: z.string(),
  fetchedAt: z.string(),
  indexesQueried: z.number(),
  indexes: z.array(ccIndexResultSchema),
  indexesPresent: z.number(),
  totalRecords: z.number(),
  coverageBucket: coverageBucketSchema,
  trend: trendSchema,
});

export type CoverageBucket = z.infer<typeof coverageBucketSchema>;
export type Trend = z.infer<typeof trendSchema>;
export type CCIndexResult = z.infer<typeof ccIndexResultSchema>;
export type L5Result = z.infer<typeof l5ResultSchema>;

const PER_INDEX_LIMIT = 1000;
const COLLINFO_URL = "https://index.commoncrawl.org/collinfo.json";
const FETCH_TIMEOUT_MS = 20_000;
const MAX_ATTEMPTS = 2; // initial + one retry
const RETRY_BACKOFF_MS = 1_000;

// Trend guardrails — refuse to commit to a direction when the data won't
// reliably support one. See the trend revision discussion.
const TREND_MIN_TOTAL_RECORDS = 100;
const TREND_INCREASE_RATIO = 2.0;
const TREND_DECREASE_RATIO = 0.5;

/**
 * Fetch with retry on transient failures (503 from CC's CDX endpoint, or
 * timeouts). Common Crawl's CDX API intermittently throttles or returns 503
 * under load; a single retry recovers most of those without distorting the
 * dataset.
 */
async function fetchWithRetry(
  url: string,
  init: Omit<RequestInit, "signal">,
  timeoutMs: number,
  maxAttempts: number,
): Promise<Response> {
  let lastResponse: Response | null = null;
  let lastError: unknown = null;
  for (let attempt = 0; attempt < maxAttempts; attempt++) {
    try {
      const res = await fetch(url, {
        ...init,
        signal: AbortSignal.timeout(timeoutMs),
      });
      if (res.status !== 503) return res;
      lastResponse = res;
    } catch (err) {
      lastError = err;
    }
    if (attempt < maxAttempts - 1) {
      await new Promise((resolve) =>
        setTimeout(resolve, RETRY_BACKOFF_MS * (attempt + 1)),
      );
    }
  }
  if (lastResponse) return lastResponse;
  throw lastError ?? new Error("fetch failed after retries");
}

async function getRecentIndexes(count: number): Promise<string[]> {
  const res = await fetch(COLLINFO_URL, {
    headers: { "User-Agent": userAgent() },
    signal: AbortSignal.timeout(FETCH_TIMEOUT_MS),
  });
  if (!res.ok) {
    throw new Error(
      `Common Crawl collinfo returned HTTP ${res.status}`,
    );
  }
  const data = (await res.json()) as Array<{ id?: string; name?: string }>;
  const ccMain = data
    .map((c) => c.id ?? c.name ?? "")
    .filter((id): id is string => /^CC-MAIN-\d{4}-\d+$/.test(id))
    .sort()
    .reverse();
  return ccMain.slice(0, count);
}

async function queryCCIndex(
  indexName: string,
  rootDomain: string,
): Promise<CCIndexResult> {
  const url = `https://index.commoncrawl.org/${indexName}-index?url=${encodeURIComponent(
    rootDomain,
  )}&matchType=domain&output=json&limit=${PER_INDEX_LIMIT}`;
  try {
    const res = await fetchWithRetry(
      url,
      { headers: { "User-Agent": userAgent() } },
      FETCH_TIMEOUT_MS,
      MAX_ATTEMPTS,
    );
    if (res.status === 404) {
      // No matches in this index
      return {
        indexName,
        records: 0,
        capped: false,
        earliestSeen: null,
        latestSeen: null,
      };
    }
    if (!res.ok) {
      return {
        indexName,
        records: 0,
        capped: false,
        earliestSeen: null,
        latestSeen: null,
        error: `HTTP ${res.status}`,
      };
    }
    const text = await res.text();
    const lines = text.split("\n").filter((l) => l.trim().length > 0);
    let earliest: string | null = null;
    let latest: string | null = null;
    for (const line of lines) {
      try {
        const rec = JSON.parse(line) as { timestamp?: string };
        const ts = rec.timestamp;
        if (typeof ts === "string") {
          if (!earliest || ts < earliest) earliest = ts;
          if (!latest || ts > latest) latest = ts;
        }
      } catch {
        // ignore malformed line
      }
    }
    return {
      indexName,
      records: lines.length,
      capped: lines.length >= PER_INDEX_LIMIT,
      earliestSeen: earliest,
      latestSeen: latest,
    };
  } catch (err) {
    return {
      indexName,
      records: 0,
      capped: false,
      earliestSeen: null,
      latestSeen: null,
      error: err instanceof Error ? err.message : String(err),
    };
  }
}

function computeCoverageBucket(totalRecords: number): CoverageBucket {
  if (totalRecords === 0) return "absent";
  if (totalRecords < 50) return "low";
  if (totalRecords < 500) return "moderate";
  return "high";
}

function avg(nums: number[]): number {
  if (nums.length === 0) return 0;
  return nums.reduce((a, b) => a + b, 0) / nums.length;
}

function computeTrend(indexes: CCIndexResult[]): Trend {
  if (indexes.length < 4) return "insufficient_data";

  // Guardrail 1: incomplete dataset. If any query errored, we don't have
  // the full picture — claiming a direction would distort against missing
  // data. Honest answer: insufficient_data.
  if (indexes.some((i) => i.error)) return "insufficient_data";

  const totalRecords = indexes.reduce((sum, i) => sum + i.records, 0);

  // True absence is itself a trend signal.
  if (totalRecords === 0) return "absent";

  // Guardrail 2: low volume. Sub-100 records across six indexes is
  // statistical noise; small absolute differences amplify into spurious
  // percentage swings. Refuse to claim a direction here.
  if (totalRecords < TREND_MIN_TOTAL_RECORDS) return "insufficient_data";

  const half = Math.floor(indexes.length / 2);
  const recentAvg = avg(indexes.slice(0, half).map((i) => i.records));
  const olderAvg = avg(indexes.slice(half).map((i) => i.records));
  if (recentAvg === 0) return "decreasing";
  if (olderAvg === 0) return "increasing";

  // Guardrail 3: require a meaningful delta (doubled or halved) to call a
  // direction. Smaller shifts are within sampling noise.
  const ratio = recentAvg / olderAvg;
  if (ratio <= TREND_DECREASE_RATIO) return "decreasing";
  if (ratio >= TREND_INCREASE_RATIO) return "increasing";
  return "steady";
}

export async function fetchCommonCrawlPresence(
  rootDomain: string,
): Promise<L5Result> {
  const fetchedAt = new Date().toISOString();
  let indexNames: string[];
  try {
    indexNames = await getRecentIndexes(6);
  } catch (err) {
    return {
      rootDomain,
      fetchedAt,
      indexesQueried: 0,
      indexes: [],
      indexesPresent: 0,
      totalRecords: 0,
      coverageBucket: "absent",
      trend: "insufficient_data",
    };
  }

  const indexes = await Promise.all(
    indexNames.map((name) => queryCCIndex(name, rootDomain)),
  );
  const indexesPresent = indexes.filter((i) => i.records > 0).length;
  const totalRecords = indexes.reduce((sum, i) => sum + i.records, 0);

  return {
    rootDomain,
    fetchedAt,
    indexesQueried: indexes.length,
    indexes,
    indexesPresent,
    totalRecords,
    coverageBucket: computeCoverageBucket(totalRecords),
    trend: computeTrend(indexes),
  };
}
