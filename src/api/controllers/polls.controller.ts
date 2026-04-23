import type { Context } from "hono";
import { db } from "../../db";
import { polls, pollVotes, users, livesTransactions, positions, orders, trades, notifications } from "../../db/schema";
import { eq, desc, sql, and, ilike, gt, or } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { verifyAccessToken } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";
import { parseBody, safeInt, escapeHtml } from "../../lib/validate";
import { pollCreateSchema, pollVoteSchema, pollResolveSchema, pollStatusSchema } from "../../lib/schemas";

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
    const q = c.req.query("q")?.trim();
    const offset = (page - 1) * limit;

    let query = db
      .select()
      .from(polls)
      .orderBy(desc(polls.createdAt))
      .limit(limit)
      .offset(offset);

    if (status) query = query.where(eq(polls.status, status as any)) as typeof query;
    if (category) query = query.where(eq(polls.category, category)) as typeof query;
    if (q) query = query.where(ilike(polls.title, `%${q}%`)) as typeof query;

    // Count query menggunakan filter yang sama
    let countQuery = db.select({ count: sql<number>`count(*)` }).from(polls);
    if (status) countQuery = countQuery.where(eq(polls.status, status as any)) as typeof countQuery;
    if (category) countQuery = countQuery.where(eq(polls.category, category)) as typeof countQuery;
    if (q) countQuery = countQuery.where(ilike(polls.title, `%${q}%`)) as typeof countQuery;

    const rows = await query;
    const countResult = await countQuery;
    const count = countResult[0]?.count ?? 0;

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(count), totalPages: Math.ceil(Number(count) / limit) },
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

    return c.json({ data: rows });
  },

  // GET /api/polls/:id — detail poll + distribusi positions + orderbook + last prices (optional auth)
  async getById(c: Context) {
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID poll tidak valid" }, 400);

    const [poll] = await db.select().from(polls).where(eq(polls.id, id));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    // Distribusi posisi per opsi (CLOB-based — siapa pegang berapa shares)
    const positionStats = await db
      .select({
        optionIndex: positions.optionIndex,
        holders: sql<number>`count(*)`,
        totalShares: sql<number>`sum(${positions.shares})`,
      })
      .from(positions)
      .where(and(eq(positions.pollId, id), gt(positions.shares, 0)))
      .groupBy(positions.optionIndex);

    // Best bid/ask per option dari order book
    const bids = await db
      .select({
        optionIndex: orders.optionIndex,
        bestBid: sql<string>`max(${orders.price})`,
      })
      .from(orders)
      .where(and(
        eq(orders.pollId, id),
        eq(orders.side, "buy"),
        sql`${orders.status} IN ('open','partial')`,
      ))
      .groupBy(orders.optionIndex);

    const asks = await db
      .select({
        optionIndex: orders.optionIndex,
        bestAsk: sql<string>`min(${orders.price})`,
      })
      .from(orders)
      .where(and(
        eq(orders.pollId, id),
        eq(orders.side, "sell"),
        sql`${orders.status} IN ('open','partial')`,
      ))
      .groupBy(orders.optionIndex);

    const lastPrices = (poll.lastPrices as Record<string, string>) || {};

    const distribution = (poll.options ?? []).map((opt: string, idx: number) => {
      const posStats = positionStats.find((p) => p.optionIndex === idx);
      const bid = bids.find((b) => b.optionIndex === idx);
      const ask = asks.find((a) => a.optionIndex === idx);
      const lastPrice = lastPrices[String(idx)] ?? null;
      const midPrice = bid?.bestBid && ask?.bestAsk
        ? ((Number(bid.bestBid) + Number(ask.bestAsk)) / 2).toFixed(4) : null;
      return {
        index: idx,
        label: opt,
        totalShares: Number(posStats?.totalShares ?? 0),
        holders: Number(posStats?.holders ?? 0),
        bestBid: bid?.bestBid ?? null,
        bestAsk: ask?.bestAsk ?? null,
        midPrice,
        lastPrice,
      };
    });

    // userVote/userPosition jika ada header auth (optional)
    let userPosition = null;
    const authHeader = c.req.header("Authorization");
    if (authHeader?.startsWith("Bearer ")) {
      try {
        const payload = await verifyAccessToken(authHeader.slice(7));
        const viewerId = Number(payload.sub);
        userPosition = await db
          .select()
          .from(positions)
          .where(and(eq(positions.pollId, id), eq(positions.userId, viewerId)));
      } catch {
        // Token tidak valid — abaikan
      }
    }

    // ── Market Stats (Polymarket-style) ────────────────────────────────────
    const oneDayAgo = new Date(Date.now() - 24 * 60 * 60 * 1000);

    const [volume24hRow] = await db
      .select({ vol: sql<number>`COALESCE(SUM(${trades.livesTransferred}), 0)` })
      .from(trades)
      .where(and(eq(trades.pollId, id), gt(trades.createdAt, oneDayAgo)));

    const [openInterestRow] = await db
      .select({ oi: sql<number>`COALESCE(SUM((${orders.size} - ${orders.filledSize}) * ${orders.price}::numeric), 0)` })
      .from(orders)
      .where(and(
        eq(orders.pollId, id),
        or(eq(orders.status, "open"), eq(orders.status, "partial")),
      ));

    const [uniqueTradersRow] = await db
      .select({ count: sql<number>`COUNT(DISTINCT maker_user_id) + COUNT(DISTINCT taker_user_id)` })
      .from(trades)
      .where(eq(trades.pollId, id));

    const stats = {
      totalVolume: poll.totalVolume,
      volume24h: Number(volume24hRow?.vol ?? 0),
      openInterest: Math.round(Number(openInterestRow?.oi ?? 0)),
      uniqueTraders: Number(uniqueTradersRow?.count ?? 0),
      prizePool: poll.prizePool,
    };

    return c.json({ data: { ...poll, distribution, userPosition, stats } });
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

    if (startAt && endAt && new Date(startAt) >= new Date(endAt)) {
      return c.json({ error: "startAt harus sebelum endAt" }, 422);
    }

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
        livesPerVote,
        platformFeePercent: String(platformFeePercent),
      })
      .returning();

    return c.json({ data: poll }, 201);
  },

  // PATCH /api/polls/:id/status — admin ubah status (draft → active, dsb)
  async updateStatus(c: Context) {
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, pollStatusSchema);
    if (body instanceof Response) return body;

    const { status } = body;

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

    // Broadcast ke semua subscriber saat poll diaktifkan
    if (status === "active" && updated) {
      // Seed lastPrices ke 0.5000 untuk semua opsi jika belum ada harga
      if (!updated.lastPrices) {
        const options = (updated.options ?? []) as string[];
        const seedPrices: Record<string, string> = {};
        options.forEach((_: string, idx: number) => { seedPrices[String(idx)] = "0.5000"; });
        await db.update(polls)
          .set({ lastPrices: seedPrices })
          .where(eq(polls.id, id));
      }

      broadcastEvent("poll:activated", {
        pollId: id,
        title: updated.title,
        category: updated.category,
        options: updated.options,
        endAt: updated.endAt,
      }, "polls");
    }

    return c.json({ data: updated });
  },

  // POST /api/polls/:id/vote — user vote (costs livesPerVote nyawa)
  async vote(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, pollVoteSchema);
    if (body instanceof Response) return body;

    const { optionIndex } = body;

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

    // Broadcast update vote count ke semua subscriber channel "polls"
    const updatedCounts = await db
      .select({
        optionIndex: pollVotes.optionIndex,
        count: sql<number>`count(*)`,
        totalLives: sql<number>`sum(${pollVotes.livesWagered})`,
      })
      .from(pollVotes)
      .where(eq(pollVotes.pollId, pollId))
      .groupBy(pollVotes.optionIndex);

    broadcastEvent("poll:vote_cast", {
      pollId,
      totalVotes: (poll.totalVotes || 0) + 1,
      distribution: updatedCounts,
    }, "polls");

    return c.json({
      message: `Vote berhasil! Kamu memilih: ${poll.options?.[optionIndex]}`,
      data: vote,
    }, 201);
  },

  // PATCH /api/polls/:id/resolve — admin tentukan pemenang + distribusi payout (CLOB-based)
  async resolve(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, pollResolveSchema);
    if (body instanceof Response) return body;

    const { winnerOptionIndex } = body;

    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    if (poll.status === "resolved") return c.json({ error: "Poll sudah resolved" }, 409);
    if (poll.status === "closed") return c.json({ error: "Poll sudah closed" }, 409);
    if (winnerOptionIndex < 0 || winnerOptionIndex >= (poll.options?.length ?? 0)) {
      return c.json({ error: `winnerOptionIndex tidak valid (0–${(poll.options?.length ?? 1) - 1})` }, 422);
    }

    // Batalkan semua open/partial orders yang masih ada
    await db.update(orders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(and(eq(orders.pollId, pollId), sql`${orders.status} IN ('open','partial')`));

    // Ambil semua posisi winning option yang masih ada (shares > 0)
    const winnerPositions = await db
      .select()
      .from(positions)
      .where(and(
        eq(positions.pollId, pollId),
        eq(positions.optionIndex, winnerOptionIndex),
        gt(positions.shares, 0),
      ));

    // ─── 1. CLOB Payout Logic (Positions) ──────────────────────────────────
    const totalWinningShares = winnerPositions.reduce((s, p) => s + p.shares, 0);
    const prizePool = poll.prizePool;

    let totalClobPaid = 0;
    let clobPayoutPerShare = 0;

    if (totalWinningShares > 0) {
      clobPayoutPerShare = Math.min(1.0, prizePool / totalWinningShares);
      for (const pos of winnerPositions) {
        const payout = Math.floor(pos.shares * clobPayoutPerShare);
        if (payout <= 0) continue;

        await adjustLives(
          pos.userId, payout, "vote_payout", pollId, "poll",
          `Menang poll #${pollId} (CLOB) — ${pos.shares} shares × ${clobPayoutPerShare.toFixed(4)} = ${payout} nyawa`,
        );
        totalClobPaid += payout;
      }
    }

    // ─── 2. Parimutuel Payout Logic (Simple Votes) ──────────────────────────
    // Formula: 70% dr yg kalah di bagi jumlah yg bener
    const allVotes = await db.select().from(pollVotes).where(eq(pollVotes.pollId, pollId));
    
    const winnersVotes = allVotes.filter(v => v.optionIndex === winnerOptionIndex);
    const losersVotes = allVotes.filter(v => v.optionIndex !== winnerOptionIndex);

    const totalWinnersWagered = winnersVotes.reduce((sum, v) => sum + v.livesWagered, 0);
    const totalLosersWagered = losersVotes.reduce((sum, v) => sum + v.livesWagered, 0);
    
    let totalVotePaid = 0;
    let voteBonusPerLife = 0;

    if (totalWinnersWagered > 0 && totalLosersWagered > 0) {
      const prizeToDistribute = totalLosersWagered * 0.7; // 70% dr yg kalah
      voteBonusPerLife = prizeToDistribute / totalWinnersWagered;

      for (const vote of winnersVotes) {
        const bonus = Math.floor(vote.livesWagered * voteBonusPerLife);
        const totalPayout = vote.livesWagered + bonus;
        
        if (totalPayout <= 0) continue;

        // Update vote record with payout info
        await db.update(pollVotes)
          .set({ payoutLives: String(totalPayout.toFixed(2)) })
          .where(eq(pollVotes.id, vote.id));

        await adjustLives(
          vote.userId, totalPayout, "vote_payout", pollId, "poll",
          `Menang poll #${pollId} (Vote) — Bet ${vote.livesWagered} + Bonus ${bonus} = ${totalPayout} nyawa`,
        );
        totalVotePaid += totalPayout;
      }
    } else if (totalWinnersWagered > 0 && totalLosersWagered === 0) {
      // Semua menang — refund saja (atau profit 0)
      for (const vote of winnersVotes) {
        await adjustLives(
          vote.userId, vote.livesWagered, "vote_payout", pollId, "poll",
          `Refund poll #${pollId} — Semua user memilih opsi yang benar`,
        );
        totalVotePaid += vote.livesWagered;
      }
    }

    // Sisa pool setelah payout = platform revenue
    // CLOB revenue: prizePool - totalClobPaid
    // Vote revenue: totalLosersWagered - totalVotePaid + totalWinnersWagered (sisa 30%)
    const platformRevenue = (prizePool - totalClobPaid) + (totalLosersWagered + totalWinnersWagered - totalVotePaid);

    // Mark poll resolved, reset prize pool
    await db.update(polls)
      .set({
        status: "resolved",
        winnerOptionIndex,
        resolvedAt: new Date(),
        resolvedBy: Number(me.sub),
        prizePool: 0,
        updatedAt: new Date(),
      })
      .where(eq(polls.id, pollId));

    const winnerLabel = poll.options?.[winnerOptionIndex] ?? winnerOptionIndex;

    broadcastEvent("poll:resolved", {
      pollId, winnerOption: winnerLabel, winnerOptionIndex,
      clobPayoutPerShare, totalClobPaid,
      voteBonusPerLife, totalVotePaid,
      platformRevenue,
    }, "polls");

    // Notif personal ke setiap winner (Position Holders)
    for (const pos of winnerPositions) {
      const payout = Math.floor(pos.shares * clobPayoutPerShare);
      if (payout > 0) {
        broadcastEvent("poll:payout", {
          pollId, winnerOption: winnerLabel, shares: pos.shares, payout, type: "clob",
        }, `user:${pos.userId}`);

        await db.insert(notifications).values({
          userId: pos.userId,
          type: "payout_credited",
          title: "Kamu menang (CLOB)! Payout dikreditkan",
          body: `${pos.shares} shares "${winnerLabel}" × ${clobPayoutPerShare.toFixed(4)} = ${payout} nyawa telah dikreditkan.`,
          refId: pollId,
          refType: "poll",
        });
      }
    }

    // Notif personal ke setiap winner (Voters)
    for (const vote of winnersVotes) {
      const bonus = Math.floor(vote.livesWagered * voteBonusPerLife);
      const totalPayout = vote.livesWagered + bonus;
      if (totalPayout > 0) {
        broadcastEvent("poll:payout", {
          pollId, winnerOption: winnerLabel, wagered: vote.livesWagered, payout: totalPayout, type: "vote",
        }, `user:${vote.userId}`);

        await db.insert(notifications).values({
          userId: vote.userId,
          type: "payout_credited",
          title: "Kamu menang (Vote)! Payout dikreditkan",
          body: `Kamu memilih "${winnerLabel}" dengan ${vote.livesWagered} nyawa. Payout: ${totalPayout} nyawa (Bonus: ${bonus}).`,
          refId: pollId,
          refType: "poll",
        });
      }
    }

    // Notifikasi ke yang kalah
    const losers = [...new Set([...losersVotes.map(v => v.userId)])];
    for (const userId of losers) {
      await db.insert(notifications).values({
        userId,
        type: "poll_resolved",
        title: "Market telah di-resolve",
        body: `Market #${pollId} telah selesai. Pemenang: "${winnerLabel}". Sayangnya kamu belum beruntung.`,
        refId: pollId,
        refType: "poll",
      });
    }

    return c.json({
      message: `Poll #${pollId} resolved! Pemenang: "${winnerLabel}"`,
      summary: {
        winnerOption: winnerLabel,
        prizePool,
        totalClobPaid,
        totalVotePaid,
        platformRevenue,
        winnersCount: winnerPositions.length + winnersVotes.length,
      },
    });
  },

  // GET /api/polls/:id/my-vote — user lihat vote sendiri
  async myVote(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const [vote] = await db
      .select()
      .from(pollVotes)
      .where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, Number(me.sub))));

    if (!vote) return c.json({ data: null, voted: false });
    return c.json({ data: vote, voted: true });
  },

  // DELETE /api/polls/:id — admin hapus poll (hanya status draft)
  async deletePoll(c: Context) {
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID poll tidak valid" }, 400);

    const [poll] = await db
      .select({ id: polls.id, status: polls.status })
      .from(polls)
      .where(eq(polls.id, id));

    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    if (poll.status !== "draft") {
      return c.json({ error: "Hanya poll berstatus 'draft' yang bisa dihapus" }, 409);
    }

    await db.delete(pollVotes).where(eq(pollVotes.pollId, id));
    await db.delete(polls).where(eq(polls.id, id));

    return c.json({ message: `Poll #${id} berhasil dihapus` });
  },
};
