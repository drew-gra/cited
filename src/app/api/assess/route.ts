import { NextRequest, NextResponse } from "next/server";
import { z } from "zod";
import { and, desc, eq } from "drizzle-orm";
import { db } from "@/lib/db";
import { outlets, assessmentRuns, signals } from "@/lib/db/schema";
import { normalizeUrl } from "@/lib/domain";
import { checkAndRecordIpRateLimit } from "@/lib/rate-limit";
import { inngest } from "@/lib/inngest/client";

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

  // Cache check (slice 0: only Layer 1 has a TTL to consult).
  if (!parsed.forceRefresh) {
    const [latestL1] = await db
      .select()
      .from(signals)
      .where(and(eq(signals.outletId, outletId), eq(signals.layer, 1)))
      .orderBy(desc(signals.capturedAt))
      .limit(1);

    if (latestL1) {
      const ageSeconds = (Date.now() - latestL1.capturedAt.getTime()) / 1000;
      if (ageSeconds < latestL1.ttlSeconds) {
        const [recentRun] = await db
          .select()
          .from(assessmentRuns)
          .where(
            and(
              eq(assessmentRuns.outletId, outletId),
              eq(assessmentRuns.status, "done"),
            ),
          )
          .orderBy(desc(assessmentRuns.createdAt))
          .limit(1);
        if (recentRun) {
          return NextResponse.json({ id: recentRun.id, cached: true });
        }
      }
    }
  }

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

  const [newRun] = await db
    .insert(assessmentRuns)
    .values({
      outletId,
      ipAddress: ip,
      forceRefresh: parsed.forceRefresh,
    })
    .returning({ id: assessmentRuns.id });

  await inngest.send({
    name: "cited/assess.requested",
    data: {
      runId: newRun.id,
      outletId,
      rootDomain: normalized.rootDomain,
      forceRefresh: parsed.forceRefresh,
    },
  });

  return NextResponse.json({ id: newRun.id, cached: false });
}
