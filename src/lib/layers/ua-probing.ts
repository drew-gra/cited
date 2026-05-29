/**
 * Layer 4 — User-agent A/B probing.
 *
 * For a small sample of article URLs (discovered via the sitemap chain in
 * ../layers/sitemap.ts), fetch each URL once with a baseline browser UA and
 * once with each v1 AI bot UA. Compare status code, response size, and a
 * SHA-256 content hash of the first 200KB of the body. Aggregate per bot
 * into allowed / blocked / mixed / unknown.
 *
 * This is the load-bearing layer that distinguishes "publisher claims to
 * allow/block" (L1/L2) from "the server actually allows/blocks". Unlike the
 * other layers, L4 does NOT honor the target's robots.txt — that would
 * defeat the entire purpose: we want to see what the AI bots would
 * experience if they tried.
 *
 * Politeness inside this layer is the caller's responsibility — both the
 * Inngest function and the bench probe orchestrate per-fetch sleeps to
 * enforce one request per second per target domain.
 */

import { createHash } from "node:crypto";
import { z } from "zod";
import { BASELINE_USER_AGENT, POLITENESS } from "../policy";
import { BOTS, aiPlatformSchema, botPurposeSchema } from "../ai-platforms";
import {
  sitemapSourceSchema,
  type SitemapDiscoveryResult,
} from "./sitemap";

// Cap body read for hashing. 200KB is enough to detect "soft-paywall stub
// vs. full article" while keeping memory bounded for L4's 50 fetches.
const MAX_BODY_BYTES = 200 * 1024;

// Comparison thresholds for content-similarity.
// - exact hash match → identical.
// - byteRatio within ±5% of 1.0 → likely identical with timestamp / ad-slot
//   variance (modern pages have many ephemeral elements).
// - byteRatio below 0.85 → bot fetched substantially less; likely a stub or
//   gated response → blocked signal.
// - between 0.85 and 0.95 → ambiguous; treated as allowed unless the bot
//   also returned non-success.
const SIZE_RATIO_IDENTICAL = 0.05;
const SIZE_RATIO_STUB_THRESHOLD = 0.85;

// Single retry, applied only to connection-class errors (TCP reset, TLS
// handshake aborted, etc.). Timeouts skip retry — when a server is
// deliberately stalling our UA, a second attempt will just stall again
// and waste another fetchTimeoutMs. This delay is also the politeness
// budget we burn before retrying the same target.
const L4_RETRY_BACKOFF_MS = 2_000;

// Tarpit-detection thresholds, used in compareToBaseline. A bot fetch is
// treated as a stall when (a) its error was a timeout, (b) its duration is
// within TARPIT_TIMEOUT_PROXIMITY_MS of the fetch timeout (meaning OUR
// abort fired, not a server-side closure), and (c) the baseline for the
// same URL was much faster — TARPIT_BASELINE_RATIO_MAX bounds how close
// baseline duration can get to bot duration before the pattern stops
// looking like a deliberate stall.
const TARPIT_TIMEOUT_PROXIMITY_MS = 200;
const TARPIT_BASELINE_RATIO_MAX = 0.25;

export const l4ErrorKindSchema = z
  .enum(["timeout", "connection", "other"])
  .nullable();

export const l4ProbeSchema = z.object({
  url: z.string(),
  userAgent: z.string(),
  isBaseline: z.boolean(),
  statusCode: z.number().nullable(),
  finalUrl: z.string().nullable(),
  responseSizeBytes: z.number().nullable(),
  contentHash: z.string().nullable(),
  errorMessage: z.string().optional(),
  durationMs: z.number(),
  // Added after early probes were stored; default null so older probe
  // records still validate. Not read at verdict time — forensic only.
  errorKind: l4ErrorKindSchema.default(null),
});

export const l4ComparisonOutcomeSchema = z.enum([
  "allowed",
  "blocked",
  "bot_error",
  "baseline_failed",
]);

// When a comparison's outcome is "blocked", blockMechanism records WHY:
// - "status" — bot got a 4xx/5xx, or got a 2xx with substantially shorter
//   content than baseline (soft-paywall / stub).
// - "stall" — bot fetch timed out while baseline succeeded fast (tarpit).
// null for any non-blocked outcome.
export const l4BlockMechanismSchema = z
  .enum(["status", "stall"])
  .nullable();

export const l4UrlComparisonSchema = z.object({
  url: z.string(),
  baselineStatus: z.number().nullable(),
  botStatus: z.number().nullable(),
  sizeRatio: z.number().nullable(),
  hashMatches: z.boolean(),
  outcome: l4ComparisonOutcomeSchema,
  // Added after early comparisons were stored; default null so older
  // signals validate. A null mechanism falls back to the generic blocked
  // headline — the finding (restrictive) is unaffected.
  blockMechanism: l4BlockMechanismSchema.default(null),
});

export const l4BotAggregateSchema = z.enum([
  "allowed",
  "blocked",
  "mixed",
  "unknown",
]);

export const l4BotResultSchema = z.object({
  ua: z.string(),
  platform: aiPlatformSchema,
  purpose: botPurposeSchema,
  perUrl: z.array(l4UrlComparisonSchema),
  aggregate: l4BotAggregateSchema,
});

export const l4StatusSchema = z.enum([
  "ok",
  "no_urls",
  "baseline_failed",
  "error",
]);

// Runtime schema for the persisted L4 signal. Source of truth.
export const l4ResultSchema = z.object({
  rootDomain: z.string(),
  fetchedAt: z.string(),
  status: l4StatusSchema,
  errorMessage: z.string().optional(),
  sampleSource: sitemapSourceSchema,
  sampleSourceUrl: z.string().nullable(),
  sampleUrls: z.array(z.string()),
  baselineUserAgent: z.string(),
  probes: z.array(l4ProbeSchema),
  perBot: z.array(l4BotResultSchema),
});

export type L4ErrorKind = z.infer<typeof l4ErrorKindSchema>;
export type L4Probe = z.infer<typeof l4ProbeSchema>;
export type L4ComparisonOutcome = z.infer<typeof l4ComparisonOutcomeSchema>;
export type L4BlockMechanism = z.infer<typeof l4BlockMechanismSchema>;
export type L4UrlComparison = z.infer<typeof l4UrlComparisonSchema>;
export type L4BotAggregate = z.infer<typeof l4BotAggregateSchema>;
export type L4BotResult = z.infer<typeof l4BotResultSchema>;
export type L4Status = z.infer<typeof l4StatusSchema>;
export type L4Result = z.infer<typeof l4ResultSchema>;

type AttemptResult = {
  statusCode: number | null;
  finalUrl: string | null;
  bytesRead: number | null;
  contentHash: string | null;
  durationMs: number;
  errorMessage?: string;
  errorKind: L4ErrorKind;
};

/**
 * Best-effort classification of a thrown fetch error into a kind we can
 * branch on. Node's fetch standardizes timeout errors as either DOMException
 * with name "TimeoutError" / "AbortError" (with AbortSignal.timeout) or as
 * an Error whose message contains "abort" / "timeout"; everything else
 * (ECONNRESET, ECONNREFUSED, ENOTFOUND, TLS errors) we lump as "connection"
 * because the practical decision — whether to retry — is the same for all
 * of them.
 */
function classifyFetchError(err: unknown): "timeout" | "connection" | "other" {
  if (err instanceof Error) {
    if (err.name === "TimeoutError" || err.name === "AbortError") {
      return "timeout";
    }
    if (/abort|timeout/i.test(err.message)) return "timeout";
    return "connection";
  }
  return "other";
}

async function attemptProbe(url: string, ua: string): Promise<AttemptResult> {
  const startedAt = Date.now();
  try {
    const res = await fetch(url, {
      headers: { "User-Agent": ua },
      redirect: "follow",
      signal: AbortSignal.timeout(POLITENESS.fetchTimeoutMs),
    });

    let bytesRead = 0;
    const chunks: Uint8Array[] = [];
    const reader = res.body?.getReader();
    if (reader) {
      while (bytesRead < MAX_BODY_BYTES) {
        const { done, value } = await reader.read();
        if (done) break;
        chunks.push(value);
        bytesRead += value.length;
      }
      reader.cancel().catch(() => {});
    }

    const buf = Buffer.concat(chunks.map((c) => Buffer.from(c))).subarray(
      0,
      MAX_BODY_BYTES,
    );
    const hash = createHash("sha256").update(buf).digest("hex");

    return {
      statusCode: res.status,
      finalUrl: res.url || url,
      bytesRead: buf.length,
      contentHash: hash,
      durationMs: Date.now() - startedAt,
      errorKind: null,
    };
  } catch (err) {
    return {
      statusCode: null,
      finalUrl: null,
      bytesRead: null,
      contentHash: null,
      durationMs: Date.now() - startedAt,
      errorMessage: err instanceof Error ? err.message : String(err),
      errorKind: classifyFetchError(err),
    };
  }
}

/**
 * Fetch a URL with a specific user agent. Reads at most MAX_BODY_BYTES so a
 * single multi-megabyte article doesn't blow out memory across 50 probes.
 * The captured `responseSizeBytes` is the bytes actually read (post-cap);
 * that's consistent across probes so comparison is meaningful, and the cap
 * is well above the typical paywall-stub size we want to detect.
 *
 * On a connection-class failure (TCP reset, TLS error, DNS), attempts a
 * single retry after L4_RETRY_BACKOFF_MS. Timeout failures skip retry —
 * see L4_RETRY_BACKOFF_MS rationale.
 */
export async function probeUrl(
  url: string,
  ua: string,
  isBaseline: boolean,
): Promise<L4Probe> {
  let result = await attemptProbe(url, ua);
  if (result.statusCode === null && result.errorKind === "connection") {
    await sleep(L4_RETRY_BACKOFF_MS);
    result = await attemptProbe(url, ua);
  }
  return {
    url,
    userAgent: ua,
    isBaseline,
    statusCode: result.statusCode,
    finalUrl: result.finalUrl,
    responseSizeBytes: result.bytesRead,
    contentHash: result.contentHash,
    durationMs: result.durationMs,
    errorMessage: result.errorMessage,
    errorKind: result.errorKind,
  };
}

function isBaselineOk(p: L4Probe): boolean {
  return p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 400;
}

function isTarpitPattern(baseline: L4Probe, bot: L4Probe): boolean {
  if (bot.statusCode !== null) return false;
  if (bot.errorKind !== "timeout") return false;
  if (
    bot.durationMs <
    POLITENESS.fetchTimeoutMs - TARPIT_TIMEOUT_PROXIMITY_MS
  ) {
    return false;
  }
  if (bot.durationMs <= 0) return false;
  return baseline.durationMs <= bot.durationMs * TARPIT_BASELINE_RATIO_MAX;
}

export function compareToBaseline(
  baseline: L4Probe,
  bot: L4Probe,
): L4UrlComparison {
  if (!isBaselineOk(baseline)) {
    return {
      url: baseline.url,
      baselineStatus: baseline.statusCode,
      botStatus: bot.statusCode,
      sizeRatio: null,
      hashMatches: false,
      outcome: "baseline_failed",
      blockMechanism: null,
    };
  }
  // Tarpit pattern — bot timed out at the fetch limit while baseline reached
  // the same URL quickly. Server is selectively unresponsive to this UA.
  // Has to be checked before the general "bot.statusCode === null →
  // bot_error" fallback so the tarpit case gets credit instead of looking
  // like network noise.
  if (isTarpitPattern(baseline, bot)) {
    return {
      url: baseline.url,
      baselineStatus: baseline.statusCode,
      botStatus: null,
      sizeRatio: null,
      hashMatches: false,
      outcome: "blocked",
      blockMechanism: "stall",
    };
  }
  if (bot.statusCode === null) {
    return {
      url: baseline.url,
      baselineStatus: baseline.statusCode,
      botStatus: null,
      sizeRatio: null,
      hashMatches: false,
      outcome: "bot_error",
      blockMechanism: null,
    };
  }
  if (bot.statusCode >= 400) {
    return {
      url: baseline.url,
      baselineStatus: baseline.statusCode,
      botStatus: bot.statusCode,
      sizeRatio: null,
      hashMatches: false,
      outcome: "blocked",
      blockMechanism: "status",
    };
  }

  const hashMatches =
    baseline.contentHash !== null &&
    bot.contentHash !== null &&
    baseline.contentHash === bot.contentHash;

  let sizeRatio: number | null = null;
  if (
    baseline.responseSizeBytes !== null &&
    bot.responseSizeBytes !== null &&
    baseline.responseSizeBytes > 0
  ) {
    sizeRatio = bot.responseSizeBytes / baseline.responseSizeBytes;
  }

  if (hashMatches) {
    return {
      url: baseline.url,
      baselineStatus: baseline.statusCode,
      botStatus: bot.statusCode,
      sizeRatio,
      hashMatches: true,
      outcome: "allowed",
      blockMechanism: null,
    };
  }

  if (sizeRatio !== null) {
    if (Math.abs(sizeRatio - 1) <= SIZE_RATIO_IDENTICAL) {
      return {
        url: baseline.url,
        baselineStatus: baseline.statusCode,
        botStatus: bot.statusCode,
        sizeRatio,
        hashMatches: false,
        outcome: "allowed",
        blockMechanism: null,
      };
    }
    if (sizeRatio < SIZE_RATIO_STUB_THRESHOLD) {
      return {
        url: baseline.url,
        baselineStatus: baseline.statusCode,
        botStatus: bot.statusCode,
        sizeRatio,
        hashMatches: false,
        outcome: "blocked",
        blockMechanism: "status",
      };
    }
  }

  return {
    url: baseline.url,
    baselineStatus: baseline.statusCode,
    botStatus: bot.statusCode,
    sizeRatio,
    hashMatches: false,
    outcome: "allowed",
    blockMechanism: null,
  };
}

function aggregateForBot(comparisons: L4UrlComparison[]): L4BotAggregate {
  const decisive = comparisons.filter(
    (c) => c.outcome !== "baseline_failed" && c.outcome !== "bot_error",
  );
  if (decisive.length === 0) return "unknown";
  const allowed = decisive.filter((c) => c.outcome === "allowed").length;
  const blocked = decisive.filter((c) => c.outcome === "blocked").length;
  if (blocked === 0) return "allowed";
  if (allowed === 0) return "blocked";
  return "mixed";
}

/**
 * Combine the raw probe results into a structured L4 result. Pure function;
 * safe to call from both the Inngest workflow and the bench probe.
 */
export function summarizeL4(args: {
  rootDomain: string;
  sample: SitemapDiscoveryResult;
  probes: L4Probe[];
}): L4Result {
  const { rootDomain, sample, probes } = args;
  const fetchedAt = new Date().toISOString();

  if (sample.urls.length === 0) {
    return {
      rootDomain,
      fetchedAt,
      status: "no_urls",
      sampleSource: sample.source,
      sampleSourceUrl: sample.sourceUrl,
      sampleUrls: [],
      baselineUserAgent: BASELINE_USER_AGENT,
      probes: [],
      perBot: BOTS.map((b) => ({
        ua: b.ua,
        platform: b.platform,
        purpose: b.purpose,
        perUrl: [],
        aggregate: "unknown" as const,
      })),
    };
  }

  const baselineByUrl = new Map<string, L4Probe>();
  const botProbesByUa = new Map<string, Map<string, L4Probe>>();
  for (const p of probes) {
    if (p.isBaseline) baselineByUrl.set(p.url, p);
    else {
      let bucket = botProbesByUa.get(p.userAgent);
      if (!bucket) {
        bucket = new Map();
        botProbesByUa.set(p.userAgent, bucket);
      }
      bucket.set(p.url, p);
    }
  }

  const anyBaselineOk = Array.from(baselineByUrl.values()).some(isBaselineOk);

  const perBot: L4BotResult[] = BOTS.map((bot) => {
    const botProbes = botProbesByUa.get(bot.ua) ?? new Map<string, L4Probe>();
    const perUrl: L4UrlComparison[] = sample.urls.map((url) => {
      const baseline = baselineByUrl.get(url);
      const botProbe = botProbes.get(url);
      if (!baseline) {
        return {
          url,
          baselineStatus: null,
          botStatus: botProbe?.statusCode ?? null,
          sizeRatio: null,
          hashMatches: false,
          outcome: "baseline_failed" as const,
          blockMechanism: null,
        };
      }
      if (!botProbe) {
        return {
          url,
          baselineStatus: baseline.statusCode,
          botStatus: null,
          sizeRatio: null,
          hashMatches: false,
          outcome: "bot_error" as const,
          blockMechanism: null,
        };
      }
      return compareToBaseline(baseline, botProbe);
    });
    return {
      ua: bot.ua,
      platform: bot.platform,
      purpose: bot.purpose,
      perUrl,
      aggregate: aggregateForBot(perUrl),
    };
  });

  const status: L4Status = anyBaselineOk ? "ok" : "baseline_failed";

  return {
    rootDomain,
    fetchedAt,
    status,
    sampleSource: sample.source,
    sampleSourceUrl: sample.sourceUrl,
    sampleUrls: sample.urls,
    baselineUserAgent: BASELINE_USER_AGENT,
    probes,
    perBot,
  };
}

/**
 * Bench-mode orchestrator: runs the full discovery + probe + summarize flow
 * using setTimeout-based politeness sleeps. Used by scripts/probe.ts and not
 * by the Inngest workflow (Inngest orchestrates step.run + step.sleep
 * directly so individual fetches are memoized across retries).
 */
export async function fetchL4Probes(
  rootDomain: string,
  sample: SitemapDiscoveryResult,
): Promise<L4Result> {
  if (sample.urls.length === 0) {
    return summarizeL4({ rootDomain, sample, probes: [] });
  }

  const probes: L4Probe[] = [];
  let first = true;
  for (const url of sample.urls) {
    if (!first) await sleep(1000);
    first = false;
    probes.push(await probeUrl(url, BASELINE_USER_AGENT, true));

    for (const bot of BOTS) {
      await sleep(1000);
      probes.push(await probeUrl(url, bot.ua, false));
    }
  }

  return summarizeL4({ rootDomain, sample, probes });
}

function sleep(ms: number): Promise<void> {
  return new Promise((resolve) => setTimeout(resolve, ms));
}
