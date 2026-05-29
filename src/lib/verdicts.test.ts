import { describe, it, expect } from "vitest";
import {
  verdictForLayer1,
  verdictForLayer2,
  verdictForLayer3,
  verdictForLayer4,
  verdictForLayer5,
} from "./verdicts";
import type { RobotsLayer1Result, BotFinding } from "./layers/robots";
import type { L2Result } from "./layers/declarations";
import type { L3Result } from "./layers/cdn";
import type { L4Result, L4BotAggregate } from "./layers/ua-probing";
import type { L5Result, CoverageBucket } from "./layers/common-crawl";

function botFinding(
  rootAccess: BotFinding["rootAccess"],
  ua = "GPTBot",
): BotFinding {
  return {
    ua,
    platform: "openai",
    purpose: "training",
    rootAccess,
    matchedLineNumber: null,
    matchedRule: null,
    crawlDelay: null,
  };
}

function robots(overrides: Partial<RobotsLayer1Result> = {}): RobotsLayer1Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    fetchUrl: "https://example.com/robots.txt",
    fetchUserAgent: "Test",
    status: "ok",
    httpStatus: 200,
    rawText: "User-agent: *\nAllow: /",
    sitemaps: [],
    platform: { platform: "unknown", isDefault: false, note: "" },
    perBot: [],
    ...overrides,
  };
}

describe("verdictForLayer1 (robots.txt)", () => {
  it("null => no_data / inconclusive", () => {
    const v = verdictForLayer1(null);
    expect(v.status).toBe("no_data");
    expect(v.finding).toBe("inconclusive");
  });

  it("not_found => permissive (allowed by convention)", () => {
    expect(verdictForLayer1(robots({ status: "not_found" })).finding).toBe(
      "permissive",
    );
  });

  it("all assessed bots blocked => restrictive", () => {
    const v = verdictForLayer1(
      robots({ perBot: [botFinding("blocked"), botFinding("blocked", "ClaudeBot")] }),
    );
    expect(v.finding).toBe("restrictive");
  });

  it("some allowed, some blocked => mixed", () => {
    const v = verdictForLayer1(
      robots({ perBot: [botFinding("allowed"), botFinding("blocked", "ClaudeBot")] }),
    );
    expect(v.finding).toBe("mixed");
  });
});

function l2(overrides: Partial<L2Result["homepage"]> = {}, llmsPresent = false): L2Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    homepage: {
      fetchedUrl: "https://example.com/",
      status: "ok",
      httpStatus: 200,
      xRobotsTag: null,
      metaRobots: null,
      aiMetaTags: {},
      aiContentDeclaration: null,
      responseHeaders: {},
      ...overrides,
    },
    llmsTxt: llmsPresent
      ? { url: "https://example.com/llms.txt", state: "present", httpStatus: 200, sizeBytes: 1200 }
      : { url: "https://example.com/llms.txt", state: "absent", httpStatus: 404, sizeBytes: null },
  };
}

describe("verdictForLayer2 (HTTP/HTML declarations)", () => {
  it("null => inconclusive", () => {
    expect(verdictForLayer2(null).finding).toBe("inconclusive");
  });

  it("restrictive AI meta tag => restrictive", () => {
    expect(
      verdictForLayer2(l2({ aiMetaTags: { GPTBot: "noindex" } })).finding,
    ).toBe("restrictive");
  });

  it("llms.txt present, no restrictions => permissive", () => {
    expect(verdictForLayer2(l2({}, true)).finding).toBe("permissive");
  });

  it("restriction + llms.txt present => mixed", () => {
    expect(
      verdictForLayer2(l2({ aiMetaTags: { GPTBot: "noai" } }, true)).finding,
    ).toBe("mixed");
  });
});

function l3(detected: L3Result["detected"]): L3Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    detected,
    evidence: [],
  };
}

describe("verdictForLayer3 (CDN fingerprint — always contextual)", () => {
  it("null => inconclusive", () => {
    expect(verdictForLayer3(null).finding).toBe("inconclusive");
  });
  it("no CDN detected => contextual", () => {
    expect(verdictForLayer3(l3([])).finding).toBe("contextual");
  });
  it("CDN detected => contextual", () => {
    expect(verdictForLayer3(l3(["cloudflare"])).finding).toBe("contextual");
  });
});

function l4(
  status: L4Result["status"],
  aggregates: L4BotAggregate[] = [],
): L4Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    status,
    sampleSource: "sitemap",
    sampleSourceUrl: "https://example.com/sitemap.xml",
    sampleUrls: ["https://example.com/a"],
    baselineUserAgent: "Test",
    probes: [],
    perBot: aggregates.map((aggregate, i) => ({
      ua: `Bot${i}`,
      platform: "openai" as const,
      purpose: "training" as const,
      perUrl: [],
      aggregate,
    })),
  };
}

describe("verdictForLayer4 (UA probing)", () => {
  it("null => inconclusive", () => {
    expect(verdictForLayer4(null).finding).toBe("inconclusive");
  });
  it("no_urls => inconclusive", () => {
    expect(verdictForLayer4(l4("no_urls")).finding).toBe("inconclusive");
  });
  it("baseline_failed => inconclusive", () => {
    expect(verdictForLayer4(l4("baseline_failed")).finding).toBe("inconclusive");
  });
  it("all bots allowed => permissive", () => {
    expect(verdictForLayer4(l4("ok", ["allowed", "allowed"])).finding).toBe(
      "permissive",
    );
  });
  it("all bots blocked => restrictive", () => {
    expect(verdictForLayer4(l4("ok", ["blocked", "blocked"])).finding).toBe(
      "restrictive",
    );
  });
  it("some allowed, some blocked => mixed", () => {
    expect(verdictForLayer4(l4("ok", ["allowed", "blocked"])).finding).toBe(
      "mixed",
    );
  });
});

function l5(coverageBucket: CoverageBucket, indexesQueried = 6): L5Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    indexesQueried,
    indexes: [],
    indexesPresent: coverageBucket === "absent" ? 0 : 3,
    totalRecords: coverageBucket === "absent" ? 0 : 600,
    coverageBucket,
    trend: "steady",
  };
}

describe("verdictForLayer5 (Common Crawl presence)", () => {
  it("null => inconclusive", () => {
    expect(verdictForLayer5(null).finding).toBe("inconclusive");
  });
  it("CDX unreachable (indexesQueried 0) => inconclusive", () => {
    expect(verdictForLayer5(l5("absent", 0)).finding).toBe("inconclusive");
  });
  it("absent => restrictive", () => {
    expect(verdictForLayer5(l5("absent")).finding).toBe("restrictive");
  });
  it("low => contextual", () => {
    expect(verdictForLayer5(l5("low")).finding).toBe("contextual");
  });
  it("high => permissive", () => {
    expect(verdictForLayer5(l5("high")).finding).toBe("permissive");
  });
});
