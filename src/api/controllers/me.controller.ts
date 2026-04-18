import type { Context } from "hono";
import { db } from "../../db";
import {
  users, livesTransactions, referralEarnings, topupRequests, withdrawalRequests, pollVotes, polls,
} from "../../db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
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
};
