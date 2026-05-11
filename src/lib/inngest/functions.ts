import { eq } from "drizzle-orm";
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
import { TTL_SECONDS } from "../policy";
import { PLATFORMS, type AiPlatform } from "../ai-platforms";

function summarizeAccess(states: AccessState[]): AccessState {
  if (states.length === 0) return "unknown";
  if (states.every((s) => s === "allowed")) return "allowed";
  if (states.every((s) => s === "blocked")) return "blocked";
  return "unknown";
}

// Slice 0 posture rule. Co-deferred to S4 with the full rule table.
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
    // For slice 0 only L1 fetches per run, but the throttle key will keep
    // multiple concurrent runs against the same domain polite once L2/L4 land.
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
    };
    const { runId, outletId, rootDomain } = data;

    await step.run("mark-running", async () => {
      await db
        .update(assessmentRuns)
        .set({
          status: "running",
          layer1Status: "running",
          updatedAt: new Date(),
        })
        .where(eq(assessmentRuns.id, runId));
    });

    let robotsResult;
    try {
      robotsResult = await step.run("layer-1-fetch", () =>
        fetchAndParseRobots(rootDomain),
      );
    } catch (err) {
      await db
        .update(assessmentRuns)
        .set({
          status: "error",
          layer1Status: "error",
          errorMessage: err instanceof Error ? err.message : String(err),
          updatedAt: new Date(),
        })
        .where(eq(assessmentRuns.id, runId));
      throw err;
    }

    await step.run("persist-l1", async () => {
      await db.insert(signals).values({
        outletId,
        layer: 1,
        signalType: "robots.txt",
        signalValue: robotsResult,
        ttlSeconds: TTL_SECONDS.layer1,
      });

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
          // Slice 0 stub: 30 reflects "L1 only, no agreement check possible".
          // Replaced by real scoring when the rule table lands in S4.
          confidence: 30,
        };
      });

      await db.insert(assessments).values(platformRows);

      await db
        .update(assessmentRuns)
        .set({
          status: "done",
          layer1Status: "done",
          // Slice 0: only L1 runs. Mark the rest skipped so the GET endpoint
          // can render them as deferred.
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
          firstAssessedAt: new Date(),
          lastFullAssessmentAt: new Date(),
        })
        .where(eq(outlets.id, outletId));
    });

    return { runId, layers: ["layer1"] as const };
  },
);
