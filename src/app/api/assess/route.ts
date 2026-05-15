import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outlets, assessmentRuns, signals } from "@/lib/db/schema";
import { normalizeUrl } from "@/lib/domain";
import { checkAndRecordIpRateLimit } from "@/lib/rate-limit";
import { inngest } from "@/lib/inngest/client";

// Layers the Inngest workflow currently runs end-to-end. The cache check
// only short-circuits when every one of these has a fresh signal AND the
// most-recent run has all of them marked done (not skipped). Add layers
// here as they ship.
const IMPLEMENTED_LAYERS = [1, 2, 3, 5] as const;

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
          eq(assessmentRuns.layer1Status, "done"),
          eq(assessmentRuns.layer2Status, "done"),
          eq(assessmentRuns.layer3Status, "done"),
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
  // running → done. L4 is not yet implemented, so it stays "skipped."
  const layerInitialStatus = (layer: 1 | 2 | 3 | 4 | 5) => {
    if (layer === 4) return "skipped" as const;
    if (layersToRun.includes(layer)) return "pending" as const;
    return "done" as const;
  };

  const [newRun] = await db
    .insert(assessmentRuns)
    .values({
      outletId,
      ipAddress: ip,
      forceRefresh: parsed.forceRefresh,
      layer1Status: layerInitialStatus(1),
      layer2Status: layerInitialStatus(2),
      layer3Status: layerInitialStatus(3),
      layer4Status: layerInitialStatus(4),
      layer5Status: layerInitialStatus(5),
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
