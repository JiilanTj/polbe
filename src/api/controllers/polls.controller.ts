import type { Context } from "hono";
import { db } from "../../db";
import { adminAuditLogs, polls, pollVotes, users, livesTransactions, notifications, priceSnapshots } from "../../db/schema";
import { eq, desc, sql, and, ilike, type SQL } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { verifyAccessToken } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";
import { parseBody, safeInt, escapeHtml } from "../../lib/validate";
import { pollCreateSchema, pollVoteSchema, pollResolveSchema, pollStatusSchema } from "../../lib/schemas";
import { getPublicUrl } from "../../lib/minio";

function requestIp(c: Context) {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

// ─── Helper: kredit/debit nyawa + catat transaksi ──────────────────────────
async function adjustLives(
  userId: number,
  amount: number,
  type: "vote_debit" | "vote_payout" | "admin_credit" | "admin_debit",
  refId: number,
  refType: string,
  note: string,
): Promise<number> {
  const [current] = await db
    .select({ livesBalance: users.livesBalance })
    .from(users)
    .where(eq(users.id, userId));
  if (!current) throw new Error(`User #${userId} tidak ditemukan`);

  const balanceAfter = Number(current.livesBalance) + amount;
  await db.update(users).set({ livesBalance: balanceAfter.toString() }).where(eq(users.id, userId));
  await db.insert(livesTransactions).values({
    userId,
    amount: amount.toString(),
    type,
    refId,
    refType,
    note,
    balanceAfter: balanceAfter.toString()
  });
  return balanceAfter;
}

export const pollsController = {
  // GET /api/polls — daftar poll (publik)
  async list(c: Context) {
    const pageParam = Number(c.req.query("page") || "1");
    const limitParam = Number(c.req.query("limit") || "20");
    const page = Number.isFinite(pageParam) ? Math.max(Math.floor(pageParam), 1) : 1;
    const limit = Number.isFinite(limitParam) ? Math.min(Math.max(Math.floor(limitParam), 1), 100) : 20;
    const status = c.req.query("status");
    const category = c.req.query("category");
    const q = c.req.query("q")?.trim();
    const offset = (page - 1) * limit;
    const conditions: SQL[] = [];

    if (status) conditions.push(eq(polls.status, status as any));
    if (category) conditions.push(eq(polls.category, category));
    if (q) conditions.push(ilike(polls.title, `%${q}%`));

    const whereClause = conditions.length > 0 ? and(...conditions) : undefined;
    let baseQuery = db.select().from(polls).$dynamic();
    let countQuery = db.select({ total: sql<number>`count(*)` }).from(polls).$dynamic();

    if (whereClause) {
      baseQuery = baseQuery.where(whereClause);
      countQuery = countQuery.where(whereClause);
    }

    const [rows, countRows] = await Promise.all([
      baseQuery.orderBy(desc(polls.createdAt)).limit(limit).offset(offset),
      countQuery,
    ]);
    const total = Number(countRows[0]?.total ?? 0);

    // Hitung total pool dan distribusi per poll
    const dataWithDist = await Promise.all(rows.map(async (poll) => {
      const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id));

      const distribution = poll.options.map((label, index) => {
        const votesForOption = votes.filter(v => v.optionIndex === index);
        return {
          index,
          label,
          votes: votesForOption.length,
          totalLives: votesForOption.reduce((sum, v) => sum + Number(v.livesWagered), 0),
        };
      });

      const totalPool = distribution.reduce((sum, d) => sum + d.totalLives, 0);

      return {
        ...poll,
        imageUrl: getPublicUrl(poll.imageUrl),
        totalPool,
        distribution,
      };
    }));

    return c.json({
      data: dataWithDist,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },

  // GET /api/polls/trending — poll aktif diurutkan berdasarkan totalVotes DESC
  async trending(c: Context) {
    const limit = Math.min(Number(c.req.query("limit") || "10"), 50);
    const rows = await db
      .select()
      .from(polls)
      .where(eq(polls.status, "active"))
      .orderBy(desc(polls.totalVotes))
      .limit(limit);

    const dataWithDist = await Promise.all(rows.map(async (poll) => {
      const votes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, poll.id));

      const distribution = poll.options.map((label, index) => {
        const votesForOption = votes.filter(v => v.optionIndex === index);
        return {
          index,
          label,
          votes: votesForOption.length,
          totalLives: votesForOption.reduce((sum, v) => sum + Number(v.livesWagered), 0),
        };
      });

      const totalPool = distribution.reduce((sum, d) => sum + d.totalLives, 0);

      return {
        ...poll,
        imageUrl: getPublicUrl(poll.imageUrl),
        totalPool,
        distribution,
      };
    }));

    return c.json({ data: dataWithDist });
  },

  // GET /api/polls/:id — detail poll + distribusi suara (Pool-based)
  async getById(c: Context) {
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID poll tidak valid" }, 400);

    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    // Hitung distribusi suara/nyawa per opsi
    const voteStats = await db
      .select({
        optionIndex: pollVotes.optionIndex,
        totalLives: sql<number>`SUM(${pollVotes.livesWagered})`,
        voters: sql<number>`COUNT(DISTINCT ${pollVotes.userId})`,
      })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id))
      .groupBy(pollVotes.optionIndex);

    const totalPool = voteStats.reduce((sum, s) => sum + Number(s.totalLives), 0);

    const distribution = (poll.options ?? []).map((opt: string, idx: number) => {
      const stats = voteStats.find((s) => s.optionIndex === idx);
      const lives = Number(stats?.totalLives ?? 0);
      const percentage = totalPool > 0 ? (lives / totalPool * 100).toFixed(1) : (100 / poll.options.length).toFixed(1);
      return {
        index: idx,
        label: opt,
        totalLives: lives,
        voters: Number(stats?.voters ?? 0),
        percentage: Number(percentage),
      };
    });

    // Info vote user sendiri jika login
    let userVotes = null;
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = await verifyAccessToken(authHeader.slice(7));
        const viewerId = Number(payload.sub);
        userVotes = await db
          .select()
          .from(pollVotes)
          .where(and(eq(pollVotes.pollId, id), eq(pollVotes.userId, viewerId)));
      } catch { }
    }

    const stats = {
      totalPool,
      totalParticipants: voteStats.reduce((sum, s) => sum + Number(s.voters), 0),
    };

    return c.json({ data: { ...poll, distribution, userVotes, stats } });
  },

  // POST /api/polls — admin/platform buat poll
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await parseBody(c, pollCreateSchema);
    if (body instanceof Response) return body;

    const {
      title, description, category, options, imageUrl,
      startAt, endAt, livesPerVote, platformFeePercent,
      sourceArticleIds, aiGenerated,
    } = body;

    const [poll] = await db
      .insert(polls)
      .values({
        title: escapeHtml(title.trim()),
        description: description ? escapeHtml(description) : null,
        category: category ?? null,
        options: options.map((o: string) => escapeHtml(o)),
        imageUrl: imageUrl ?? null,
        status: "draft",
        creatorId: Number(me.sub),
        aiGenerated,
        sourceArticleIds: Array.isArray(sourceArticleIds) ? sourceArticleIds : null,
        startAt: startAt ? new Date(startAt) : null,
        endAt: endAt ? new Date(endAt) : null,
        livesPerVote: livesPerVote ?? 1,
        platformFeePercent: String(platformFeePercent ?? "30"),
      })
      .returning();

    if (!poll) return c.json({ error: "Gagal membuat poll" }, 500);

    if (poll) {
      await db.insert(adminAuditLogs).values({
        adminId: Number(me.sub),
        action: "create_poll",
        targetResourceId: poll.id,
        targetResourceType: "poll",
        metadata: { title: poll.title, status: poll.status, aiGenerated: poll.aiGenerated },
        ipAddress: requestIp(c),
      });
    }

    return c.json({
      data: {
        ...poll,
        imageUrl: getPublicUrl(poll.imageUrl),
      },
    }, 201);
  },

  // PATCH /api/polls/:id/status — admin ubah status
  async updateStatus(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, pollStatusSchema);
    if (body instanceof Response) return body;

    const { status } = body;
    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    const [updated] = await db
      .update(polls)
      .set({ status: status as any, updatedAt: new Date() })
      .where(eq(polls.id, id))
      .returning();
    if (!updated) return c.json({ error: "Gagal mengubah status poll" }, 500);

    if (status === "active" && poll.status !== "active") {
      broadcastEvent("poll:activated", { pollId: updated.id, title: updated.title }, "polls");
    }

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "change_poll_status",
      targetResourceId: id,
      targetResourceType: "poll",
      metadata: { from: poll.status, to: status },
      ipAddress: requestIp(c),
    });

    return c.json({ data: updated });
  },

  // POST /api/polls/:id/vote — user pasang nyawa di opsi tertentu
  async vote(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await c.req.json().catch(() => ({}));
    const optionIndex = Number(body.optionIndex);
    const livesToWager = Number(body.livesWagered || 1);

    if (livesToWager <= 0) return c.json({ error: "Jumlah nyawa harus > 0" }, 422);

    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    if (poll.status !== "active") return c.json({ error: "Poll tidak aktif" }, 400);
    if (optionIndex < 0 || optionIndex >= (poll.options?.length ?? 0)) {
      return c.json({ error: "Opsi tidak valid" }, 422);
    }

    // Cek saldo
    const [userData] = await db.select({ livesBalance: users.livesBalance }).from(users).where(eq(users.id, Number(me.sub)));
    if (!userData || Number(userData.livesBalance) < livesToWager) {
      return c.json({ error: "Nyawa tidak cukup" }, 400);
    }

    // Transaksi
    await db.transaction(async (tx) => {
      // Debit nyawa
      const balanceAfter = Number(userData.livesBalance) - livesToWager;
      await tx.update(users).set({ livesBalance: balanceAfter.toString() }).where(eq(users.id, Number(me.sub)));

      // Simpan transaksi
      const [txRow] = await tx.insert(livesTransactions).values({
        userId: Number(me.sub),
        amount: (-livesToWager).toString(),
        type: "vote_debit",
        refId: pollId,
        refType: "poll",
        note: `Pasang ${livesToWager} nyawa di opsi: ${poll.options?.[optionIndex]}`,
        balanceAfter: balanceAfter.toString(),
      }).returning();

      // Simpan vote (oleh berkali-kali)
      await tx.insert(pollVotes).values({
        pollId,
        userId: Number(me.sub),
        optionIndex,
        livesWagered: livesToWager.toString(),
      });

      // Update total votes/volume di tabel polls (denormalisasi)
      await tx.update(polls)
        .set({
          totalVotes: sql`${polls.totalVotes} + 1`,
          totalVolume: (Number(poll.totalVolume || 0) + livesToWager).toString(),
          prizePool: (Number(poll.prizePool || 0) + livesToWager).toString(),
          updatedAt: new Date()
        })
        .where(eq(polls.id, pollId));
    });

    const voteStats = await db
      .select({
        optionIndex: pollVotes.optionIndex,
        totalLives: sql<number>`SUM(${pollVotes.livesWagered})`,
      })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, pollId))
      .groupBy(pollVotes.optionIndex);

    const totalLives = voteStats.reduce((sum, item) => sum + Number(item.totalLives), 0);
    if (totalLives > 0) {
      const lastPrices: Record<string, string> = {};
      for (let i = 0; i < (poll.options?.length ?? 0); i++) {
        const optionLives = Number(voteStats.find((item) => item.optionIndex === i)?.totalLives ?? 0);
        const price = optionLives / totalLives;
        const fixedPrice = price.toFixed(4);
        lastPrices[String(i)] = fixedPrice;
        await db.insert(priceSnapshots).values({
          pollId,
          optionIndex: i,
          price: fixedPrice,
        });
      }
      await db.update(polls)
        .set({ lastPrices, updatedAt: new Date() })
        .where(eq(polls.id, pollId));
    }

    const [updatedPoll] = await db
      .select({ totalVotes: polls.totalVotes })
      .from(polls)
      .where(eq(polls.id, pollId));

    broadcastEvent("poll:vote_cast", {
      pollId,
      optionIndex,
      livesWagered: livesToWager,
      totalVotes: updatedPoll?.totalVotes ?? Number(poll.totalVotes) + 1,
    }, "polls");

    return c.json({ message: "Berhasil memasang nyawa!" }, 201);
  },

  // GET /api/polls/:id/my-vote — lihat vote user yang sedang login di poll ini
  async myVote(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const votes = await db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, Number(me.sub))));

    return c.json({ data: votes });
  },

  // PATCH /api/polls/:id/resolve — admin tentukan pemenang + payout 70/30
  async resolve(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, pollResolveSchema);
    if (body instanceof Response) return body;
    const { winnerOptionIndex } = body;

    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll || poll.status === "resolved") return c.json({ error: "Poll tidak valid atau sudah selesai" }, 400);

    // Ambil semua suara
    const allVotes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    const winnersVotes = allVotes.filter(v => v.optionIndex === winnerOptionIndex);
    const losersVotes = allVotes.filter(v => v.optionIndex !== winnerOptionIndex);

    const totalWinnersWagered = winnersVotes.reduce((sum, v) => sum + Number(v.livesWagered), 0);
    const totalLosersWagered = losersVotes.reduce((sum, v) => sum + Number(v.livesWagered), 0);

    // ─── Payout Logic: 70% dr yg kalah di bagi jumlah yg bener ──────────────
    if (totalWinnersWagered > 0) {
      const prizePool = totalLosersWagered * 0.7;
      const bonusPerLife = prizePool / totalWinnersWagered;

      // Group winners by user (jika user vote berkali-kali)
      const userPayouts: Record<number, number> = {};
      winnersVotes.forEach(v => {
        const livesWageredNum = Number(v.livesWagered);
        const bonus = livesWageredNum * bonusPerLife;
        const payout = livesWageredNum + bonus;
        userPayouts[v.userId] = (userPayouts[v.userId] || 0) + payout;
      });

      for (const [userIdStr, amount] of Object.entries(userPayouts)) {
        const userId = Number(userIdStr);
        await adjustLives(userId, amount, "vote_payout", pollId, "poll", `Menang poll #${pollId} - Payout: ${amount} nyawa`);

        await db.insert(notifications).values({
          userId,
          type: "payout_credited",
          title: "Kamu Menang!",
          body: `Selamat! Kamu mendapatkan ${amount} nyawa dari poll: ${poll.title}`,
          refId: pollId,
          refType: "poll",
        });

        broadcastEvent("poll:payout", { pollId, payout: amount }, `user:${userId}`);
      }
    }

    // Update poll status
    await db.update(polls)
      .set({ status: "resolved", winnerOptionIndex, resolvedAt: new Date(), resolvedBy: Number(me.sub) })
      .where(eq(polls.id, pollId));

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "resolve_poll",
      targetResourceId: pollId,
      targetResourceType: "poll",
      metadata: { winnerOptionIndex, totalWinnersWagered, totalLosersWagered },
      ipAddress: requestIp(c),
    });

    broadcastEvent("poll:resolved", { pollId, winnerOptionIndex }, "polls");

    return c.json({ message: "Poll berhasil di-resolve!" });
  },

  async deletePoll(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID poll tidak valid" }, 400);
    const [poll] = await db.select({ id: polls.id, title: polls.title, status: polls.status }).from(polls).where(eq(polls.id, id));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    await db.delete(pollVotes).where(eq(pollVotes.pollId, id));
    await db.delete(polls).where(eq(polls.id, id));
    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "delete_poll",
      targetResourceId: id,
      targetResourceType: "poll",
      metadata: { title: poll.title, status: poll.status },
      ipAddress: requestIp(c),
    });
    return c.json({ message: "Poll dihapus" });
  },

  // GET /api/polls/:id/activity — daftar orang yang pasang nyawa (recent votes)
  async getActivity(c: Context) {
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const limit = Math.min(Number(c.req.query("limit") || "50"), 100);

    const rows = await db
      .select({
        id: pollVotes.id,
        userId: pollVotes.userId,
        username: users.username,
        optionIndex: pollVotes.optionIndex,
        livesWagered: pollVotes.livesWagered,
        createdAt: pollVotes.createdAt,
      })
      .from(pollVotes)
      .leftJoin(users, eq(pollVotes.userId, users.id))
      .where(eq(pollVotes.pollId, pollId))
      .orderBy(desc(pollVotes.createdAt))
      .limit(limit);

    // Format agar cocok dengan UI Flutter (map to activity format)
    const formatted = rows.map(r => ({
      ...r,
      type: "vote",
      price: r.livesWagered, // map livesWagered ke field price buat UI
    }));

    return c.json({ data: formatted });
  },
};
