import robotsParser from "robots-parser";
import { z } from "zod";
import { BOTS, aiPlatformSchema, botPurposeSchema } from "../ai-platforms";
import { POLITENESS, userAgent } from "../policy";
import { detectPlatform, platformDetectionSchema } from "./platform";

export const botFindingSchema = z.object({
  ua: z.string(),
  platform: aiPlatformSchema,
  purpose: botPurposeSchema,
  rootAccess: z.enum(["allowed", "blocked", "unknown"]),
  matchedLineNumber: z.number().nullable(),
  matchedRule: z.string().nullable(),
  crawlDelay: z.number().nullable(),
});

// Runtime schema for the persisted L1 signal. Source of truth.
export const robotsLayer1ResultSchema = z.object({
  rootDomain: z.string(),
  fetchedAt: z.string(),
  fetchUrl: z.string(),
  fetchUserAgent: z.string(),
  status: z.enum(["ok", "not_found", "error"]),
  httpStatus: z.number().nullable(),
  rawText: z.string().nullable(),
  errorMessage: z.string().optional(),
  sitemaps: z.array(z.string()),
  platform: platformDetectionSchema,
  perBot: z.array(botFindingSchema),
});

export type BotFinding = z.infer<typeof botFindingSchema>;
export type RobotsLayer1Result = z.infer<typeof robotsLayer1ResultSchema>;

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
