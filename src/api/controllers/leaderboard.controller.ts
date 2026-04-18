import type { Context } from "hono";
import { db } from "../../db";
import { users, pollVotes, polls } from "../../db/schema";
import { desc, eq, sql } from "drizzle-orm";

export const leaderboardController = {
  // GET /api/leaderboard — ranking berdasarkan saldo nyawa
  async byLives(c: Context) {
    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);

    const rows = await db
      .select({
        rank: sql<number>`ROW_NUMBER() OVER (ORDER BY lives_balance DESC)`,
        id: users.id,
        username: users.username,
        livesBalance: users.livesBalance,
      })
      .from(users)
      .where(eq(users.isActive, true))
      .orderBy(desc(users.livesBalance))
      .limit(limit);

    return c.json({ data: rows });
  },

  // GET /api/leaderboard/wins — ranking berdasarkan total vote menang
  async byWins(c: Context) {
    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);

    // Ambil voter yang pernah menang (payoutLives > 0 artinya di poll yang resolved)
    const rows = await db
      .select({
        userId: pollVotes.userId,
        username: users.username,
        totalWins: sql<number>`count(*)`,
        totalPayoutLives: sql<number>`SUM(CAST(payout_lives AS NUMERIC))`,
      })
      .from(pollVotes)
      .innerJoin(polls, eq(polls.id, pollVotes.pollId))
      .innerJoin(users, eq(users.id, pollVotes.userId))
      .where(eq(polls.status, "resolved"))
      .groupBy(pollVotes.userId, users.username)
      .orderBy(sql`count(*) DESC`)
      .limit(limit);

    const ranked = rows.map((r, idx) => ({ rank: idx + 1, ...r }));
    return c.json({ data: ranked });
  },

  // GET /api/leaderboard/referrals — ranking berdasarkan jumlah referral
  async byReferrals(c: Context) {
    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);

    const rows = await db
      .select({
        id: users.id,
        username: users.username,
        totalReferrals: sql<number>`count(referred.id)`,
      })
      .from(users)
      .leftJoin(
        db.select({ id: users.id, referredBy: users.referredBy }).from(users).as("referred"),
        sql`referred.referred_by = users.id`,
      )
      .where(eq(users.isActive, true))
      .groupBy(users.id, users.username)
      .orderBy(sql`count(referred.id) DESC`)
      .limit(limit);

    const ranked = rows.map((r, idx) => ({ rank: idx + 1, ...r }));
    return c.json({ data: ranked });
  },
};
