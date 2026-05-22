import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outlets, assessmentRuns, signals } from "@/lib/db/schema";
import { normalizeUrl } from "@/lib/domain";
import { checkAndRecordIpRateLimit } from "@/lib/rate-limit";
import { inngest } from "@/lib/inngest/client";
import { verdictForPreflight } from "@/lib/preflight-verdicts";
import type { PreflightSignal } from "@/lib/layers/preflight";

// Layers the Inngest workflow currently runs end-to-end. The cache check
// only short-circuits when every one of these has a fresh signal AND the
// most-recent run has all of them marked done (not skipped). 0 is the
// preflight (news-outlet classification) gate; 1-5 are the main pipeline.
const IMPLEMENTED_LAYERS = [0, 1, 2, 3, 4, 5] as const;

async function loadLatestPreflightSignal(
  outletId: string,
): Promise<PreflightSignal | null> {
  const [row] = await db
    .select()
    .from(signals)
    .where(and(eq(signals.outletId, outletId), eq(signals.layer, 0)))
    .orderBy(desc(signals.capturedAt))
    .limit(1);
  return row ? (row.signalValue as PreflightSignal) : null;
}

const bodySchema = z.object({
  url: z.string().min(1),
  forceRefresh: z.boolean().optional().default(false),
});

function getIp(req: NextRequest): string {
  const forwarded = req.headers.get("x-forwarded-for");
  if (forwarded) return forwarded.split(",")[0]?.trim() ?? "0.0.0.0";
  const real = req.headers.get("x-real-ip");
  if (real) return real;
  return "0.0.0.0";
}

export async function POST(req: NextRequest) {
  let parsed: z.infer<typeof bodySchema>;
  try {
    const body = await req.json();
    parsed = bodySchema.parse(body);
  } catch {
    return NextResponse.json(
      { error: "Invalid request body." },
      { status: 400 },
    );
  }

  let normalized;
  try {
    normalized = normalizeUrl(parsed.url);
  } catch (err) {
    return NextResponse.json(
      { error: err instanceof Error ? err.message : "Invalid URL." },
      { status: 400 },
    );
  }

  const [existingOutlet] = await db
    .select()
    .from(outlets)
    .where(eq(outlets.rootDomain, normalized.rootDomain))
    .limit(1);

  let outletId: string;
  if (existingOutlet) {
    outletId = existingOutlet.id;
  } else {
    const [newOutlet] = await db
      .insert(outlets)
      .values({
        rootDomain: normalized.rootDomain,
        primaryUrl: normalized.primaryUrl,
      })
      .returning({ id: outlets.id });
    outletId = newOutlet.id;
  }

  // Compute per-layer freshness. The Inngest workflow will only re-fetch
  // layers that are stale or missing; fresh layers reuse their existing
  // signals from prior runs.
  const freshnessPairs = await Promise.all(
    IMPLEMENTED_LAYERS.map(async (layer) => {
      const [latest] = await db
        .select()
        .from(signals)
        .where(
          and(eq(signals.outletId, outletId), eq(signals.layer, layer)),
        )
        .orderBy(desc(signals.capturedAt))
        .limit(1);
      if (!latest) return [layer, false] as const;
      const ageSeconds = (Date.now() - latest.capturedAt.getTime()) / 1000;
      return [layer, ageSeconds < latest.ttlSeconds] as const;
    }),
  );
  const freshness: Record<number, boolean> = Object.fromEntries(
    freshnessPairs,
  );

  // If preflight is fresh and says not_news, surface the most recent run
  // whose preflight reflected that verdict — no point spinning up the
  // pipeline again to skip every gated layer. Otherwise the regular
  // freshness logic applies.
  const preflightSignalForGate = await loadLatestPreflightSignal(outletId);
  const cachedPreflightVerdict = verdictForPreflight(preflightSignalForGate);
  const preflightFresh = freshness[0] === true;
  if (
    !parsed.forceRefresh &&
    preflightFresh &&
    cachedPreflightVerdict.finding === "not_news"
  ) {
    const [recentNotNewsRun] = await db
      .select()
      .from(assessmentRuns)
      .where(
        and(
          eq(assessmentRuns.outletId, outletId),
          eq(assessmentRuns.status, "done"),
          eq(assessmentRuns.preflightStatus, "done"),
        ),
      )
      .orderBy(desc(assessmentRuns.createdAt))
      .limit(1);
    if (recentNotNewsRun) {
      return NextResponse.json({ id: recentNotNewsRun.id, cached: true });
    }
  }

  const allFresh = IMPLEMENTED_LAYERS.every((l) => freshness[l]);

  // Cache hit: every implemented layer is fresh, AND a prior run exists
  // where every implemented layer is marked done.
  if (!parsed.forceRefresh && allFresh) {
    const [recentRun] = await db
      .select()
      .from(assessmentRuns)
      .where(
        and(
          eq(assessmentRuns.outletId, outletId),
          eq(assessmentRuns.status, "done"),
          eq(assessmentRuns.preflightStatus, "done"),
          eq(assessmentRuns.layer1Status, "done"),
          eq(assessmentRuns.layer2Status, "done"),
          eq(assessmentRuns.layer3Status, "done"),
          eq(assessmentRuns.layer4Status, "done"),
          eq(assessmentRuns.layer5Status, "done"),
        ),
      )
      .orderBy(desc(assessmentRuns.createdAt))
      .limit(1);
    if (recentRun) {
      return NextResponse.json({ id: recentRun.id, cached: true });
    }
  }

  // Decide which layers actually need to run. Force-refresh runs everything;
  // otherwise only the stale or missing layers.
  const layersToRun: number[] = parsed.forceRefresh
    ? [...IMPLEMENTED_LAYERS]
    : IMPLEMENTED_LAYERS.filter((l) => !freshness[l]);

  const ip = getIp(req);
  const rateLimit = await checkAndRecordIpRateLimit(ip);
  if (!rateLimit.allowed) {
    return NextResponse.json(
      {
        error: `Rate limit exceeded: ${rateLimit.limit} fresh assessments per IP per hour. Cached results remain available.`,
        resetSeconds: rateLimit.resetSeconds,
      },
      { status: 429 },
    );
  }

  // Pre-mark layers as "done" for layers we're reusing from prior runs; the
  // Inngest workflow will transition the layers in layersToRun through
  // running → done. Preflight has its own status column outside the
  // 1-5 grid because it gates the rest of the pipeline.
  const layerInitialStatus = (layer: 0 | 1 | 2 | 3 | 4 | 5) => {
    if (layersToRun.includes(layer)) return "pending" as const;
    return "done" as const;
  };

  // If preflight is fresh and definitively not_news, mark the gated
  // pipeline layers as skipped up front so the polling UI doesn't
  // briefly flash them as "pending" before the workflow short-circuits.
  const willShortCircuit =
    !layersToRun.includes(0) &&
    cachedPreflightVerdict.finding === "not_news";

  const gatedLayerInitialStatus = (layer: 1 | 2 | 3 | 4 | 5) => {
    if (willShortCircuit) return "skipped" as const;
    return layerInitialStatus(layer);
  };

  const [newRun] = await db
    .insert(assessmentRuns)
    .values({
      outletId,
      ipAddress: ip,
      forceRefresh: parsed.forceRefresh,
      preflightStatus: layerInitialStatus(0),
      layer1Status: gatedLayerInitialStatus(1),
      layer2Status: gatedLayerInitialStatus(2),
      layer3Status: gatedLayerInitialStatus(3),
      layer4Status: gatedLayerInitialStatus(4),
      layer5Status: gatedLayerInitialStatus(5),
    })
    .returning({ id: assessmentRuns.id });

  await inngest.send({
    name: "cited/assess.requested",
    data: {
      runId: newRun.id,
      outletId,
      rootDomain: normalized.rootDomain,
      forceRefresh: parsed.forceRefresh,
      layersToRun,
    },
  });

  return NextResponse.json({ id: newRun.id, cached: false });
}
