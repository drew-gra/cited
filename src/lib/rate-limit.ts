import { and, eq, gt, sql } from "drizzle-orm";
import { db } from "./db";
import { ipRateLimits } from "./db/schema";
import { ANTI_ABUSE } from "./policy";

export type RateLimitResult = {
  allowed: boolean;
  count: number;
  limit: number;
  resetSeconds: number;
};

export async function checkAndRecordIpRateLimit(
  ipAddress: string,
): Promise<RateLimitResult> {
  const limit = ANTI_ABUSE.freshAssessmentsPerHourPerIp;
  const oneHourAgo = new Date(Date.now() - 60 * 60 * 1000);

  const [{ count }] = await db
    .select({ count: sql<number>`count(*)::int` })
    .from(ipRateLimits)
    .where(
      and(
        eq(ipRateLimits.ipAddress, ipAddress),
        gt(ipRateLimits.createdAt, oneHourAgo),
      ),
    );

  if (count >= limit) {
    return {
      allowed: false,
      count,
      limit,
      resetSeconds: 60 * 60,
    };
  }

  await db.insert(ipRateLimits).values({ ipAddress });

  return {
    allowed: true,
    count: count + 1,
    limit,
    resetSeconds: 60 * 60,
  };
}
