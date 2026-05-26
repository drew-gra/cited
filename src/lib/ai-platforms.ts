import { z } from "zod";

export const PLATFORMS = [
  "anthropic",
  "openai",
  "perplexity",
  "google",
  "common_crawl",
] as const;
export const aiPlatformSchema = z.enum(PLATFORMS);
export type AiPlatform = z.infer<typeof aiPlatformSchema>;

export const botPurposeSchema = z.enum(["training", "realtime", "search"]);
export type BotPurpose = z.infer<typeof botPurposeSchema>;

export type Bot = {
  ua: string;
  platform: AiPlatform;
  purpose: BotPurpose;
};

// v1 bot list. Strings must match what each AI company publishes — verify
// against vendor docs before deploying. Anthropic's `Claude-SearchBot` in
// particular needs verification (the search-specific bot's name has shifted).
export const BOTS: ReadonlyArray<Bot> = [
  { ua: "GPTBot", platform: "openai", purpose: "training" },
  { ua: "ChatGPT-User", platform: "openai", purpose: "realtime" },
  { ua: "OAI-SearchBot", platform: "openai", purpose: "search" },
  { ua: "ClaudeBot", platform: "anthropic", purpose: "training" },
  { ua: "Claude-User", platform: "anthropic", purpose: "realtime" },
  { ua: "Claude-SearchBot", platform: "anthropic", purpose: "search" },
  { ua: "Google-Extended", platform: "google", purpose: "training" },
  { ua: "PerplexityBot", platform: "perplexity", purpose: "training" },
  { ua: "Perplexity-User", platform: "perplexity", purpose: "realtime" },
  { ua: "CCBot", platform: "common_crawl", purpose: "training" },
];

export const PLATFORM_LABELS: Record<AiPlatform, string> = {
  openai: "OpenAI",
  anthropic: "Anthropic",
  google: "Google",
  perplexity: "Perplexity",
  common_crawl: "Common Crawl",
};

export function botsForPlatform(platform: AiPlatform): Bot[] {
  return BOTS.filter((bot) => bot.platform === platform);
}
