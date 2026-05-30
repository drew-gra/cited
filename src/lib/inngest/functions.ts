import { and, desc, eq, sql } from "drizzle-orm";
import { inngest } from "./client";
import { db } from "../db";
import {
  outlets,
  signals,
  assessmentRuns,
  probeLog,
} from "../db/schema";
import { fetchAndParseRobots, robotsLayer1ResultSchema } from "../layers/robots";
import { fetchL2, l2ResultSchema } from "../layers/declarations";
import { detectCdn } from "../layers/cdn";
import { fetchCommonCrawlPresence } from "../layers/common-crawl";
import { findSampleArticleUrls } from "../layers/sitemap";
import { probeUrl, summarizeL4, type L4Probe } from "../layers/ua-probing";
import { runPreflight, preflightSignalSchema } from "../layers/preflight";
import { verdictForPreflight } from "../preflight-verdicts";
import { BASELINE_USER_AGENT, TTL_SECONDS } from "../policy";
import { BOTS } from "../ai-platforms";
import { parseSignal, loadBlocklist } from "../db/queries";
import { isBlocked } from "../blocklist";

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
    // Layer numbering: 0 = preflight, 1-5 = existing pipeline. Preflight
    // is included in the standard "run everything" default because new
    // outlets always need it; surgical-refresh runs may omit it when L0
    // is fresh and definitively news/borderline.
    const layersToRun = new Set(data.layersToRun ?? [0, 1, 2, 3, 4, 5]);

    await step.run("mark-running", () =>
      db
        .update(assessmentRuns)
        .set({ status: "running", updatedAt: new Date() })
        .where(eq(assessmentRuns.id, runId)),
    );

    // ----- Layer 0: Preflight (is this a news outlet?) -----
    // Always evaluate the latest L0 verdict — even when L0 itself was
    // reused from a prior run — because if it says not_news we MUST
    // skip L1-L5 (those layers carry no signal value for non-news URLs
    // and would be misleading to display).
    if (layersToRun.has(0)) {
      await step.run("mark-l0-running", () =>
        db
          .update(assessmentRuns)
          .set({ preflightStatus: "running", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId)),
      );

      const blocklistForRun = await step.run("layer-0-load-blocklist", () =>
        loadBlocklist(),
      );

      const preflight = await step.run("layer-0-preflight", () =>
        runPreflight(rootDomain, { blocklist: blocklistForRun }),
      );

      await step.run("layer-0-persist", async () => {
        await db.insert(signals).values({
          outletId,
          layer: 0,
          signalType: "preflight",
          signalValue: preflight,
          ttlSeconds: TTL_SECONDS.layer0,
        });
        await db
          .update(assessmentRuns)
          .set({ preflightStatus: "done", updatedAt: new Date() })
          .where(eq(assessmentRuns.id, runId));
      });
    }

    // Load the latest preflight signal (either just-computed or reused
    // from a prior run if L0 wasn't in layersToRun) and decide whether
    // to short-circuit the pipeline. The blocklist is queried again here
    // because L0 may not have run in this invocation (surgical refresh
    // skips it when the prior signal is still fresh), so we can't assume
    // blocklistForRun above was loaded.
    const preflightVerdict = await step.run(
      "evaluate-preflight",
      async () => {
        const [row] = await db
          .select()
          .from(signals)
          .where(and(eq(signals.outletId, outletId), eq(signals.layer, 0)))
          .orderBy(desc(signals.capturedAt))
          .limit(1);
        const signal = parseSignal(row, preflightSignalSchema, {
          outletId,
          layer: 0,
        });
        const blocklist = await loadBlocklist();
        const manuallyBlocked = isBlocked(rootDomain, blocklist);
        return verdictForPreflight(signal, manuallyBlocked);
      },
    );

    if (preflightVerdict.finding === "not_news") {
      // Refuse to assess. Mark L1-L5 skipped, finalize the run, and
      // return. The UI surfaces the preflight evidence so the user can
      // see why and contest if appropriate.
      await step.run("not-news-short-circuit", async () => {
        await db
          .update(assessmentRuns)
          .set({
            status: "done",
            layer1Status: "skipped",
            layer2Status: "skipped",
            layer3Status: "skipped",
            layer4Status: "skipped",
            layer5Status: "skipped",
            updatedAt: new Date(),
          })
          .where(eq(assessmentRuns.id, runId));
        await db
          .update(outlets)
          .set({
            firstAssessedAt: sql`COALESCE(${outlets.firstAssessedAt}, NOW())`,
            lastFullAssessmentAt: new Date(),
          })
          .where(eq(outlets.id, outletId));
      });
      return { runId, preflight: preflightVerdict.finding, layersRun: [0] };
    }

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
        const value = parseSignal(latestL2, l2ResultSchema, {
          outletId,
          layer: 2,
        });
        return value?.homepage.responseHeaders ?? {};
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
          const value = parseSignal(latestL1, robotsLayer1ResultSchema, {
            outletId,
            layer: 1,
          });
          return value?.sitemaps ?? [];
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

    // ----- Finalize -----
    // Per-platform postures are NOT persisted to the `assessments` table.
    // The GET handler derives them live from the latest signals on every
    // read (src/lib/posture.ts), so persisting them at write time would be
    // dead weight and would freeze a snapshot of the rule logic that drifts
    // away from live behavior as posture.ts evolves. The table is kept in
    // the schema for now in case we want audit-trail persistence later.
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
