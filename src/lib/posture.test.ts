import { describe, it, expect } from "vitest";
import { derivePostures, type PostureInputs } from "./posture";
import { BOTS, PLATFORMS } from "./ai-platforms";
import type { RobotsLayer1Result } from "./layers/robots";
import type { L4Result, L4BotAggregate } from "./layers/ua-probing";

const NO_SIGNALS: PostureInputs = {
  layer1Signal: null,
  layer2Signal: null,
  layer3Signal: null,
  layer4Signal: null,
  layer5Signal: null,
};

function l1AllAccess(
  access: "allowed" | "blocked" | "unknown",
): RobotsLayer1Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    fetchUrl: "https://example.com/robots.txt",
    fetchUserAgent: "Test",
    status: "ok",
    httpStatus: 200,
    rawText: "",
    sitemaps: [],
    platform: { platform: "unknown", isDefault: false, note: "" },
    perBot: BOTS.map((b) => ({
      ua: b.ua,
      platform: b.platform,
      purpose: b.purpose,
      rootAccess: access,
      matchedLineNumber: null,
      matchedRule: null,
      crawlDelay: null,
    })),
  };
}

function l4ByUa(map: Record<string, L4BotAggregate>): L4Result {
  return {
    rootDomain: "example.com",
    fetchedAt: "2026-01-01T00:00:00.000Z",
    status: "ok",
    sampleSource: "sitemap",
    sampleSourceUrl: null,
    sampleUrls: ["https://example.com/a"],
    baselineUserAgent: "Test",
    probes: [],
    perBot: BOTS.map((b) => ({
      ua: b.ua,
      platform: b.platform,
      purpose: b.purpose,
      perUrl: [],
      aggregate: map[b.ua] ?? "unknown",
    })),
  };
}

const openai = (out: ReturnType<typeof derivePostures>) =>
  out.find((p) => p.platform === "openai")!;

describe("derivePostures (S4b posture rules)", () => {
  it("no signals => one posture per platform, all unknown", () => {
    const out = derivePostures(NO_SIGNALS);
    expect(out).toHaveLength(PLATFORMS.length);
    expect(out.every((p) => p.aggregatePosture === "unknown")).toBe(true);
  });

  it("L1 all-allowed, no L4 => open, training allowed", () => {
    const out = derivePostures({
      ...NO_SIGNALS,
      layer1Signal: l1AllAccess("allowed"),
    });
    const o = openai(out);
    expect(o.trainingAccess).toBe("allowed");
    expect(o.aggregatePosture).toBe("open");
  });

  it("L4 server reality overrides L1: L1 allows but L4 blocks GPTBot => training blocked", () => {
    const out = derivePostures({
      ...NO_SIGNALS,
      layer1Signal: l1AllAccess("allowed"),
      layer4Signal: l4ByUa({ GPTBot: "blocked" }),
    });
    // GPTBot is openai/training — L4's decisive "blocked" wins over L1's "allowed".
    expect(openai(out).trainingAccess).toBe("blocked");
  });

  it("L4 agreement with L1 lifts confidence above the L1-only baseline", () => {
    const l1Only = openai(
      derivePostures({ ...NO_SIGNALS, layer1Signal: l1AllAccess("allowed") }),
    );
    const withL4 = openai(
      derivePostures({
        ...NO_SIGNALS,
        layer1Signal: l1AllAccess("allowed"),
        layer4Signal: l4ByUa(
          Object.fromEntries(BOTS.map((b) => [b.ua, "allowed" as L4BotAggregate])),
        ),
      }),
    );
    expect(withL4.confidence).toBeGreaterThan(l1Only.confidence);
  });
});
