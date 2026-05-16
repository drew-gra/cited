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
import { BASELINE_USER_AGENT, POLITENESS } from "../policy";
import { BOTS, type AiPlatform, type BotPurpose } from "../ai-platforms";
import type { SitemapDiscoveryResult, SitemapSource } from "./sitemap";

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

export type L4Probe = {
  url: string;
  userAgent: string;
  isBaseline: boolean;
  statusCode: number | null;
  finalUrl: string | null;
  responseSizeBytes: number | null;
  contentHash: string | null;
  errorMessage?: string;
  durationMs: number;
};

export type L4ComparisonOutcome =
  | "allowed"
  | "blocked"
  | "bot_error"
  | "baseline_failed";

export type L4UrlComparison = {
  url: string;
  baselineStatus: number | null;
  botStatus: number | null;
  sizeRatio: number | null;
  hashMatches: boolean;
  outcome: L4ComparisonOutcome;
};

export type L4BotAggregate = "allowed" | "blocked" | "mixed" | "unknown";

export type L4BotResult = {
  ua: string;
  platform: AiPlatform;
  purpose: BotPurpose;
  perUrl: L4UrlComparison[];
  aggregate: L4BotAggregate;
};

export type L4Status = "ok" | "no_urls" | "baseline_failed" | "error";

export type L4Result = {
  rootDomain: string;
  fetchedAt: string;
  status: L4Status;
  errorMessage?: string;
  sampleSource: SitemapSource;
  sampleSourceUrl: string | null;
  sampleUrls: string[];
  baselineUserAgent: string;
  probes: L4Probe[];
  perBot: L4BotResult[];
};

/**
 * Fetch a URL with a specific user agent. Reads at most MAX_BODY_BYTES so a
 * single multi-megabyte article doesn't blow out memory across 50 probes.
 * The captured `responseSizeBytes` is the bytes actually read (post-cap);
 * that's consistent across probes so comparison is meaningful, and the cap
 * is well above the typical paywall-stub size we want to detect.
 */
export async function probeUrl(
  url: string,
  ua: string,
  isBaseline: boolean,
): Promise<L4Probe> {
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
      url,
      userAgent: ua,
      isBaseline,
      statusCode: res.status,
      finalUrl: res.url || url,
      responseSizeBytes: buf.length,
      contentHash: hash,
      durationMs: Date.now() - startedAt,
    };
  } catch (err) {
    return {
      url,
      userAgent: ua,
      isBaseline,
      statusCode: null,
      finalUrl: null,
      responseSizeBytes: null,
      contentHash: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      durationMs: Date.now() - startedAt,
    };
  }
}

function isBaselineOk(p: L4Probe): boolean {
  return p.statusCode !== null && p.statusCode >= 200 && p.statusCode < 400;
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
