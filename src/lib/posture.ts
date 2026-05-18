/**
 * S4b — Per-platform posture from layered evidence.
 *
 * Replaces the L1-only posture derivation that shipped in S2. Combines:
 *   - L1 (robots.txt)         — per-bot publisher claim
 *   - L2 (HTTP / HTML decls)  — per-bot or site-wide policy signals
 *   - L3 (CDN / WAF)          — capacity for edge-level blocking
 *   - L4 (UA probing)         — per-bot server reality
 *   - L5 (Common Crawl)       — training-corpus presence
 *
 * Rule highlights (decided 2026-05; see CLAUDE.md and S4b golden cases):
 *
 *   1. Server reality (L4) wins. When L4 has a decisive per-bot aggregate
 *      (allowed / blocked), it overrides L1 for that bot. L4 mixed or
 *      unknown falls back to L1.
 *
 *   2. Edge-block special case. When L1 unreadable + L2 errored + L4
 *      baseline failed + L3 detects a CDN, every platform's posture
 *      collapses to `blocked` regardless of access fields — the WAF is
 *      functionally blocking everyone.
 *
 *   3. Site-wide layers (L3, L5) modify confidence only, never direction.
 *      L5 absent or low → training-confidence penalty; L5 high → bump.
 *      L3 detects CDN + L1 permissive + no L4 → silent-block-risk penalty.
 *
 *   4. L4-couldn't-verify penalty. When L4 ran but failed
 *      (baseline_failed / no_urls / error) AND the edge-block pattern
 *      doesn't fire, confidence drops to `low`. Without independent
 *      confirmation, L1 alone shouldn't read as a confident verdict —
 *      surfaces honestly that the publisher's stated policy is
 *      unverified rather than endorsed. (See prnewsonline.com case,
 *      where Vercel's datacenter IPs are blanket-banned by the publisher's
 *      WAF, so prod can never verify the L1 claim.)
 *
 *   5. Confidence is an integer 0–100; a band (low/medium/high) is derived
 *      for display.
 */

import {
  BOTS,
  PLATFORMS,
  type AiPlatform,
  type BotPurpose,
} from "./ai-platforms";
import type { AccessState, AggregatePosture } from "./db/schema";
import type { RobotsLayer1Result } from "./layers/robots";
import type { L2Result } from "./layers/declarations";
import type { L3Result } from "./layers/cdn";
import type { L4BotAggregate, L4Result } from "./layers/ua-probing";
import type { L5Result } from "./layers/common-crawl";

export type ConfidenceBand = "low" | "medium" | "high";

export type PerPlatformPosture = {
  platform: AiPlatform;
  trainingAccess: AccessState;
  realtimeAccess: AccessState;
  searchAccess: AccessState;
  aggregatePosture: AggregatePosture;
  confidence: number;
  confidenceBand: ConfidenceBand;
};

export type PostureInputs = {
  layer1Signal: RobotsLayer1Result | null;
  layer2Signal: L2Result | null;
  layer3Signal: L3Result | null;
  layer4Signal: L4Result | null;
  layer5Signal: L5Result | null;
};

type BotAccess = "allowed" | "blocked" | "unknown";

function combineBotAccess(
  l1Access: BotAccess,
  l4Aggregate: L4BotAggregate | undefined,
): BotAccess {
  if (l4Aggregate === "allowed") return "allowed";
  if (l4Aggregate === "blocked") return "blocked";
  if (l4Aggregate === "mixed") return "unknown";
  return l1Access;
}

function summarizeAccess(states: BotAccess[]): AccessState {
  if (states.length === 0) return "unknown";
  if (states.every((s) => s === "allowed")) return "allowed";
  if (states.every((s) => s === "blocked")) return "blocked";
  return "unknown";
}

function derivePostureDirection(
  training: AccessState,
  realtime: AccessState,
  search: AccessState,
): AggregatePosture {
  const known = [training, realtime, search].filter(
    (s): s is "allowed" | "blocked" => s !== "unknown",
  );
  if (known.length === 0) return "unknown";
  if (known.every((s) => s === "allowed")) return "open";
  if (known.every((s) => s === "blocked")) return "blocked";
  return "mixed";
}

function isEdgeBlockPattern(args: PostureInputs): boolean {
  const { layer1Signal, layer2Signal, layer3Signal, layer4Signal } = args;
  const l1Unreadable = !layer1Signal || layer1Signal.status === "error";
  const l2Errored = layer2Signal?.homepage.status === "error";
  const l3HasCdn = (layer3Signal?.detected.length ?? 0) > 0;
  // L4 "no_urls" and "baseline_failed" both mean our crawler couldn't probe
  // articles — the former when sitemap discovery itself was blocked, the
  // latter when probing got past discovery but the baseline UA was rejected.
  // For WAF-protected sites (e.g. Cloudflare managed challenge) the former
  // is the common shape.
  const l4CouldntProbe =
    layer4Signal?.status === "baseline_failed" ||
    layer4Signal?.status === "no_urls";
  return Boolean(l1Unreadable && l2Errored && l3HasCdn && l4CouldntProbe);
}

export function confidenceBand(score: number): ConfidenceBand {
  if (score < 40) return "low";
  if (score < 70) return "medium";
  return "high";
}

type ConfidenceParts = {
  l1HasSignal: boolean;
  l4HasSignal: boolean;
  // True when L4 ran but couldn't produce a verification (baseline_failed,
  // no_urls, or error) AND the edge-block pattern didn't fire to claim
  // that case as evidence in its own right. In this state we have no
  // independent confirmation of L1's claim — confidence should drop to
  // `low` so the top-line doesn't read as if L1 alone is sufficient.
  l4CouldntVerify: boolean;
  agreeCount: number;
  disagreeCount: number;
  edgeBlocked: boolean;
  l3HasCdnAndL1PermissiveAndNoL4: boolean;
  l5HelpsTraining: boolean;
  l5HurtsTraining: boolean;
};

function computeConfidence(parts: ConfidenceParts): number {
  let score = 50;
  if (parts.edgeBlocked) score += 20;
  if (parts.l1HasSignal) score += 10;
  if (parts.l4HasSignal) score += 25;
  if (parts.agreeCount > 0 && parts.disagreeCount === 0) score += 10;
  if (parts.disagreeCount > 0) score -= 5;
  if (parts.l3HasCdnAndL1PermissiveAndNoL4) score -= 10;
  if (parts.l5HelpsTraining) score += 5;
  if (parts.l5HurtsTraining) score -= 5;
  if (parts.l4CouldntVerify) score -= 25;
  return Math.max(0, Math.min(100, score));
}

export function derivePostures(args: PostureInputs): PerPlatformPosture[] {
  const { layer1Signal, layer3Signal, layer4Signal, layer5Signal } = args;
  const edgeBlocked = isEdgeBlockPattern(args);

  const l1ByUa = new Map<string, BotAccess>();
  if (layer1Signal) {
    for (const bot of layer1Signal.perBot) {
      l1ByUa.set(bot.ua, bot.rootAccess);
    }
  }
  const l4ByUa = new Map<string, L4BotAggregate>();
  if (layer4Signal && layer4Signal.status === "ok") {
    for (const bot of layer4Signal.perBot) {
      l4ByUa.set(bot.ua, bot.aggregate);
    }
  }

  let agreeCount = 0;
  let disagreeCount = 0;
  for (const bot of BOTS) {
    const l1 = l1ByUa.get(bot.ua);
    const l4 = l4ByUa.get(bot.ua);
    if (!l1 || !l4) continue;
    if (l4 !== "allowed" && l4 !== "blocked") continue;
    if (l1 === "unknown") continue;
    if (l1 === l4) agreeCount++;
    else disagreeCount++;
  }

  const l1HasSignal =
    !!layer1Signal &&
    (layer1Signal.status === "ok" || layer1Signal.status === "not_found");
  const l4HasSignal = layer4Signal?.status === "ok";
  // L4 ran but couldn't verify — e.g. publisher's WAF blanket-bans
  // datacenter IPs (prnewsonline.com pattern), or sample discovery
  // found no probeable URLs. Only penalize when the edge-block pattern
  // isn't already firing; that pattern has its own specific story.
  const l4CouldntVerify =
    !edgeBlocked &&
    layer4Signal !== null &&
    layer4Signal.status !== "ok";

  const l3HasCdn = (layer3Signal?.detected.length ?? 0) > 0;
  const l1IsPermissive =
    !!layer1Signal && layer1Signal.perBot.some((b) => b.rootAccess === "allowed");
  const l3HasCdnAndL1PermissiveAndNoL4 =
    l3HasCdn && l1IsPermissive && !l4HasSignal;

  const l5Bucket = layer5Signal?.coverageBucket;
  const l5HelpsTraining = l5Bucket === "moderate" || l5Bucket === "high";
  const l5HurtsTraining = l5Bucket === "absent";

  return PLATFORMS.map((platform): PerPlatformPosture => {
    const platformBots = BOTS.filter((b) => b.platform === platform);
    const accessFor = (purpose: BotPurpose): AccessState =>
      summarizeAccess(
        platformBots
          .filter((b) => b.purpose === purpose)
          .map((b) =>
            combineBotAccess(l1ByUa.get(b.ua) ?? "unknown", l4ByUa.get(b.ua)),
          ),
      );

    const trainingAccess = accessFor("training");
    const realtimeAccess = accessFor("realtime");
    const searchAccess = accessFor("search");

    const direction = derivePostureDirection(
      trainingAccess,
      realtimeAccess,
      searchAccess,
    );
    const aggregatePosture: AggregatePosture = edgeBlocked
      ? "blocked"
      : direction;

    const confidence = computeConfidence({
      l1HasSignal,
      l4HasSignal,
      l4CouldntVerify,
      agreeCount,
      disagreeCount,
      edgeBlocked,
      l3HasCdnAndL1PermissiveAndNoL4,
      l5HelpsTraining,
      l5HurtsTraining,
    });

    return {
      platform,
      trainingAccess,
      realtimeAccess,
      searchAccess,
      aggregatePosture,
      confidence,
      confidenceBand: confidenceBand(confidence),
    };
  });
}
