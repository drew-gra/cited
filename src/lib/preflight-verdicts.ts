/**
 * Preflight (Layer 0) verdict vocabulary. Deliberately separate from
 * `LayerFinding` because "is this a news outlet?" is a different question
 * than "is this site permissive or restrictive to AI bots?". Conflating
 * the two vocabularies would force one to lie about what it's saying.
 *
 * Three states:
 *  - news        — meets the news-outlet bar; full L1-L5 assessment runs.
 *  - borderline  — weak signals but not absent; assessment runs with a
 *                  warning banner so the user can decide whether the
 *                  result is interesting.
 *  - not_news    — fails the bar; L1-L5 are skipped entirely. The user
 *                  sees the preflight evidence and a refusal explanation.
 *
 * Translator is a pure function over the persisted L0 signal — same
 * shape and contract as the LayerFinding translators in verdicts.ts.
 */
import { z } from "zod";
import type { PreflightSignal } from "./layers/preflight";

export const preflightFindingSchema = z.enum([
  "news",
  "borderline",
  "not_news",
]);
export const preflightConfidenceSchema = z.enum(["low", "medium", "high"]);

export const preflightReasonSchema = z.object({
  signal: z.string(),
  delta: z.number(),
  detail: z.string(),
});

export const preflightVerdictSchema = z.object({
  finding: preflightFindingSchema,
  headline: z.string(),
  confidence: preflightConfidenceSchema,
  score: z.number(),
  reasons: z.array(preflightReasonSchema),
});

export type PreflightFinding = z.infer<typeof preflightFindingSchema>;
export type PreflightConfidence = z.infer<typeof preflightConfidenceSchema>;
export type PreflightReason = z.infer<typeof preflightReasonSchema>;
export type PreflightVerdict = z.infer<typeof preflightVerdictSchema>;

export const PREFLIGHT_FINDING_LABEL: Record<PreflightFinding, string> = {
  news: "News outlet",
  borderline: "Borderline",
  not_news: "Not a news outlet",
};

export function verdictForPreflight(
  signal: PreflightSignal | null,
): PreflightVerdict {
  if (!signal) {
    return {
      finding: "borderline",
      headline: "Preflight not yet run.",
      confidence: "low",
      score: 0,
      reasons: [],
    };
  }

  // Social-platform denylist is checked first — it overrides every
  // other rule (newsletter override, error path, score thresholds).
  // These domains aren't editorial publications regardless of what
  // their HTML happens to look like, and the v1 product line is
  // explicit about only assessing news outlets.
  if (signal.socialPlatformDenied) {
    return {
      finding: "not_news",
      headline: `${signal.rootDomain} is a social-media platform — Cited only assesses editorial publications.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  if (signal.status === "error") {
    // Homepage was unreachable, but we still collect Wikipedia and
    // article-sample signals in the error path. If those independently
    // produced strong external evidence (Wikipedia article alone is +3,
    // and a sitemap-discoverable outlet with NewsArticle markup can
    // easily clear 3 even without homepage), classify as news rather
    // than dumping into borderline. The headline calls out the
    // unreachable homepage so the user understands which evidence the
    // verdict is resting on.
    if (signal.score >= 3) {
      return {
        finding: "news",
        headline: `Homepage unreachable (${signal.errorMessage ?? "unknown error"}); classified as news on external evidence (score ${signal.score}).`,
        confidence: "medium",
        score: signal.score,
        reasons: signal.reasons,
      };
    }
    return {
      finding: "borderline",
      headline: `Preflight could not run (${signal.errorMessage ?? "unknown error"}); proceeding with caution.`,
      confidence: "low",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  // Newsletter-platform override. Substack, Beehiiv, and Ghost require a
  // material infrastructure investment to set up, which rules out the
  // half-hearted corporate-marketing case Cited is trying to filter out.
  // Editorial use of those platforms — opinion journalism, newsletters,
  // aggregation — is real journalism even when the signal stack would
  // otherwise score it borderline, so we treat the platform itself as
  // the qualifying signal.
  if (signal.newsletterPlatformOverride) {
    return {
      finding: "news",
      headline: `${signal.platform ?? "Newsletter platform"} publication — treated as news by policy.`,
      confidence: "high",
      score: signal.score,
      reasons: signal.reasons,
    };
  }

  if (signal.score >= 5) {
    return {
      finding: "news",
      headline: `News-outlet signals present (score ${signal.score}).`,
      confidence: signal.score >= 7 ? "high" : "medium",
      score: signal.score,
      reasons: signal.reasons,
    };
  }
  if (signal.score >= 2) {
    return {
      finding: "borderline",
      headline: `Mixed news-outlet signals (score ${signal.score}); assessment will proceed but verdict may be noisy.`,
      confidence: "medium",
      score: signal.score,
      reasons: signal.reasons,
    };
  }
  return {
    finding: "not_news",
    headline: `News-outlet signals absent (score ${signal.score}); Cited only assesses news outlets.`,
    confidence: signal.score <= -2 ? "high" : "medium",
    score: signal.score,
    reasons: signal.reasons,
  };
}
