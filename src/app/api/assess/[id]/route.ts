import { NextResponse } from "next/server";
import { desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import {
  outlets,
  assessmentRuns,
  signals,
  type LayerStatus,
  type RunStatus,
} from "@/lib/db/schema";
import type {
  AssessResponse,
  LayerNumber,
  LayerSnapshot,
} from "@/lib/api-types";
import type { RobotsLayer1Result } from "@/lib/layers/robots";
import type { L2Result } from "@/lib/layers/declarations";
import type { L4Result } from "@/lib/layers/ua-probing";
import type { L5Result } from "@/lib/layers/common-crawl";
import type { PreflightSignal } from "@/lib/layers/preflight";
import { detectCdn, type L3Result } from "@/lib/layers/cdn";
import { buildLayerVerdicts } from "@/lib/verdicts";
import { verdictForPreflight } from "@/lib/preflight-verdicts";
import { derivePostures } from "@/lib/posture";

type RouteContext = { params: Promise<{ id: string }> };

export async function GET(_: Request, { params }: RouteContext) {
  const { id } = await params;

  const [run] = await db
    .select()
    .from(assessmentRuns)
    .where(eq(assessmentRuns.id, id))
    .limit(1);
  if (!run) {
    return NextResponse.json({ error: "Run not found." }, { status: 404 });
  }

  const [outlet] = await db
    .select()
    .from(outlets)
    .where(eq(outlets.id, run.outletId))
    .limit(1);
  if (!outlet) {
    return NextResponse.json(
      { error: "Outlet referenced by run not found." },
      { status: 500 },
    );
  }

  const allSignals = await db
    .select()
    .from(signals)
    .where(eq(signals.outletId, run.outletId))
    .orderBy(desc(signals.capturedAt));

  const latestPerLayer = new Map<number, (typeof allSignals)[number]>();
  for (const s of allSignals) {
    if (!latestPerLayer.has(s.layer)) latestPerLayer.set(s.layer, s);
  }

  const buildLayerSnapshot = (
    layer: LayerNumber | 0,
    status: LayerStatus,
  ): LayerSnapshot => {
    const signal = latestPerLayer.get(layer);
    if (!signal) {
      return { status, capturedAt: null, ttlSeconds: null, isStale: false };
    }
    const ageSeconds = (Date.now() - signal.capturedAt.getTime()) / 1000;
    return {
      status,
      capturedAt: signal.capturedAt.toISOString(),
      ttlSeconds: signal.ttlSeconds,
      isStale: ageSeconds >= signal.ttlSeconds,
    };
  };

  const preflightSignal =
    (latestPerLayer.get(0)?.signalValue as PreflightSignal | undefined) ?? null;
  const preflightVerdict = verdictForPreflight(preflightSignal);

  const layer1Signal =
    (latestPerLayer.get(1)?.signalValue as RobotsLayer1Result | undefined) ??
    null;
  const layer2Signal =
    (latestPerLayer.get(2)?.signalValue as L2Result | undefined) ?? null;
  const layer3SignalPersisted =
    (latestPerLayer.get(3)?.signalValue as L3Result | undefined) ?? null;
  const layer4Signal =
    (latestPerLayer.get(4)?.signalValue as L4Result | undefined) ?? null;
  const layer5Signal =
    (latestPerLayer.get(5)?.signalValue as L5Result | undefined) ?? null;

  // Recompute L3 from L2's captured headers on every read so cdn.ts
  // fingerprint additions propagate to historical assessments without
  // requiring a force-refresh. The persisted L3 signal stays in the DB
  // as audit trail; we just don't display it directly. Falls back to
  // the persisted signal if L2 has no usable headers (e.g. L2 fetch
  // failed and captured no response).
  const layer3Signal: L3Result | null = (() => {
    if (!layer2Signal) return layer3SignalPersisted;
    const headers = layer2Signal.homepage.responseHeaders;
    if (!headers || Object.keys(headers).length === 0) {
      return layer3SignalPersisted;
    }
    const recomputed = detectCdn(outlet.rootDomain, headers);
    // Preserve the original capture time so the timestamp keeps its
    // existing meaning ("when L2 was last fetched") rather than
    // misleadingly tracking "when this read happened".
    return {
      ...recomputed,
      fetchedAt: layer3SignalPersisted?.fetchedAt ?? recomputed.fetchedAt,
    };
  })();

  // Derive per-platform postures live from the current layer signals on
  // every read. Lets posture-rule changes (e.g. confidence calibration,
  // edge-block heuristics) take effect against historical assessments
  // without re-running the underlying probes. The persisted assessments
  // table rows remain as the run-time audit record.
  const postures = derivePostures({
    layer1Signal,
    layer2Signal,
    layer3Signal,
    layer4Signal,
    layer5Signal,
  });

  const response: AssessResponse = {
    id: run.id,
    outlet: {
      rootDomain: outlet.rootDomain,
      primaryUrl: outlet.primaryUrl,
    },
    run: {
      status: run.status as RunStatus,
      preflight: buildLayerSnapshot(0, run.preflightStatus as LayerStatus),
      layers: {
        1: buildLayerSnapshot(1, run.layer1Status as LayerStatus),
        2: buildLayerSnapshot(2, run.layer2Status as LayerStatus),
        3: buildLayerSnapshot(3, run.layer3Status as LayerStatus),
        4: buildLayerSnapshot(4, run.layer4Status as LayerStatus),
        5: buildLayerSnapshot(5, run.layer5Status as LayerStatus),
      },
      errorMessage: run.errorMessage,
      createdAt: run.createdAt.toISOString(),
      updatedAt: run.updatedAt.toISOString(),
    },
    assessments: postures,
    preflightSignal,
    preflightVerdict,
    layer1Signal,
    layer2Signal,
    layer3Signal,
    layer4Signal,
    layer5Signal,
    verdicts: buildLayerVerdicts({
      layer1Signal,
      layer2Signal,
      layer3Signal,
      layer4Signal,
      layer5Signal,
    }),
  };

  return NextResponse.json(response);
}
