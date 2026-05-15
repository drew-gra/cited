import { and, desc, eq, sql } from "drizzle-orm";
import { inngest } from "./client";
import { db } from "../db";
import {
  outlets,
  assessments,
  signals,
  assessmentRuns,
  type AccessState,
  type AggregatePosture,
} from "../db/schema";
import { fetchAndParseRobots } from "../layers/robots";
import type { RobotsLayer1Result } from "../layers/robots";
import { fetchL2 } from "../layers/declarations";
import { detectCdn } from "../layers/cdn";
import { fetchCommonCrawlPresence } from "../layers/common-crawl";
import { TTL_SECONDS } from "../policy";
import { PLATFORMS, type AiPlatform } from "../ai-platforms";

function summarizeAccess(states: AccessState[]): AccessState {
  if (states.length === 0) return "unknown";
  if (states.every((s) => s === "allowed")) return "allowed";
  if (states.every((s) => s === "blocked")) return "blocked";
  return "unknown";
}

// Slice 0/1 posture rule. The full rule table that incorporates L2+L3+L4+L5
// evidence lands in S4. For now, posture is derived from Layer 1 only.
function derivePosture(
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
    const layersToRun = new Set(data.layersToRun ?? [1, 2, 3, 5]);

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

    // ----- Compute per-platform assessments -----
    // Read the most recent Layer 1 signal from the DB rather than relying
    // on a step-local variable; with surgical refresh, L1 may have been
    // reused from a prior run and not refetched in this invocation.
    await step.run("compute-postures", async () => {
      const [latestL1] = await db
        .select()
        .from(signals)
        .where(and(eq(signals.outletId, outletId), eq(signals.layer, 1)))
        .orderBy(desc(signals.capturedAt))
        .limit(1);
      if (!latestL1) return;
      const robotsResult = latestL1.signalValue as RobotsLayer1Result;

      const platformRows = PLATFORMS.map((platform: AiPlatform) => {
        const platformBots = robotsResult.perBot.filter(
          (b) => b.platform === platform,
        );
        const trainingAccess = summarizeAccess(
          platformBots
            .filter((b) => b.purpose === "training")
            .map((b) => b.rootAccess),
        );
        const realtimeAccess = summarizeAccess(
          platformBots
            .filter((b) => b.purpose === "realtime")
            .map((b) => b.rootAccess),
        );
        const searchAccess = summarizeAccess(
          platformBots
            .filter((b) => b.purpose === "search")
            .map((b) => b.rootAccess),
        );
        return {
          outletId,
          assessmentRunId: runId,
          aiPlatform: platform,
          trainingAccess,
          realtimeAccess,
          searchAccess,
          aggregatePosture: derivePosture(
            trainingAccess,
            realtimeAccess,
            searchAccess,
          ),
          // Slice S2 stub: bump to 70 (L1+L2+L3+L5). Replaced by real
          // scoring when the rule table lands in S4.
          confidence: 70,
        };
      });
      await db.insert(assessments).values(platformRows);
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
