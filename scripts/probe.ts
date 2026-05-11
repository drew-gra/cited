/**
 * Ad-hoc probe — runs Layer 1 (robots.txt) against one or more domains and
 * prints either a per-domain detail block (default) or a compact one-line-
 * per-domain table (--brief). No DB, no queue, no Inngest. Same
 * fetchAndParseRobots() the production pipeline uses.
 *
 * Usage:
 *   npx tsx scripts/probe.ts nytimes.com washingtonpost.com
 *   npx tsx scripts/probe.ts --brief nytimes.com vox.com substack.com ...
 */

import { fetchAndParseRobots } from "../src/lib/layers/robots";
import { fetchL2 } from "../src/lib/layers/declarations";
import {
  PLATFORMS,
  PLATFORM_LABELS,
  type AiPlatform,
} from "../src/lib/ai-platforms";

type Access = "allowed" | "blocked" | "unknown";

function summarize(states: Access[]): Access {
  if (states.length === 0) return "unknown";
  if (states.every((s) => s === "allowed")) return "allowed";
  if (states.every((s) => s === "blocked")) return "blocked";
  return "unknown";
}

function derivePosture(t: Access, r: Access, s: Access) {
  const known = [t, r, s].filter((x): x is "allowed" | "blocked" => x !== "unknown");
  if (known.length === 0) return "unknown";
  if (known.every((x) => x === "allowed")) return "open";
  if (known.every((x) => x === "blocked")) return "blocked";
  return "mixed";
}

function normalizeDomain(input: string): string {
  return input
    .trim()
    .replace(/^https?:\/\//i, "")
    .replace(/^www\./i, "")
    .replace(/\/.*$/, "")
    .toLowerCase();
}

async function probe(domain: string) {
  const root = normalizeDomain(domain);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${root}`);
  console.log("=".repeat(72));

  const result = await fetchAndParseRobots(root);
  console.log(
    `  fetch ${result.fetchUrl} → ${result.status}${
      result.httpStatus ? ` (HTTP ${result.httpStatus})` : ""
    }`,
  );
  if (result.errorMessage) {
    console.log(`  error: ${result.errorMessage}`);
  }
  if (result.sitemaps.length > 0) {
    console.log(`  sitemaps declared: ${result.sitemaps.length}`);
  }
  if (result.platform.platform !== "unknown") {
    const tag = result.platform.isDefault
      ? `${result.platform.platform} (platform default)`
      : `${result.platform.platform}`;
    console.log(`  platform: ${tag}`);
    console.log(`    ${result.platform.note}`);
  }

  for (const platform of PLATFORMS as readonly AiPlatform[]) {
    const platformBots = result.perBot.filter((b) => b.platform === platform);
    const trainingAccess = summarize(
      platformBots.filter((b) => b.purpose === "training").map((b) => b.rootAccess),
    );
    const realtimeAccess = summarize(
      platformBots.filter((b) => b.purpose === "realtime").map((b) => b.rootAccess),
    );
    const searchAccess = summarize(
      platformBots.filter((b) => b.purpose === "search").map((b) => b.rootAccess),
    );
    const posture = derivePosture(trainingAccess, realtimeAccess, searchAccess);

    console.log(`\n  ${PLATFORM_LABELS[platform]} — ${posture.toUpperCase()}`);
    console.log(
      `    training=${trainingAccess}  realtime=${realtimeAccess}  search=${searchAccess}`,
    );

    for (const bot of platformBots) {
      const rule = bot.matchedRule
        ? ` · line ${bot.matchedLineNumber}: ${bot.matchedRule.trim()}`
        : bot.rootAccess === "allowed"
          ? " · no matching rule (allowed by default)"
          : "";
      const delay = bot.crawlDelay !== null ? ` · crawl-delay=${bot.crawlDelay}s` : "";
      console.log(
        `      ${bot.ua.padEnd(22)} ${bot.purpose.padEnd(10)} ${bot.rootAccess.padEnd(8)}${rule}${delay}`,
      );
    }
  }
}

async function probeBrief(domain: string) {
  const root = normalizeDomain(domain);
  let result;
  try {
    result = await fetchAndParseRobots(root);
  } catch (err) {
    console.log(
      `${root.padEnd(48)} ${"(threw)".padEnd(22)} ${err instanceof Error ? err.message : String(err)}`,
    );
    return;
  }

  const platformLabel =
    result.platform.platform === "unknown"
      ? "—"
      : result.platform.isDefault
        ? `${result.platform.platform} (default)`
        : result.platform.platform;

  if (result.status === "error") {
    console.log(
      `${root.padEnd(48)} ${platformLabel.padEnd(22)} (fetch error: ${result.errorMessage ?? "unknown"})`,
    );
    return;
  }

  const posturePerPlatform: Record<string, string> = {};
  for (const p of PLATFORMS) {
    const bots = result.perBot.filter((b) => b.platform === p);
    const t = summarize(
      bots.filter((b) => b.purpose === "training").map((b) => b.rootAccess),
    );
    const r = summarize(
      bots.filter((b) => b.purpose === "realtime").map((b) => b.rootAccess),
    );
    const s = summarize(
      bots.filter((b) => b.purpose === "search").map((b) => b.rootAccess),
    );
    posturePerPlatform[p] = derivePosture(t, r, s);
  }

  const cells = (PLATFORMS as readonly AiPlatform[])
    .map((p) => posturePerPlatform[p].padEnd(8))
    .join(" ");
  console.log(`${root.padEnd(48)} ${platformLabel.padEnd(22)} ${cells}`);
}

function printBriefHeader() {
  const cols = (PLATFORMS as readonly AiPlatform[])
    .map((p) =>
      ({
        openai: "OpenAI",
        anthropic: "Anthropic",
        google: "Google",
        perplexity: "Perplexity",
        common_crawl: "CommonCr.",
      })[p].padEnd(8),
    )
    .join(" ");
  console.log(`${"domain".padEnd(48)} ${"platform".padEnd(22)} ${cols}`);
  console.log("-".repeat(48 + 1 + 22 + 1 + cols.length));
}

async function probeL2Detailed(domain: string) {
  const root = normalizeDomain(domain);
  console.log(`\n${"=".repeat(72)}`);
  console.log(`  ${root}`);
  console.log("=".repeat(72));

  const result = await fetchL2(root);
  if (result.homepage.status === "error") {
    console.log(
      `  homepage: ${result.homepage.fetchedUrl} → error${
        result.homepage.httpStatus ? ` (HTTP ${result.homepage.httpStatus})` : ""
      }${result.homepage.errorMessage ? ` (${result.homepage.errorMessage})` : ""}`,
    );
  } else {
    console.log(
      `  homepage:           ${result.homepage.fetchedUrl} → HTTP ${result.homepage.httpStatus}`,
    );
    console.log(
      `  X-Robots-Tag:       ${result.homepage.xRobotsTag ?? "—"}`,
    );
    console.log(`  meta robots:        ${result.homepage.metaRobots ?? "—"}`);
    if (Object.keys(result.homepage.aiMetaTags).length > 0) {
      for (const [name, value] of Object.entries(result.homepage.aiMetaTags)) {
        console.log(`  meta ${name.padEnd(14)} ${value}`);
      }
    } else {
      console.log(`  AI bot meta tags:   —`);
    }
    if (result.homepage.aiContentDeclaration) {
      console.log(
        `  ai-content-decl:    ${result.homepage.aiContentDeclaration}`,
      );
    }
  }
  const llmsLabel =
    result.llmsTxt.state === "present"
      ? `present (HTTP ${result.llmsTxt.httpStatus}, ${result.llmsTxt.sizeBytes} bytes)`
      : result.llmsTxt.state === "error"
        ? `error${result.llmsTxt.errorMessage ? ` (${result.llmsTxt.errorMessage})` : ""}`
        : `absent (HTTP ${result.llmsTxt.httpStatus ?? "?"})`;
  console.log(`  llms.txt:           ${llmsLabel}`);
}

async function probeL2Brief(domain: string) {
  const root = normalizeDomain(domain);
  let result;
  try {
    result = await fetchL2(root);
  } catch (err) {
    console.log(
      `${root.padEnd(34)} (threw: ${err instanceof Error ? err.message : String(err)})`,
    );
    return;
  }
  if (result.homepage.status === "error") {
    console.log(
      `${root.padEnd(34)} (homepage error: ${
        result.homepage.errorMessage ?? `HTTP ${result.homepage.httpStatus}`
      })`,
    );
    return;
  }
  const xRobots = result.homepage.xRobotsTag
    ? compact(result.homepage.xRobotsTag, 24)
    : "—";
  const metaRobots = result.homepage.metaRobots
    ? compact(result.homepage.metaRobots, 28)
    : "—";
  const aiMetaCount = Object.keys(result.homepage.aiMetaTags).length;
  const aiMeta =
    aiMetaCount > 0
      ? Object.entries(result.homepage.aiMetaTags)
          .map(([k, v]) => `${k}=${v.split(",")[0].trim()}`)
          .join("; ")
      : "—";
  const llmsLabel =
    result.llmsTxt.state === "present"
      ? `present (${result.llmsTxt.sizeBytes}B)`
      : result.llmsTxt.state === "error"
        ? "error"
        : "absent";
  console.log(
    `${root.padEnd(34)} ${xRobots.padEnd(26)} ${metaRobots.padEnd(30)} ${aiMeta.padEnd(28)} ${llmsLabel}`,
  );
}

function compact(s: string, max: number): string {
  const oneLine = s.replace(/\s+/g, " ").trim();
  return oneLine.length > max ? oneLine.slice(0, max - 1) + "…" : oneLine;
}

function printL2BriefHeader() {
  console.log(
    `${"domain".padEnd(34)} ${"x-robots-tag".padEnd(26)} ${"meta robots".padEnd(30)} ${"ai-meta tags".padEnd(28)} llms.txt`,
  );
  console.log("-".repeat(34 + 1 + 26 + 1 + 30 + 1 + 28 + 1 + 20));
}

async function main() {
  const args = process.argv.slice(2);
  const brief = args.includes("--brief");
  const l2 = args.includes("--l2");
  const domains = args.filter((a) => a !== "--brief" && a !== "--l2");

  if (domains.length === 0) {
    console.error(
      "Usage: npx tsx scripts/probe.ts [--brief] [--l2] <domain> [<domain> ...]\n" +
        "  default              L1 detailed (per-outlet block)\n" +
        "  --brief              L1 compact one-line table\n" +
        "  --l2                 L2 detailed (per-outlet block)\n" +
        "  --l2 --brief         L2 compact one-line table",
    );
    process.exit(1);
  }

  if (l2 && brief) printL2BriefHeader();
  else if (brief) printBriefHeader();

  for (const domain of domains) {
    try {
      if (l2 && brief) await probeL2Brief(domain);
      else if (l2) await probeL2Detailed(domain);
      else if (brief) await probeBrief(domain);
      else await probe(domain);
    } catch (err) {
      console.error(
        `\n  ${domain}: probe threw — ${err instanceof Error ? err.message : String(err)}`,
      );
    }
  }
  console.log("");
}

main().catch((err) => {
  console.error(err);
  process.exit(1);
});
