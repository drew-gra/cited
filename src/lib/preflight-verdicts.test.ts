import { describe, it, expect } from "vitest";
import { verdictForPreflight } from "./preflight-verdicts";
import {
  preflightSignalSchema,
  type PreflightSignal,
} from "./layers/preflight";

// A healthy, readable news-outlet capture. Tests override only what matters.
function makeSignal(overrides: Partial<PreflightSignal> = {}): PreflightSignal {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    status: "ok",
    homepage: {
      fetchedUrl: "https://example.com/",
      status: "ok",
      httpStatus: 200,
      ogSiteName: "Example",
      ogType: "website",
      metaGenerator: null,
      sectionNavCount: 5,
      sectionNavSamples: ["politics", "business"],
      newsroomLinkCount: 2,
      newsroomLinkSamples: ["/about", "/staff"],
      commerceFingerprints: [],
    },
    articles: {
      source: "sitemap",
      sampledUrls: ["https://example.com/a", "https://example.com/b"],
      fetchCount: 3,
      jsonLdNewsArticleCount: 3,
      jsonLdGenericArticleCount: 0,
      distinctBylines: ["Jane Doe", "John Roe"],
      authorMetaTagHits: 3,
      recentArticleCount: 3,
    },
    wikipedia: null,
    platform: null,
    newsletterPlatformOverride: false,
    socialPlatformDenied: false,
    score: 9,
    reasons: [],
    ...overrides,
  };
}

// Homepage that returned 200 but yielded no extractable signal — the CDN
// bot-challenge fingerprint.
function degenerateHomepage(): PreflightSignal["homepage"] {
  return {
    fetchedUrl: "https://example.com/",
    status: "ok",
    httpStatus: 200,
    ogSiteName: null,
    ogType: null,
    metaGenerator: null,
    sectionNavCount: 0,
    sectionNavSamples: [],
    newsroomLinkCount: 0,
    newsroomLinkSamples: [],
    commerceFingerprints: [],
  };
}

function emptyArticles(): PreflightSignal["articles"] {
  return {
    source: "none",
    sampledUrls: [],
    fetchCount: 0,
    jsonLdNewsArticleCount: 0,
    jsonLdGenericArticleCount: 0,
    distinctBylines: [],
    authorMetaTagHits: 0,
    recentArticleCount: 0,
  };
}

describe("verdictForPreflight — core branches", () => {
  it("null signal => borderline (not yet run)", () => {
    expect(verdictForPreflight(null).finding).toBe("borderline");
  });

  it("high score, readable capture => news", () => {
    expect(verdictForPreflight(makeSignal({ score: 9 })).finding).toBe("news");
  });

  it("mid score (2-4), readable capture => borderline", () => {
    expect(verdictForPreflight(makeSignal({ score: 3 })).finding).toBe(
      "borderline",
    );
  });

  it("low score (<2), readable capture => not_news", () => {
    expect(verdictForPreflight(makeSignal({ score: 0 })).finding).toBe(
      "not_news",
    );
  });

  it("social denylist overrides even a high score => not_news", () => {
    const v = verdictForPreflight(
      makeSignal({ socialPlatformDenied: true, score: 14 }),
    );
    expect(v.finding).toBe("not_news");
  });

  it("newsletter-platform override => news even at low score", () => {
    const v = verdictForPreflight(
      makeSignal({
        newsletterPlatformOverride: true,
        platform: "beehiiv",
        score: 1,
      }),
    );
    expect(v.finding).toBe("news");
  });

  it("homepage error + external evidence (score>=3) => news", () => {
    const v = verdictForPreflight(
      makeSignal({ status: "error", errorMessage: "timeout", score: 3 }),
    );
    expect(v.finding).toBe("news");
  });

  it("homepage error + no external evidence (score<3) => borderline", () => {
    expect(
      verdictForPreflight(makeSignal({ status: "error", score: 0 })).finding,
    ).toBe("borderline");
  });
});

// Regression guard for e29eff1 — the SFGate case. A degenerate capture must
// be treated as "couldn't read the site" and fall back to external evidence,
// NOT scored as if the empty read were real.
describe("degenerate-capture handling (regression: SFGate / e29eff1)", () => {
  it("degenerate capture + external evidence (score>=3) => news", () => {
    const v = verdictForPreflight(
      makeSignal({
        homepage: degenerateHomepage(),
        articles: emptyArticles(),
        wikipedia: {
          queriedTerm: "SFGate",
          status: "found",
          matchedTitle: "SFGate",
          matchedPageId: 123,
        },
        score: 3,
        reasons: [
          { signal: "wikipedia_article", delta: 3, detail: "Wikipedia match." },
        ],
      }),
    );
    expect(v.finding).toBe("news");
    expect(v.headline).toContain("bot challenge");
  });

  it("degenerate capture + no external evidence => borderline (never not_news)", () => {
    const v = verdictForPreflight(
      makeSignal({
        homepage: degenerateHomepage(),
        articles: emptyArticles(),
        wikipedia: null,
        score: 0,
        reasons: [],
      }),
    );
    expect(v.finding).toBe("borderline");
  });

  it("a thin but READABLE homepage is not degenerate (normal scoring applies)", () => {
    // og:site_name present => we genuinely read the page, so a score of 0
    // resolves to not_news rather than the external-evidence fallback.
    const v = verdictForPreflight(
      makeSignal({
        homepage: { ...degenerateHomepage(), ogSiteName: "Thin Site" },
        articles: emptyArticles(),
        score: 0,
      }),
    );
    expect(v.finding).toBe("not_news");
  });
});

// Regression guard for 38d798b — strict schemas must tolerate signals
// persisted before socialPlatformDenied existed.
describe("schema back-compat (regression: 38d798b)", () => {
  it("accepts a signal missing socialPlatformDenied, defaulting it to false", () => {
    const full = makeSignal({ score: 6 });
    const { socialPlatformDenied: _omit, ...oldShape } = full;
    void _omit;
    const result = preflightSignalSchema.safeParse(oldShape);
    expect(result.success).toBe(true);
    if (result.success) {
      expect(result.data.socialPlatformDenied).toBe(false);
    }
  });
});
