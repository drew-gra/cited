import { sql } from "drizzle-orm";
import { inngest } from "./client";
import { db } from "../db";

// Daily retention sweep. Keeps storage bounded without losing recent
// history needed for debugging. Times in UTC.
//
// signals: 90 days, but ALWAYS keep the most recent row per (outlet, layer)
//   so the surgical-refresh cache check in POST /api/assess never misses on
//   a long-tail outlet whose last assessment was >90d ago. The NOT EXISTS
//   clause says "only delete if a newer row exists for the same key."
// probe_log: 30 days. Raw L4 probe records — useful for forensic
//   investigation of recent assessments, not needed long-term.
// ip_rate_limits: 24 hours. The rate-limit window is 1h; 24h gives a
//   generous buffer for any debugging without unbounded growth.
export const retentionCleanup = inngest.createFunction(
  {
    id: "retention-cleanup",
    triggers: [{ cron: "0 3 * * *" }],
  },
  async ({ step }) => {
    const signalsDeleted = await step.run("prune-signals", async () => {
      const result = await db.execute(sql`
        DELETE FROM signals s
        WHERE s.captured_at < NOW() - INTERVAL '90 days'
          AND EXISTS (
            SELECT 1 FROM signals s2
            WHERE s2.outlet_id = s.outlet_id
              AND s2.layer = s.layer
              AND s2.captured_at > s.captured_at
          )
      `);
      return result.rowCount ?? 0;
    });

    const probeLogDeleted = await step.run("prune-probe-log", async () => {
      const result = await db.execute(sql`
        DELETE FROM probe_log
        WHERE captured_at < NOW() - INTERVAL '30 days'
      `);
      return result.rowCount ?? 0;
    });

    const rateLimitsDeleted = await step.run("prune-rate-limits", async () => {
      const result = await db.execute(sql`
        DELETE FROM ip_rate_limits
        WHERE created_at < NOW() - INTERVAL '24 hours'
      `);
      return result.rowCount ?? 0;
    });

    return {
      signalsDeleted,
      probeLogDeleted,
      rateLimitsDeleted,
    };
  },
);
