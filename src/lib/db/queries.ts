import { desc, eq, type InferSelectModel } from "drizzle-orm";
import type { z } from "zod";
import { db } from ".";
import { signals } from "./schema";

export type SignalRow = InferSelectModel<typeof signals>;

// Validate a persisted signal value against its current Zod schema. Persisted
// `signalValue` is JSONB in Postgres — Drizzle gives it back as `unknown` —
// so without runtime validation, a shape change in a layer module would
// silently propagate `undefined` into verdict translators (best case:
// inconclusive headlines; worst case: wrong verdicts). On parse failure we
// log + return null so the verdict layer degrades to its existing
// "no signal available" path rather than crashing the page.
export function parseSignal<S extends z.ZodTypeAny>(
  row: SignalRow | undefined,
  schema: S,
  context: { outletId: string; layer: number },
): z.infer<S> | null {
  if (!row) return null;
  const result = schema.safeParse(row.signalValue);
  if (result.success) return result.data;
  console.error(
    `[cited] Persisted layer-${context.layer} signal for outlet ${context.outletId} failed schema validation; treating as missing.`,
    result.error.issues,
  );
  return null;
}

// Returns the most recent signal row per layer for the given outlet, in a
// single query. Replaces the N+1 pattern of one query per implemented layer
// (POST /api/assess) and the "select all signals + dedupe in JS" pattern
// (GET /api/assess/[id]). Postgres DISTINCT ON keeps the first row per
// `layer` after ORDER BY, so the ORDER BY must lead with `layer` and then
// sort `captured_at DESC` to pick the newest within each layer.
export async function loadLatestSignalsPerLayer(
  outletId: string,
): Promise<Map<number, SignalRow>> {
  const rows = await db
    .selectDistinctOn([signals.layer])
    .from(signals)
    .where(eq(signals.outletId, outletId))
    .orderBy(signals.layer, desc(signals.capturedAt));
  const map = new Map<number, SignalRow>();
  for (const row of rows) map.set(row.layer, row);
  return map;
}
