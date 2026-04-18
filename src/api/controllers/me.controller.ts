import type { Context } from "hono";
import { db } from "../../db";
import {
  users, livesTransactions, referralEarnings, topupRequests, withdrawalRequests,
  pollVotes, polls, positions, orders, trades, watchlist,
} from "../../db/schema";
import { eq, desc, sql, and, or, gt } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { parseBody } from "../../lib/validate";
import { updateProfileSchema } from "../../lib/schemas";

export const meController = {
  // GET /api/me — profil + saldo nyawa + referral code
  async profile(c: Context) {
    const me = c.get("user") as TokenPayload;

    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
        avatarUrl: users.avatarUrl,
        emailVerifiedAt: users.emailVerifiedAt,
        usdtBalance: users.usdtBalance,
        livesBalance: users.livesBalance,
        livesRecoveryAt: users.livesRecoveryAt,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, Number(me.sub)));

    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    // Total referral earnings
    const [earningsRow] = await db
      .select({
        totalUsdtEarned: sql<string>`COALESCE(SUM(usdt_earned), 0)`,
        totalLivesEarned: sql<number>`COALESCE(SUM(lives_earned), 0)`,
        totalReferrals: sql<number>`COUNT(DISTINCT referee_id)`,
      })
      .from(referralEarnings)
      .where(eq(referralEarnings.referrerId, Number(me.sub)));

    return c.json({
      data: {
        ...user,
        referralStats: {
          totalReferrals: Number(earningsRow?.totalReferrals ?? 0),
          totalUsdtEarned: earningsRow?.totalUsdtEarned ?? "0",
          totalLivesEarned: Number(earningsRow?.totalLivesEarned ?? 0),
        },
      },
    });
  },

  // PATCH /api/me — update username, avatarUrl, atau password
  async updateProfile(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await parseBody(c, updateProfileSchema);
    if (body instanceof Response) return body;

    const { username, avatarUrl, currentPassword, newPassword } = body;
    const updates: Record<string, any> = { updatedAt: new Date() };

    if (username?.trim()) {
      // Cek unik
      const [existing] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.username, username.trim()));
      if (existing && existing.id !== Number(me.sub)) {
        return c.json({ error: "Username sudah digunakan" }, 409);
      }
      updates.username = username.trim();
    }

    if (avatarUrl) {
      updates.avatarUrl = avatarUrl;
    }

    if (newPassword) {
      const [user] = await db
        .select({ passwordHash: users.passwordHash })
        .from(users)
        .where(eq(users.id, Number(me.sub)));

      if (!user) return c.json({ error: "User tidak ditemukan" }, 404);
      const valid = await Bun.password.verify(currentPassword!, user.passwordHash);
      if (!valid) return c.json({ error: "Password saat ini salah" }, 401);

      updates.passwordHash = await Bun.password.hash(newPassword);
    }

    if (Object.keys(updates).length === 1) {
      return c.json({ error: "Tidak ada perubahan yang dikirim" }, 422);
    }

    const [updated] = await db
      .update(users)
      .set(updates)
      .where(eq(users.id, Number(me.sub)))
      .returning({
        id: users.id, email: users.email, username: users.username, role: users.role,
        avatarUrl: users.avatarUrl, updatedAt: users.updatedAt,
      });

    return c.json({ message: "Profil berhasil diperbarui", data: updated });
  },

  // GET /api/me/lives-history — riwayat transaksi nyawa
  async livesHistory(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select()
      .from(livesTransactions)
      .where(eq(livesTransactions.userId, Number(me.sub)))
      .orderBy(desc(livesTransactions.createdAt))
      .limit(limit)
      .offset(offset);

    const txCountResult = await db
      .select({ total: sql<number>`count(*)` })
      .from(livesTransactions)
      .where(eq(livesTransactions.userId, Number(me.sub)));
    const total = txCountResult[0]?.total ?? 0;

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  },

  // GET /api/me/referrals — daftar downline + riwayat komisi
  async referrals(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    // Daftar downline (user yang pakai referral code kita)
    const downlines = await db
      .select({
        id: users.id,
        username: users.username,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.referredBy, Number(me.sub)))
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    // Riwayat komisi yang sudah earned
    const earnings = await db
      .select()
      .from(referralEarnings)
      .where(eq(referralEarnings.referrerId, Number(me.sub)))
      .orderBy(desc(referralEarnings.createdAt))
      .limit(10);

    const downlineCountResult = await db
      .select({ total: sql<number>`count(*)` })
      .from(users)
      .where(eq(users.referredBy, Number(me.sub)));
    const total = downlineCountResult[0]?.total ?? 0;

    return c.json({
      data: { downlines, recentEarnings: earnings },
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  },

  // GET /api/me/polls — poll yang pernah divote user ini
  async myPolls(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        vote: pollVotes,
        poll: {
          id: polls.id,
          title: polls.title,
          options: polls.options,
          status: polls.status,
          winnerOptionIndex: polls.winnerOptionIndex,
        },
      })
      .from(pollVotes)
      .innerJoin(polls, eq(polls.id, pollVotes.pollId))
      .where(eq(pollVotes.userId, Number(me.sub)))
      .orderBy(desc(pollVotes.createdAt))
      .limit(limit)
      .offset(offset);

    const pollCountResult = await db
      .select({ total: sql<number>`count(*)` })
      .from(pollVotes)
      .where(eq(pollVotes.userId, Number(me.sub)));
    const total = pollCountResult[0]?.total ?? 0;

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  },

  // GET /api/me/portfolio — semua posisi user + unrealized P&L
  async portfolio(c: Context) {
    const me = c.get("user") as TokenPayload;

    const rows = await db
      .select({
        position: positions,
        pollTitle: polls.title,
        pollOptions: polls.options,
        pollStatus: polls.status,
        pollWinner: polls.winnerOptionIndex,
        lastPrices: polls.lastPrices,
      })
      .from(positions)
      .innerJoin(polls, eq(polls.id, positions.pollId))
      .where(and(
        eq(positions.userId, Number(me.sub)),
        gt(positions.shares, 0),
      ))
      .orderBy(desc(positions.updatedAt));

    const data = rows.map((r) => {
      const lastPrices = (r.lastPrices as Record<string, string>) || {};
      const currentPrice = lastPrices[String(r.position.optionIndex)] ?? null;
      const shares = r.position.shares;
      const avgEntry = Number(r.position.avgEntryPrice);
      const unrealizedPnl = currentPrice !== null
        ? Math.round(shares * (Number(currentPrice) - avgEntry))
        : null;

      return {
        pollId: r.position.pollId,
        pollTitle: r.pollTitle,
        pollStatus: r.pollStatus,
        optionIndex: r.position.optionIndex,
        optionLabel: (r.pollOptions as string[])?.[r.position.optionIndex] ?? String(r.position.optionIndex),
        shares,
        avgEntryPrice: avgEntry.toFixed(4),
        totalLivesIn: r.position.totalLivesIn,
        realizedPnl: r.position.realizedPnl,
        currentPrice,
        unrealizedPnl,
        currentValue: currentPrice !== null ? Math.round(shares * Number(currentPrice)) : null,
      };
    });

    return c.json({ data });
  },

  // GET /api/me/orders — order aktif + riwayat order user
  async myOrders(c: Context) {
    const me = c.get("user") as TokenPayload;
    const status = c.req.query("status"); // open, partial, filled, cancelled
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select({ order: orders, pollTitle: polls.title, pollOptions: polls.options })
      .from(orders)
      .innerJoin(polls, eq(polls.id, orders.pollId))
      .where(and(
        eq(orders.userId, Number(me.sub)),
        ...(status ? [eq(orders.status, status as any)] : []),
      ))
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);
    const data = rows.map((r) => ({
      ...r.order,
      pollTitle: r.pollTitle,
      optionLabel: (r.pollOptions as string[])?.[r.order.optionIndex] ?? String(r.order.optionIndex),
    }));

    return c.json({ data });
  },

  // GET /api/me/trades — riwayat semua trade yang melibatkan user ini
  async myTrades(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "30"), 100);
    const offset = (page - 1) * limit;

    const userId = Number(me.sub);

    const rows = await db
      .select({
        id: trades.id,
        pollId: trades.pollId,
        pollTitle: polls.title,
        optionIndex: trades.optionIndex,
        side: trades.side,
        price: trades.price,
        size: trades.size,
        livesTransferred: trades.livesTransferred,
        role: sql<string>`CASE WHEN ${trades.makerUserId} = ${userId} THEN 'maker' ELSE 'taker' END`,
        createdAt: trades.createdAt,
      })
      .from(trades)
      .innerJoin(polls, eq(polls.id, trades.pollId))
      .where(or(eq(trades.makerUserId, userId), eq(trades.takerUserId, userId)))
      .orderBy(desc(trades.createdAt))
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(trades)
      .where(or(eq(trades.makerUserId, userId), eq(trades.takerUserId, userId)));

    return c.json({
      data: rows,
      pagination: {
        page, limit,
        total: Number(countRow?.count ?? 0),
        totalPages: Math.ceil(Number(countRow?.count ?? 0) / limit),
      },
    });
  },

  // GET /api/me/watchlist — daftar poll yang di-bookmark
  async getWatchlist(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select({ watchedAt: watchlist.createdAt, poll: polls })
      .from(watchlist)
      .innerJoin(polls, eq(polls.id, watchlist.pollId))
      .where(eq(watchlist.userId, Number(me.sub)))
      .orderBy(desc(watchlist.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data: rows.map(r => ({ ...r.poll, watchedAt: r.watchedAt })) });
  },

  // POST /api/me/watchlist/:pollId — tambah ke watchlist
  async addWatchlist(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("pollId"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const [poll] = await db.select({ id: polls.id }).from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    await db.insert(watchlist)
      .values({ userId: Number(me.sub), pollId })
      .onConflictDoNothing();

    return c.json({ message: "Poll ditambahkan ke watchlist" }, 201);
  },

  // DELETE /api/me/watchlist/:pollId — hapus dari watchlist
  async removeWatchlist(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("pollId"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    await db.delete(watchlist)
      .where(and(eq(watchlist.userId, Number(me.sub)), eq(watchlist.pollId, pollId)));

    return c.json({ message: "Poll dihapus dari watchlist" });
  },
};
