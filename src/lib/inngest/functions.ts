import { and, desc, eq, sql } from "drizzle-orm";
import { inngest } from "./client";
import { db } from "../db";
import {
  outlets,
  assessments,
  signals,
  assessmentRuns,
  probeLog,
} from "../db/schema";
import { fetchAndParseRobots } from "../layers/robots";
import type { RobotsLayer1Result } from "../layers/robots";
import { fetchL2 } from "../layers/declarations";
import type { L2Result } from "../layers/declarations";
import { detectCdn } from "../layers/cdn";
import type { L3Result } from "../layers/cdn";
import { fetchCommonCrawlPresence } from "../layers/common-crawl";
import type { L5Result } from "../layers/common-crawl";
import { findSampleArticleUrls } from "../layers/sitemap";
import {
  probeUrl,
  summarizeL4,
  type L4Probe,
  type L4Result,
} from "../layers/ua-probing";
import { BASELINE_USER_AGENT, TTL_SECONDS } from "../policy";
import { BOTS } from "../ai-platforms";
import { derivePostures } from "../posture";

export const assessOutlet = inngest.createFunction(
  {
    id: "assess-outlet",
    triggers: [{ event: "cited/assess.requested" }],
    // Politeness: cap outbound requests to one per second per target domain.
    throttle: {
      limit: 1,
      period: "1s",
      key: "event.data.rootDomain",
    },
  },
  async ({ event, step }) => {
    const data = event.data as {
      runId: string;
      outletId: string;
      rootDomain: string;
      forceRefresh: boolean;
      // POST /api/assess decides which layers need refreshing based on TTL
      // staleness. Older events (pre-surgical-refresh) may not include this
      // field; default to all implemented layers for compatibility.
      layersToRun?: number[];
    };
    const { runId, outletId, rootDomain } = data;
    const layersToRun = new Set(data.layersToRun ?? [1, 2, 3, 4, 5]);

    await step.run("mark-running", () =>
      db
        .update(assessmentRuns)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(assessmentRuns.id, runId)),
    );

    // ----- Layer 1: robots.txt -----
    if (layersToRun.has(1)) {
      await step.run("mark-l1-running", () =>
        db
          .update(assessmentRuns)
          .set({ layer1Status: "running", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId)),
      );

      const robotsResult = await step.run("layer-1-fetch", () =>
        fetchAndParseRobots(rootDomain),
      );

      await step.run("layer-1-persist", async () => {
        await db.insert(signals).values({
          outletId,
          layer: 1,
          signalType: "robots.txt",
          signalValue: robotsResult,
          ttlSeconds: TTL_SECONDS.layer1,
        });
        await db
          .update(assessmentRuns)
          .set({ layer1Status: "done", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId));
      });
    }

    // ----- Layer 2: HTTP / HTML declarations + llms.txt -----
    // L3 depends on L2's response headers, so if EITHER is being run we
    // need the L2 fetch result. When only L3 is being re-run (rare but
    // possible), the response headers from the prior fetch are persisted
    // in the layer-2 signal and we can read them from the DB.
    let l2HeadersForL3: Record<string, string> | null = null;

    if (layersToRun.has(2)) {
      await step.run("mark-l2-running", () =>
        db
          .update(assessmentRuns)
          .set({ layer2Status: "running", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId)),
      );

      const l2Result = await step.run("layer-2-fetch", () =>
        fetchL2(rootDomain),
      );
      l2HeadersForL3 = l2Result.homepage.responseHeaders ?? {};

      await step.run("layer-2-persist", async () => {
        await db.insert(signals).values({
          outletId,
          layer: 2,
          signalType: "http_html_declarations",
          signalValue: l2Result,
          ttlSeconds: TTL_SECONDS.layer2,
        });
        await db
          .update(assessmentRuns)
          .set({ layer2Status: "done", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId));
      });
    }

    // ----- Layer 3: CDN fingerprint (derived from L2 response headers) -----
    if (layersToRun.has(3)) {
      await step.run("mark-l3-running", () =>
        db
          .update(assessmentRuns)
          .set({ layer3Status: "running", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId)),
      );

      const headers = await step.run("layer-3-load-headers", async () => {
        if (l2HeadersForL3) return l2HeadersForL3;
        // L2 wasn't re-run this time; pull headers from its existing signal.
        const [latestL2] = await db
          .select()
          .from(signals)
          .where(and(eq(signals.outletId, outletId), eq(signals.layer, 2)))
          .orderBy(desc(signals.capturedAt))
          .limit(1);
        if (!latestL2) return {} as Record<string, string>;
        const value = latestL2.signalValue as {
          homepage?: { responseHeaders?: Record<string, string> };
        };
        return value.homepage?.responseHeaders ?? {};
      });

      const cdnResult = await step.run("layer-3-detect", () =>
        detectCdn(rootDomain, headers),
      );

      await step.run("layer-3-persist", async () => {
        await db.insert(signals).values({
          outletId,
          layer: 3,
          signalType: "cdn_fingerprint",
          signalValue: cdnResult,
          ttlSeconds: TTL_SECONDS.layer3,
        });
        await db
          .update(assessmentRuns)
          .set({ layer3Status: "done", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId));
      });
    }

    // ----- Layer 4: User-agent A/B probing -----
    // The most expensive layer: up to 50 fetches per outlet, serialized at
    // ~1/sec per domain. Each fetch is its own step.run so Inngest memoizes
    // successful results across retries; step.sleep between fetches enforces
    // the politeness window (Inngest's function-level throttle only spaces
    // out invocations, not work within one invocation).
    if (layersToRun.has(4)) {
      await step.run("mark-l4-running", () =>
        db
          .update(assessmentRuns)
          .set({ layer4Status: "running", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId)),
      );

      // Sitemaps declared in robots.txt take priority over standard-path
      // guessing in L4's discovery — publishers like NPR put their sitemaps
      // at non-standard paths that the default chain would miss. L1's
      // signal already captures these, so we just hand them through.
      const robotsSitemaps = await step.run(
        "layer-4-load-robots-sitemaps",
        async () => {
          const [latestL1] = await db
            .select()
            .from(signals)
            .where(and(eq(signals.outletId, outletId), eq(signals.layer, 1)))
            .orderBy(desc(signals.capturedAt))
            .limit(1);
          if (!latestL1) return [] as string[];
          const value = latestL1.signalValue as { sitemaps?: string[] };
          return value.sitemaps ?? [];
        },
      );

      const sample = await step.run("layer-4-discover", () =>
        findSampleArticleUrls(rootDomain, { robotsSitemaps }),
      );

      const probes: L4Probe[] = [];
      let first = true;
      for (let i = 0; i < sample.urls.length; i++) {
        if (!first) {
          await step.sleep(`l4-sleep-baseline-${i}`, "1s");
        }
        first = false;
        const baseline = await step.run(`l4-probe-${i}-baseline`, () =>
          probeUrl(sample.urls[i], BASELINE_USER_AGENT, true),
        );
        probes.push(baseline);

        for (let j = 0; j < BOTS.length; j++) {
          await step.sleep(`l4-sleep-${i}-${j}`, "1s");
          const probe = await step.run(`l4-probe-${i}-${j}`, () =>
            probeUrl(sample.urls[i], BOTS[j].ua, false),
          );
          probes.push(probe);
        }
      }

      const l4Result = summarizeL4({ rootDomain, sample, probes });

      await step.run("layer-4-persist", async () => {
        if (probes.length > 0) {
          await db.insert(probeLog).values(
            probes.map((p) => ({
              outletId,
              sampleUrl: p.url,
              userAgent: p.userAgent,
              statusCode: p.statusCode,
              responseSize: p.responseSizeBytes,
              responseHash: p.contentHash,
            })),
          );
        }
        await db.insert(signals).values({
          outletId,
          layer: 4,
          signalType: "ua_probing",
          signalValue: l4Result,
          ttlSeconds: TTL_SECONDS.layer4,
        });
        await db
          .update(assessmentRuns)
          .set({ layer4Status: "done", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId));
      });
    }

    // ----- Layer 5: Common Crawl presence -----
    if (layersToRun.has(5)) {
      await step.run("mark-l5-running", () =>
        db
          .update(assessmentRuns)
          .set({ layer5Status: "running", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId)),
      );

      const l5Result = await step.run("layer-5-fetch", () =>
        fetchCommonCrawlPresence(rootDomain),
      );

      await step.run("layer-5-persist", async () => {
        await db.insert(signals).values({
          outletId,
          layer: 5,
          signalType: "common_crawl_presence",
          signalValue: l5Result,
          ttlSeconds: TTL_SECONDS.layer5,
        });
        await db
          .update(assessmentRuns)
          .set({ layer5Status: "done", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId));
      });
    }

    // ----- Compute per-platform assessments (S4b rule table) -----
    // Read latest signals for all five layers from the DB rather than
    // step-local variables; with surgical refresh, any subset of the
    // layers may have been reused from a prior run rather than refetched
    // in this invocation. The rule logic lives in src/lib/posture.ts.
    await step.run("compute-postures", async () => {
      const latestForLayer = async <T>(layer: number): Promise<T | null> => {
        const [row] = await db
          .select()
          .from(signals)
          .where(and(eq(signals.outletId, outletId), eq(signals.layer, layer)))
          .orderBy(desc(signals.capturedAt))
          .limit(1);
        return row ? (row.signalValue as T) : null;
      };

      const [l1, l2, l3, l4, l5] = await Promise.all([
        latestForLayer<RobotsLayer1Result>(1),
        latestForLayer<L2Result>(2),
        latestForLayer<L3Result>(3),
        latestForLayer<L4Result>(4),
        latestForLayer<L5Result>(5),
      ]);

      const postures = derivePostures({
        layer1Signal: l1,
        layer2Signal: l2,
        layer3Signal: l3,
        layer4Signal: l4,
        layer5Signal: l5,
      });

      const rows = postures.map((p) => ({
        outletId,
        assessmentRunId: runId,
        aiPlatform: p.platform,
        trainingAccess: p.trainingAccess,
        realtimeAccess: p.realtimeAccess,
        searchAccess: p.searchAccess,
        aggregatePosture: p.aggregatePosture,
        confidence: p.confidence,
      }));
      if (rows.length > 0) await db.insert(assessments).values(rows);
    });

    // ----- Finalize -----
    await step.run("finalize", async () => {
      await db
        .update(assessmentRuns)
        .set({
          status: "done",
          updatedAt: new Date(),
        })
        .where(eq(assessmentRuns.id, runId));

      await db
        .update(outlets)
        .set({
          // Only set firstAssessedAt the first time; subsequent runs keep
          // the original value.
          firstAssessedAt: sql`COALESCE(${outlets.firstAssessedAt}, NOW())`,
          lastFullAssessmentAt: new Date(),
        })
        .where(eq(outlets.id, outletId));
    });

    return {
      runId,
      layersRun: Array.from(layersToRun).sort(),
    };
  },
);
