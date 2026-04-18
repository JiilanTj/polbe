import type { Context } from "hono";
import { db } from "../../db";
import { polls, pollVotes, users, livesTransactions } from "../../db/schema";
import { eq, desc, sql, and } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";

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

  const balanceAfter = current.livesBalance + amount;
  await db.update(users).set({ livesBalance: balanceAfter }).where(eq(users.id, userId));
  await db.insert(livesTransactions).values({ userId, amount, type, refId, refType, note, balanceAfter });
  return balanceAfter;
}

export const pollsController = {
  // GET /api/polls — daftar poll (publik)
  async list(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const status = c.req.query("status");
    const category = c.req.query("category");
    const offset = (page - 1) * limit;

    let query = db
      .select()
      .from(polls)
      .orderBy(desc(polls.createdAt))
      .limit(limit)
      .offset(offset);

    if (status) query = query.where(eq(polls.status, status as any)) as typeof query;
    if (category) query = query.where(eq(polls.category, category)) as typeof query;

    const rows = await query;
    const countResult = await db.select({ count: sql<number>`count(*)` }).from(polls);
    const count = countResult[0]?.count ?? 0;

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
    });
  },

  // GET /api/polls/:id — detail poll + distribusi suara
  async getById(c: Context) {
    const id = Number(c.req.param("id"));
    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    // Hitung distribusi suara per opsi
    const voteCounts = await db
      .select({
        optionIndex: pollVotes.optionIndex,
        count: sql<number>`count(*)`,
        totalLives: sql<number>`sum(${pollVotes.livesWagered})`,
      })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, id))
      .groupBy(pollVotes.optionIndex);

    const distribution = (poll.options ?? []).map((opt: string, idx: number) => {
      const stats = voteCounts.find((v) => v.optionIndex === idx);
      return {
        index: idx,
        label: opt,
        votes: Number(stats?.count ?? 0),
        totalLives: Number(stats?.totalLives ?? 0),
      };
    });

    const totalVotes = distribution.reduce((s, d) => s + d.votes, 0);

    return c.json({ data: { ...poll, distribution, totalVotes } });
  },

  // POST /api/polls — admin/platform buat poll
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const {
      title, description, category, options, imageUrl,
      startAt, endAt, livesPerVote, platformFeePercent,
      sourceArticleIds, aiGenerated,
    } = body as Record<string, any>;

    if (!title?.trim()) return c.json({ error: "Field 'title' wajib diisi" }, 422);
    if (!Array.isArray(options) || options.length < 2) {
      return c.json({ error: "Minimal 2 opsi diperlukan" }, 422);
    }
    if (options.length > 10) {
      return c.json({ error: "Maksimal 10 opsi" }, 422);
    }
    if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
      return c.json({ error: "startAt harus sebelum endAt" }, 422);
    }

    const feePercent = Number(platformFeePercent ?? 30);
    if (feePercent < 0 || feePercent > 100) {
      return c.json({ error: "platformFeePercent harus 0–100" }, 422);
    }

    const [poll] = await db
      .insert(polls)
      .values({
        title: title.trim(),
        description: description ?? null,
        category: category ?? null,
        options,
        imageUrl: imageUrl ?? null,
        status: "draft",
        creatorId: Number(me.sub),
        aiGenerated: Boolean(aiGenerated),
        sourceArticleIds: Array.isArray(sourceArticleIds) ? sourceArticleIds : null,
        startAt: startAt ? new Date(startAt) : null,
        endAt: endAt ? new Date(endAt) : null,
        livesPerVote: Number(livesPerVote ?? 1),
        platformFeePercent: String(feePercent),
      })
      .returning();

    return c.json({ data: poll }, 201);
  },

  // PATCH /api/polls/:id/status — admin ubah status (draft → active, dsb)
  async updateStatus(c: Context) {
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { status } = body as { status: string };
    const VALID = ["draft", "active", "resolved", "closed"];
    if (!VALID.includes(status)) {
      return c.json({ error: `Status tidak valid. Pilihan: ${VALID.join(", ")}` }, 422);
    }

    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    if (["resolved", "closed"].includes(poll.status)) {
      return c.json({ error: `Poll sudah ${poll.status}, tidak bisa diubah` }, 409);
    }

    const [updated] = await db
      .update(polls)
      .set({ status: status as any, updatedAt: new Date() })
      .where(eq(polls.id, id))
      .returning();

    return c.json({ data: updated });
  },

  // POST /api/polls/:id/vote — user vote (costs livesPerVote nyawa)
  async vote(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { optionIndex } = body as { optionIndex?: number };
    if (optionIndex === undefined || optionIndex === null) {
      return c.json({ error: "Field 'optionIndex' wajib diisi" }, 422);
    }

    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    if (poll.status !== "active") return c.json({ error: "Poll belum aktif atau sudah selesai" }, 400);
    if (optionIndex < 0 || optionIndex >= (poll.options?.length ?? 0)) {
      return c.json({ error: `optionIndex tidak valid (0–${(poll.options?.length ?? 1) - 1})` }, 422);
    }

    // Cek sudah vote belum
    const [existing] = await db
      .select({ id: pollVotes.id })
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, Number(me.sub))));

    if (existing) return c.json({ error: "Kamu sudah vote di poll ini" }, 409);

    // Cek saldo nyawa cukup
    const [userData] = await db
      .select({ livesBalance: users.livesBalance })
      .from(users)
      .where(eq(users.id, Number(me.sub)));

    if (!userData) return c.json({ error: "User tidak ditemukan" }, 404);
    if (userData.livesBalance < poll.livesPerVote) {
      return c.json({
        error: `Nyawa tidak cukup. Kamu punya ${userData.livesBalance}, butuh ${poll.livesPerVote}`,
      }, 400);
    }

    // Debit nyawa
    await adjustLives(
      Number(me.sub),
      -poll.livesPerVote,
      "vote_debit",
      pollId,
      "poll",
      `Vote poll #${pollId} — opsi: ${poll.options?.[optionIndex]}`,
    );

    // Simpan vote
    const [vote] = await db
      .insert(pollVotes)
      .values({
        pollId,
        userId: Number(me.sub),
        optionIndex,
        livesWagered: poll.livesPerVote,
      })
      .returning();

    // Update total votes counter
    await db
      .update(polls)
      .set({ totalVotes: sql`${polls.totalVotes} + 1`, updatedAt: new Date() })
      .where(eq(polls.id, pollId));

    return c.json({
      message: `Vote berhasil! Kamu memilih: ${poll.options?.[optionIndex]}`,
      data: vote,
    }, 201);
  },

  // PATCH /api/polls/:id/resolve — admin tentukan pemenang + distribusi payout
  async resolve(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { winnerOptionIndex } = body as { winnerOptionIndex?: number };
    if (winnerOptionIndex === undefined || winnerOptionIndex === null) {
      return c.json({ error: "Field 'winnerOptionIndex' wajib diisi" }, 422);
    }

    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    if (poll.status === "resolved") return c.json({ error: "Poll sudah resolved" }, 409);
    if (poll.status === "closed") return c.json({ error: "Poll sudah closed" }, 409);
    if (winnerOptionIndex < 0 || winnerOptionIndex >= (poll.options?.length ?? 0)) {
      return c.json({ error: `winnerOptionIndex tidak valid (0–${(poll.options?.length ?? 1) - 1})` }, 422);
    }

    // Ambil semua votes
    const allVotes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    if (allVotes.length === 0) {
      // Tidak ada voter — langsung tutup
      await db
        .update(polls)
        .set({ status: "resolved", winnerOptionIndex, resolvedAt: new Date(), resolvedBy: Number(me.sub), updatedAt: new Date() })
        .where(eq(polls.id, pollId));
      return c.json({ message: "Poll resolved (tidak ada voter)" });
    }

    const winnerVotes = allVotes.filter((v) => v.optionIndex === winnerOptionIndex);
    const loserVotes = allVotes.filter((v) => v.optionIndex !== winnerOptionIndex);

    const totalLoserLives = loserVotes.reduce((s, v) => s + v.livesWagered, 0);
    const totalWinnerLives = winnerVotes.reduce((s, v) => s + v.livesWagered, 0);
    const feePercent = Number(poll.platformFeePercent ?? 30) / 100;
    const winnerPoolLives = totalLoserLives * (1 - feePercent); // 70% default

    // ─── Payout per winning life ──────────────────────────────────
    // Formula: extra_lives = (loser_lives × (1 - fee%)) / total_winner_lives
    // Setiap winner dapat kembali: lives_wagered + (lives_wagered × extra_per_life)
    const extraPerWinnerLife = totalWinnerLives > 0 ? winnerPoolLives / totalWinnerLives : 0;

    // Kembalikan nyawa ke winner
    for (const vote of winnerVotes) {
      const payout = vote.livesWagered + Math.floor(vote.livesWagered * extraPerWinnerLife);
      const payoutDecimal = vote.livesWagered + vote.livesWagered * extraPerWinnerLife;

      await adjustLives(
        vote.userId,
        payout,
        "vote_payout",
        pollId,
        "poll",
        `Menang poll #${pollId} — ${payout} nyawa (${payoutDecimal.toFixed(2)} raw)`,
      );

      await db
        .update(pollVotes)
        .set({ payoutLives: String(payoutDecimal.toFixed(4)) })
        .where(eq(pollVotes.id, vote.id));
    }

    // Loser tidak dapat pengembalian (nyawa sudah didebit saat vote)
    for (const vote of loserVotes) {
      await db
        .update(pollVotes)
        .set({ payoutLives: "0" })
        .where(eq(pollVotes.id, vote.id));
    }

    // Mark poll resolved
    await db
      .update(polls)
      .set({
        status: "resolved",
        winnerOptionIndex,
        resolvedAt: new Date(),
        resolvedBy: Number(me.sub),
        updatedAt: new Date(),
      })
      .where(eq(polls.id, pollId));

    const winnerLabel = poll.options?.[winnerOptionIndex] ?? winnerOptionIndex;
    const platformLives = Math.floor(totalLoserLives * feePercent);

    // Broadcast ke semua koneksi WS — channel "polls"
    broadcastEvent("poll:resolved", {
      pollId,
      winnerOption: winnerLabel,
      winnerOptionIndex,
      totalVoters: allVotes.length,
      winners: winnerVotes.length,
      losers: loserVotes.length,
    }, "polls");

    // Broadcast personal notif ke setiap winner
    for (const vote of winnerVotes) {
      broadcastEvent("poll:payout", {
        pollId,
        winnerOption: winnerLabel,
        livesWagered: vote.livesWagered,
      }, `user:${vote.userId}`);
    }

    return c.json({
      message: `Poll #${pollId} resolved! Pemenang: "${winnerLabel}"`,
      summary: {
        winnerOption: winnerLabel,
        totalVoters: allVotes.length,
        winners: winnerVotes.length,
        losers: loserVotes.length,
        totalLoserLives,
        winnerPoolLives: Math.floor(winnerPoolLives),
        platformLives,
        extraPerWinner: extraPerWinnerLife.toFixed(4),
      },
    });
  },

  // GET /api/polls/:id/my-vote — user lihat vote sendiri
  async myVote(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = Number(c.req.param("id"));

    const [vote] = await db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, Number(me.sub))));

    if (!vote) return c.json({ data: null, voted: false });
    return c.json({ data: vote, voted: true });
  },
};
