/**
 * Per-layer verdicts in a uniform shape, drawn from a strict shared
 * vocabulary. Each layer's raw evidence (heterogeneous, layer-specific)
 * is translated by a pure function into this common form so that:
 *
 *  - The result UI can render every layer's verdict the same way.
 *  - The future S4b posture rule table can consume verdicts as inputs.
 *  - Downstream API consumers don't have to learn five different shapes.
 *
 * Translators are pure and computed on read; verdicts are NOT persisted
 * in the DB. If a translator's logic changes, the next API read picks up
 * the new classification automatically.
 */

import type { RobotsLayer1Result } from "./layers/robots";
import type { L2Result } from "./layers/declarations";
import type { L3Result } from "./layers/cdn";
import type { L5Result } from "./layers/common-crawl";

export type LayerNumber = 1 | 2 | 3 | 4 | 5;

/**
 * Strict vocabulary for layer findings.
 * - permissive — evidence points toward AI access being granted.
 * - restrictive — evidence points toward AI access being denied.
 * - mixed — signals within the layer point different directions.
 * - contextual — layer characterizes capacity/identity, not direction.
 * - inconclusive — layer couldn't be evaluated or has insufficient data.
 */
export type LayerFinding =
  | "permissive"
  | "restrictive"
  | "mixed"
  | "contextual"
  | "inconclusive";

export type VerdictConfidence = "low" | "medium" | "high";
export type LayerVerdictStatus = "ok" | "no_data" | "error";

export type LayerVerdict = {
  layer: LayerNumber;
  status: LayerVerdictStatus;
  finding: LayerFinding;
  headline: string;
  confidence: VerdictConfidence;
};

export const FINDING_LABEL: Record<LayerFinding, string> = {
  permissive: "Permissive",
  restrictive: "Restrictive",
  mixed: "Mixed",
  contextual: "Contextual",
  inconclusive: "Inconclusive",
};

// ---------------------------------------------------------------------------
// Layer 1 — robots.txt
// ---------------------------------------------------------------------------

export function verdictForLayer1(
  signal: RobotsLayer1Result | null,
): LayerVerdict {
  if (!signal) {
    return {
      layer: 1,
      status: "no_data",
      finding: "inconclusive",
      headline: "No robots.txt evidence available.",
      confidence: "low",
    };
  }
  if (signal.status === "error") {
    return {
      layer: 1,
      status: "error",
      finding: "inconclusive",
      headline: `robots.txt unreachable (${signal.errorMessage ?? "unknown error"}).`,
      confidence: "low",
    };
  }
  if (signal.status === "not_found") {
    return {
      layer: 1,
      status: "ok",
      finding: "permissive",
      headline:
        "No /robots.txt at this domain; AI bots allowed by convention.",
      confidence: "medium",
    };
  }

  const counts = { allowed: 0, blocked: 0, unknown: 0 };
  for (const bot of signal.perBot) {
    counts[bot.rootAccess]++;
  }
  const total = signal.perBot.length;

  if (total === 0 || counts.unknown === total) {
    return {
      layer: 1,
      status: "ok",
      finding: "inconclusive",
      headline:
        "robots.txt fetched but no rules apply to any assessed AI bot.",
      confidence: "low",
    };
  }
  if (counts.blocked === 0 && counts.allowed > 0) {
    return {
      layer: 1,
      status: "ok",
      finding: "permissive",
      headline: "All assessed AI bots allowed by robots.txt.",
      confidence: "high",
    };
  }
  if (counts.allowed === 0 && counts.blocked > 0) {
    return {
      layer: 1,
      status: "ok",
      finding: "restrictive",
      headline: "All assessed AI bots disallowed by robots.txt.",
      confidence: "high",
    };
  }
  return {
    layer: 1,
    status: "ok",
    finding: "mixed",
    headline: `${counts.allowed} AI bot${counts.allowed === 1 ? "" : "s"} allowed, ${counts.blocked} blocked at robots.txt.`,
    confidence: "high",
  };
}

// ---------------------------------------------------------------------------
// Layer 2 — HTTP / HTML declarations + llms.txt
// ---------------------------------------------------------------------------

export function verdictForLayer2(signal: L2Result | null): LayerVerdict {
  if (!signal) {
    return {
      layer: 2,
      status: "no_data",
      finding: "inconclusive",
      headline: "No Layer 2 evidence available.",
      confidence: "low",
    };
  }
  if (signal.homepage.status === "error") {
    return {
      layer: 2,
      status: "error",
      finding: "inconclusive",
      headline: `Homepage unreachable (${signal.homepage.errorMessage ?? "unknown error"}).`,
      confidence: "low",
    };
  }

  const aiMetaEntries = Object.entries(signal.homepage.aiMetaTags);
  const restrictiveMeta = aiMetaEntries.some(([, value]) =>
    /noindex|nofollow|nosnippet|noarchive|noai|noimageai/i.test(value),
  );
  const xRobotsRestrictive =
    signal.homepage.xRobotsTag !== null &&
    /noai|noimageai|noindex|nofollow|nosnippet|noarchive/i.test(
      signal.homepage.xRobotsTag,
    );
  const llmsTxtPresent = signal.llmsTxt.state === "present";

  if (restrictiveMeta || xRobotsRestrictive) {
    if (llmsTxtPresent) {
      return {
        layer: 2,
        status: "ok",
        finding: "mixed",
        headline:
          "Publisher exposes /llms.txt but also restricts some AI bots via headers or meta tags.",
        confidence: "medium",
      };
    }
    return {
      layer: 2,
      status: "ok",
      finding: "restrictive",
      headline:
        "Publisher signals AI restrictions via meta tags or X-Robots-Tag.",
      confidence: "high",
    };
  }

  if (llmsTxtPresent) {
    return {
      layer: 2,
      status: "ok",
      finding: "permissive",
      headline: `Publisher publishes /llms.txt (${signal.llmsTxt.sizeBytes ?? "?"} bytes); actively discoverable to AI.`,
      confidence: "high",
    };
  }

  return {
    layer: 2,
    status: "ok",
    finding: "permissive",
    headline: "No additional AI restrictions beyond robots.txt.",
    confidence: "low",
  };
}

// ---------------------------------------------------------------------------
// Layer 3 — CDN fingerprint (always contextual)
// ---------------------------------------------------------------------------

export function verdictForLayer3(signal: L3Result | null): LayerVerdict {
  if (!signal) {
    return {
      layer: 3,
      status: "no_data",
      finding: "inconclusive",
      headline: "No Layer 3 evidence available.",
      confidence: "low",
    };
  }
  if (signal.detected.length === 0) {
    return {
      layer: 3,
      status: "ok",
      finding: "contextual",
      headline:
        "No known CDN signature detected; site appears origin-served or behind an unrecognized provider.",
      confidence: "low",
    };
  }
  const cdnList = signal.detected.join(", ");
  return {
    layer: 3,
    status: "ok",
    finding: "contextual",
    headline: `Behind ${cdnList}; capacity for edge-level AI-bot blocking exists.`,
    confidence: "medium",
  };
}

// ---------------------------------------------------------------------------
// Layer 4 — UA probing (not yet implemented)
// ---------------------------------------------------------------------------

export function verdictForLayer4(): LayerVerdict {
  return {
    layer: 4,
    status: "no_data",
    finding: "inconclusive",
    headline: "Layer 4 (UA probing) not yet implemented.",
    confidence: "low",
  };
}

// ---------------------------------------------------------------------------
// Layer 5 — Common Crawl presence
// ---------------------------------------------------------------------------

export function verdictForLayer5(signal: L5Result | null): LayerVerdict {
  if (!signal) {
    return {
      layer: 5,
      status: "no_data",
      finding: "inconclusive",
      headline: "No Layer 5 evidence available.",
      confidence: "low",
    };
  }
  if (signal.indexesQueried === 0) {
    return {
      layer: 5,
      status: "error",
      finding: "inconclusive",
      headline: "Common Crawl CDX API unreachable.",
      confidence: "low",
    };
  }
  switch (signal.coverageBucket) {
    case "absent":
      return {
        layer: 5,
        status: "ok",
        finding: "restrictive",
        headline: "Domain absent from recent Common Crawl indexes.",
        confidence: "high",
      };
    case "low":
      return {
        layer: 5,
        status: "ok",
        finding: "contextual",
        headline:
          "Sparse Common Crawl coverage; could indicate blocking, a small site, or both.",
        confidence: "low",
      };
    case "moderate":
      return {
        layer: 5,
        status: "ok",
        finding: "permissive",
        headline: "Moderate Common Crawl presence across recent indexes.",
        confidence: "medium",
      };
    case "high":
      return {
        layer: 5,
        status: "ok",
        finding: "permissive",
        headline:
          "Comprehensive Common Crawl presence; widely captured in the public training corpus.",
        confidence: "high",
      };
  }
}

export function buildLayerVerdicts(args: {
  layer1Signal: RobotsLayer1Result | null;
  layer2Signal: L2Result | null;
  layer3Signal: L3Result | null;
  layer5Signal: L5Result | null;
}): LayerVerdict[] {
  return [
    verdictForLayer1(args.layer1Signal),
    verdictForLayer2(args.layer2Signal),
    verdictForLayer3(args.layer3Signal),
    verdictForLayer4(),
    verdictForLayer5(args.layer5Signal),
  ];
}
