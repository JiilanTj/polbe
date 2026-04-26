import type { Context } from "hono";
import { db } from "../../db";
import {
  users,
  livesTransactions,
  referralEarnings,
  topupRequests,
  withdrawalRequests,
  pollVotes,
  polls,
  orders,
  watchlist,
  notifications,
} from "../../db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { parseBody } from "../../lib/validate";
import { updateProfileSchema } from "../../lib/schemas";
import { getPublicUrl } from "../../lib/minio";

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
        contributorUntil: users.contributorUntil,
        createdAt: users.createdAt,
      })
      .from(users)
      .where(eq(users.id, Number(me.sub)));

    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    // Total referral earnings
    const [earningsRow] = await db
      .select({
        totalUsdtEarned: sql<string>`COALESCE(SUM(usdt_earned), 0)`,
        totalReferrals: sql<number>`COUNT(DISTINCT referee_id)`,
      })
      .from(referralEarnings)
      .where(eq(referralEarnings.referrerId, Number(me.sub)));

    return c.json({
      data: {
        ...user,
        avatarUrl: getPublicUrl(user.avatarUrl),
        referralStats: {
          totalReferrals: Number(earningsRow?.totalReferrals ?? 0),
          totalUsdtEarned: earningsRow?.totalUsdtEarned ?? "0",
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
      const valid = await Bun.password.verify(
        currentPassword!,
        user.passwordHash,
      );
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
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
        avatarUrl: users.avatarUrl,
        updatedAt: users.updatedAt,
      });

    if (!updated) return c.json({ error: "Gagal memperbarui profil" }, 500);

    return c.json({
      message: "Profil berhasil diperbarui",
      data: {
        ...updated,
        avatarUrl: getPublicUrl(updated.avatarUrl),
      },
    });
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
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / limit),
      },
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
      .select({
        id: referralEarnings.id,
        refereeId: referralEarnings.refereeId,
        topupRequestId: referralEarnings.topupRequestId,
        usdtEarned: referralEarnings.usdtEarned,
        createdAt: referralEarnings.createdAt,
      })
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
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / limit),
      },
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
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / limit),
      },
    });
  },

  // GET /api/me/polls/created — poll yang dibuat oleh user ini
  async createdPolls(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select()
      .from(polls)
      .where(eq(polls.creatorId, Number(me.sub)))
      .orderBy(desc(polls.createdAt))
      .limit(limit)
      .offset(offset);

    const countResult = await db
      .select({ total: sql<number>`count(*)` })
      .from(polls)
      .where(eq(polls.creatorId, Number(me.sub)));
    const total = countResult[0]?.total ?? 0;

    return c.json({
      data: rows,
      pagination: {
        page,
        limit,
        total: Number(total),
        totalPages: Math.ceil(Number(total) / limit),
      },
    });
  },

  // GET /api/me/portfolio — posisi pool dari riwayat pasang nyawa user
  async portfolio(c: Context) {
    const me = c.get("user") as TokenPayload;

    const poolRows = await db
      .select({
        pollId: pollVotes.pollId,
        optionIndex: pollVotes.optionIndex,
        pollTitle: polls.title,
        pollOptions: polls.options,
        pollStatus: polls.status,
        pollWinner: polls.winnerOptionIndex,
        lastPrices: polls.lastPrices,
        shares: sql<string>`SUM(${pollVotes.livesWagered})`,
        totalLivesIn: sql<string>`SUM(${pollVotes.livesWagered})`,
        firstAt: sql<Date>`MIN(${pollVotes.createdAt})`,
        updatedAt: sql<Date>`MAX(${pollVotes.createdAt})`,
      })
      .from(pollVotes)
      .innerJoin(polls, eq(polls.id, pollVotes.pollId))
      .where(eq(pollVotes.userId, Number(me.sub)))
      .groupBy(
        pollVotes.pollId,
        pollVotes.optionIndex,
        polls.title,
        polls.options,
        polls.status,
        polls.winnerOptionIndex,
        polls.lastPrices,
      )
      .orderBy(desc(sql`MAX(${pollVotes.createdAt})`));

    const poolPositions = poolRows.map((r) => {
      const lastPrices = (r.lastPrices as Record<string, string>) || {};
      const currentPrice = lastPrices[String(r.optionIndex)] ?? null;
      const shares = Number(r.shares);
      const avgEntry = 1;
      const unrealizedPnl =
        currentPrice !== null
          ? Number((shares * Number(currentPrice) - shares).toFixed(2))
          : null;

      return {
        source: "pool",
        pollId: r.pollId,
        pollTitle: r.pollTitle,
        pollStatus: r.pollStatus,
        optionIndex: r.optionIndex,
        optionLabel:
          (r.pollOptions as string[])?.[r.optionIndex] ?? String(r.optionIndex),
        shares,
        livesWagered: shares,
        avgEntryPrice: avgEntry.toFixed(4),
        totalLivesIn: Number(r.totalLivesIn),
        realizedPnl: 0,
        currentPrice,
        unrealizedPnl,
        currentValue:
          currentPrice !== null
            ? Number((shares * Number(currentPrice)).toFixed(2))
            : null,
        createdAt: r.firstAt,
        updatedAt: r.updatedAt,
      };
    });

    return c.json({ data: poolPositions });
  },

  // GET /api/me/orders — legacy CLOB orders, tidak dipakai di flow pasang nyawa
  async myOrders(c: Context) {
    const me = c.get("user") as TokenPayload;
    const status = c.req.query("status"); // open, partial, filled, cancelled
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        order: orders,
        pollTitle: polls.title,
        pollOptions: polls.options,
      })
      .from(orders)
      .innerJoin(polls, eq(polls.id, orders.pollId))
      .where(
        and(
          eq(orders.userId, Number(me.sub)),
          ...(status ? [eq(orders.status, status as any)] : []),
        ),
      )
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);
    const data = rows.map((r) => ({
      ...r.order,
      pollTitle: r.pollTitle,
      optionLabel:
        (r.pollOptions as string[])?.[r.order.optionIndex] ??
        String(r.order.optionIndex),
    }));

    return c.json({ data });
  },

  // GET /api/me/trades — riwayat pasang nyawa user ini
  async myTrades(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "30"), 100);
    const offset = (page - 1) * limit;

    const userId = Number(me.sub);

    const poolRows = await db
      .select({
        id: pollVotes.id,
        pollId: pollVotes.pollId,
        pollTitle: polls.title,
        optionIndex: pollVotes.optionIndex,
        pollOptions: polls.options,
        size: pollVotes.livesWagered,
        createdAt: pollVotes.createdAt,
      })
      .from(pollVotes)
      .innerJoin(polls, eq(polls.id, pollVotes.pollId))
      .where(eq(pollVotes.userId, userId))
      .orderBy(desc(pollVotes.createdAt))
      .limit(limit)
      .offset(offset);

    const data = poolRows.map((row) => ({
      id: row.id,
      pollId: row.pollId,
      pollTitle: row.pollTitle,
      optionIndex: row.optionIndex,
      optionLabel:
        (row.pollOptions as string[])?.[row.optionIndex] ??
        String(row.optionIndex),
      side: "pool",
      type: "pool_vote",
      price: "1.0000",
      size: Number(row.size),
      livesTransferred: Number(row.size),
      role: "pool",
      createdAt: row.createdAt,
    }));

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(pollVotes)
      .where(eq(pollVotes.userId, userId));

    return c.json({
      data,
      pagination: {
        page,
        limit,
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

    return c.json({
      data: rows.map((r) => ({ ...r.poll, watchedAt: r.watchedAt })),
    });
  },

  // POST /api/me/watchlist/:pollId — tambah ke watchlist
  async addWatchlist(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("pollId"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const [poll] = await db
      .select({ id: polls.id })
      .from(polls)
      .where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    await db
      .insert(watchlist)
      .values({ userId: Number(me.sub), pollId })
      .onConflictDoNothing();

    return c.json({ message: "Poll ditambahkan ke watchlist" }, 201);
  },

  // DELETE /api/me/watchlist/:pollId — hapus dari watchlist
  async removeWatchlist(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("pollId"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    await db
      .delete(watchlist)
      .where(
        and(eq(watchlist.userId, Number(me.sub)), eq(watchlist.pollId, pollId)),
      );

    return c.json({ message: "Poll dihapus dari watchlist" });
  },

  // GET /api/me/notifications — daftar notifikasi user
  async getNotifications(c: Context) {
    const me = c.get("user") as TokenPayload;
    const page = Math.max(1, Number(c.req.query("page") || "1"));
    const limit = Math.min(50, Number(c.req.query("limit") || "20"));
    const offset = (page - 1) * limit;
    const unreadOnly = c.req.query("unread") === "true";

    const conditions: any[] = [eq(notifications.userId, Number(me.sub))];
    if (unreadOnly) conditions.push(eq(notifications.isRead, false));

    const rows = await db
      .select()
      .from(notifications)
      .where(and(...conditions))
      .orderBy(desc(notifications.createdAt))
      .limit(limit)
      .offset(offset);

    const countRow = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(notifications)
      .where(eq(notifications.userId, Number(me.sub)));

    const unreadRow = await db
      .select({ unread: sql<number>`COUNT(*) FILTER (WHERE is_read = false)` })
      .from(notifications)
      .where(eq(notifications.userId, Number(me.sub)));

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(countRow[0]?.count ?? 0) },
      unreadCount: Number(unreadRow[0]?.unread ?? 0),
    });
  },

  // PATCH /api/me/notifications/read-all — tandai semua notifikasi sebagai sudah dibaca
  async markAllRead(c: Context) {
    const me = c.get("user") as TokenPayload;

    await db
      .update(notifications)
      .set({ isRead: true })
      .where(
        and(
          eq(notifications.userId, Number(me.sub)),
          eq(notifications.isRead, false),
        ),
      );

    return c.json({ message: "Semua notifikasi ditandai sudah dibaca" });
  },

  // PATCH /api/me/notifications/:id/read — tandai 1 notifikasi sebagai dibaca
  async markOneRead(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = Number(c.req.param("id"));
    if (!id) return c.json({ error: "ID notifikasi tidak valid" }, 400);

    const [n] = await db
      .select({ id: notifications.id })
      .from(notifications)
      .where(
        and(eq(notifications.id, id), eq(notifications.userId, Number(me.sub))),
      );
    if (!n) return c.json({ error: "Notifikasi tidak ditemukan" }, 404);

    await db
      .update(notifications)
      .set({ isRead: true })
      .where(eq(notifications.id, id));

    return c.json({ message: "Notifikasi ditandai sudah dibaca" });
  },

  // POST /api/me/subscribe-contributor — beli level contributor (10 lives/30 hari)
  async subscribeContributor(c: Context) {
    const me = c.get("user") as TokenPayload;
    const userId = Number(me.sub);

    const result = await db.transaction(async (tx) => {
      const [user] = await tx
        .select({
          livesBalance: users.livesBalance,
          contributorUntil: users.contributorUntil,
        })
        .from(users)
        .where(eq(users.id, userId));

      if (!user) throw new Error("User tidak ditemukan");

      const COST = 10;
      if (Number(user.livesBalance) < COST) {
        throw new Error("Nyawa tidak cukup (butuh 10 nyawa)");
      }

      // Hitung tanggal baru
      const now = new Date();
      let newUntil = new Date();
      if (user.contributorUntil && user.contributorUntil > now) {
        // Jika masih aktif, tambahkan dari tanggal expired
        newUntil = new Date(user.contributorUntil.getTime() + 30 * 24 * 60 * 60 * 1000);
      } else {
        // Jika sudah mati, mulai dari sekarang
        newUntil = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
      }

      const balanceAfter = Number(user.livesBalance) - COST;

      // Update user
      await tx
        .update(users)
        .set({
          livesBalance: balanceAfter.toString(),
          contributorUntil: newUntil,
        })
        .where(eq(users.id, userId));

      // Catat transaksi
      await tx.insert(livesTransactions).values({
        userId,
        amount: (-COST).toString(),
        type: "contributor_purchase",
        note: `Upgrade/Extend level Contributor (30 hari)`,
        balanceAfter: balanceAfter.toString(),
      });

      return { balanceAfter, contributorUntil: newUntil };
    }).catch(err => ({ error: err.message }));

    if ("error" in result) {
      return c.json({ error: result.error }, 400);
    }

    return c.json({
      message: "Berhasil upgrade menjadi Contributor!",
      data: result,
    });
  },
};
