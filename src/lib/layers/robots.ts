import robotsParser from "robots-parser";
import { BOTS, type AiPlatform, type BotPurpose } from "../ai-platforms";
import { POLITENESS, userAgent } from "../policy";
import { detectPlatform, type PlatformDetection } from "./platform";

export type BotFinding = {
  ua: string;
  platform: AiPlatform;
  purpose: BotPurpose;
  rootAccess: "allowed" | "blocked" | "unknown";
  matchedLineNumber: number | null;
  matchedRule: string | null;
  crawlDelay: number | null;
};

export type RobotsLayer1Result = {
  rootDomain: string;
  fetchedAt: string;
  fetchUrl: string;
  fetchUserAgent: string;
  status: "ok" | "not_found" | "error";
  httpStatus: number | null;
  rawText: string | null;
  errorMessage?: string;
  sitemaps: string[];
  platform: PlatformDetection;
  perBot: BotFinding[];
};

function unknownFindings(): BotFinding[] {
  return BOTS.map((bot) => ({
    ua: bot.ua,
    platform: bot.platform,
    purpose: bot.purpose,
    rootAccess: "unknown",
    matchedLineNumber: null,
    matchedRule: null,
    crawlDelay: null,
  }));
}

function allowedFindings(): BotFinding[] {
  return BOTS.map((bot) => ({
    ua: bot.ua,
    platform: bot.platform,
    purpose: bot.purpose,
    rootAccess: "allowed",
    matchedLineNumber: null,
    matchedRule: null,
    crawlDelay: null,
  }));
}

export async function fetchAndParseRobots(
  rootDomain: string,
): Promise<RobotsLayer1Result> {
  const fetchUrl = `https://${rootDomain}/robots.txt`;
  const fetchedAt = new Date().toISOString();
  const fetchUserAgent = userAgent();

  let res: Response;
  try {
    res = await fetch(fetchUrl, {
      headers: { "User-Agent": fetchUserAgent },
      redirect: "follow",
      signal: AbortSignal.timeout(POLITENESS.fetchTimeoutMs),
    });
  } catch (err) {
    return {
      rootDomain,
      fetchedAt,
      fetchUrl,
      fetchUserAgent,
      status: "error",
      httpStatus: null,
      rawText: null,
      errorMessage: err instanceof Error ? err.message : String(err),
      sitemaps: [],
      platform: detectPlatform(null),
      perBot: unknownFindings(),
    };
  }

  if (res.status === 404) {
    return {
      rootDomain,
      fetchedAt,
      fetchUrl,
      fetchUserAgent,
      status: "not_found",
      httpStatus: 404,
      rawText: null,
      sitemaps: [],
      platform: detectPlatform(null),
      perBot: allowedFindings(),
    };
  }

  if (!res.ok) {
    return {
      rootDomain,
      fetchedAt,
      fetchUrl,
      fetchUserAgent,
      status: "error",
      httpStatus: res.status,
      rawText: null,
      errorMessage: `HTTP ${res.status}`,
      sitemaps: [],
      platform: detectPlatform(null),
      perBot: unknownFindings(),
    };
  }

  const rawText = await res.text();
  const robots = robotsParser(fetchUrl, rawText);
  const homepageUrl = `https://${rootDomain}/`;
  const lines = rawText.split(/\r?\n/);

  const perBot: BotFinding[] = BOTS.map((bot) => {
    const allowed = robots.isAllowed(homepageUrl, bot.ua);
    const lineNumber = robots.getMatchingLineNumber(homepageUrl, bot.ua);
    const matchedLineNumber = lineNumber > 0 ? lineNumber : null;
    const matchedRule =
      matchedLineNumber !== null
        ? (lines[matchedLineNumber - 1] ?? null)
        : null;
    const crawlDelay = robots.getCrawlDelay(bot.ua) ?? null;
    return {
      ua: bot.ua,
      platform: bot.platform,
      purpose: bot.purpose,
      rootAccess:
        allowed === undefined
          ? "unknown"
          : allowed
            ? "allowed"
            : "blocked",
      matchedLineNumber,
      matchedRule,
      crawlDelay,
    };
  });

  return {
    rootDomain,
    fetchedAt,
    fetchUrl,
    fetchUserAgent,
    status: "ok",
    httpStatus: res.status,
    rawText,
    sitemaps: robots.getSitemaps(),
    platform: detectPlatform(rawText),
    perBot,
  };
}
