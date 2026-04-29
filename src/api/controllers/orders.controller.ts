import type { Context } from "hono";
import { db } from "../../db";
import { orders, trades, positions, polls, users, priceSnapshots } from "../../db/schema";
import { eq, and, desc, asc, or, sql, gte } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { parseBody, safeInt } from "../../lib/validate";
import { orderPlaceSchema } from "../../lib/schemas";
import { matchOrder, restoreSharesForCancel } from "../../lib/clob";

export const ordersController = {
  // POST /api/polls/:id/orders — tempatkan limit order BUY atau SELL
  async placeOrder(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, orderPlaceSchema);
    if (body instanceof Response) return body;

    const { side, optionIndex, price, size } = body;

    // Validasi poll
    const [poll] = await db.select().from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);
    if (poll.status !== "active") return c.json({ error: "Poll belum aktif atau sudah selesai" }, 400);
    if (optionIndex < 0 || optionIndex >= (poll.options?.length ?? 0)) {
      return c.json({ error: `optionIndex tidak valid (0–${(poll.options?.length ?? 1) - 1})` }, 422);
    }
    if (price <= 0 || price >= 1) return c.json({ error: "Price harus antara 0 dan 1 (eksklusif)" }, 422);

    const userId = Number(me.sub);
    const [actor] = await db
      .select({ isMaster: users.isMaster })
      .from(users)
      .where(eq(users.id, userId));
    if (!actor) return c.json({ error: "User tidak ditemukan" }, 404);
    if (actor.isMaster) {
      return c.json({
        error: "User master tidak boleh melakukan bet di poll.",
        code: "MASTER_BET_BLOCKED",
      }, 403);
    }

    if (side === "buy") {
      // ── BUY: atomic — cek saldo, potong lives, insert order ──────────────
      const cost = Math.ceil(size * price);

      const order = await db.transaction(async (tx) => {
        const [user] = await tx
          .select({ livesBalance: users.livesBalance })
          .from(users)
          .where(eq(users.id, userId))
          .for("update"); // row-level lock

        if (!user) throw new Error("USER_NOT_FOUND");
        const livesBalance = Number(user.livesBalance);
        if (livesBalance < cost) throw new Error(`INSUFFICIENT:${livesBalance}:${cost}`);

        await tx.update(users)
          .set({ livesBalance: sql`lives_balance - ${cost}` })
          .where(eq(users.id, userId));
        await tx.update(polls)
          .set({ prizePool: sql`prize_pool + ${cost}` })
          .where(eq(polls.id, pollId));

        const [newOrder] = await tx.insert(orders).values({
          pollId, userId, optionIndex, side: "buy",
          price: price.toFixed(4), size, livesPaidIn: cost,
          ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
        }).returning();

        return newOrder;
      }).catch((err: Error) => {
        if (err.message === "USER_NOT_FOUND") return c.json({ error: "User tidak ditemukan" }, 404);
        if (err.message.startsWith("INSUFFICIENT")) {
          const [, have, need] = err.message.split(":");
          return c.json({ error: `Lives tidak cukup. Punya ${have}, butuh ${need}` }, 400);
        }
        throw err;
      });

      if (!order || order instanceof Response) return order as Response;

      const result = await matchOrder(order.id);
      return c.json({
        message: `Order BUY ditempatkan${result.filledShares > 0 ? ` — ${result.filledShares}/${size} shares terisi` : " — menunggu counterpart"}`,
        data: { order, matched: result },
      }, 201);

    } else {
      // ── SELL: atomic — cek + kunci shares, insert order ──────────────────
      const order = await db.transaction(async (tx) => {
        const [pos] = await tx
          .select()
          .from(positions)
          .where(and(
            eq(positions.userId, userId),
            eq(positions.pollId, pollId),
            eq(positions.optionIndex, optionIndex),
          ))
          .for("update"); // row-level lock mencegah race condition

        const available = pos?.shares ?? 0;
        if (available < size) {
          throw new Error(`INSUFFICIENT_SHARES:${available}:${size}`);
        }

        // Kunci shares langsung dalam tx yang sama
        await tx.update(positions)
          .set({ shares: pos!.shares - size, updatedAt: new Date() })
          .where(eq(positions.id, pos!.id));

        const [newOrder] = await tx.insert(orders).values({
          pollId, userId, optionIndex, side: "sell",
          price: price.toFixed(4), size, livesPaidIn: 0,
          ...(body.expiresAt ? { expiresAt: new Date(body.expiresAt) } : {}),
        }).returning();

        return newOrder;
      }).catch((err: Error) => {
        if (err.message.startsWith("INSUFFICIENT_SHARES")) {
          const [, have, need] = err.message.split(":");
          return c.json({ error: `Shares tidak cukup. Punya ${have} shares, butuh ${need}` }, 400);
        }
        throw err;
      });

      if (!order || order instanceof Response) return order as Response;

      const result = await matchOrder(order.id);
      return c.json({
        message: `Order SELL ditempatkan${result.filledShares > 0 ? ` — ${result.filledShares}/${size} shares terjual` : " — menunggu buyer"}`,
        data: { order, matched: result },
      }, 201);
    }
  },

  // GET /api/polls/:id/orderbook — order book (BUY bids + SELL asks) per optionIndex
  async getOrderBook(c: Context) {
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const optIdx = safeInt(c.req.query("optionIndex") ?? "0") ?? 0;
    const depth = Math.min(safeInt(c.req.query("depth") ?? "10") ?? 10, 50);

    // Bids (BUY orders) — harga tertinggi dulu
    const bids = await db
      .select({
        price: orders.price,
        size: sql<number>`SUM(${orders.size} - ${orders.filledSize})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(and(
        eq(orders.pollId, pollId),
        eq(orders.optionIndex, optIdx),
        eq(orders.side, "buy"),
        or(eq(orders.status, "open"), eq(orders.status, "partial")),
      ))
      .groupBy(orders.price)
      .orderBy(desc(orders.price))
      .limit(depth);

    // Asks (SELL orders) — harga terendah dulu
    const asks = await db
      .select({
        price: orders.price,
        size: sql<number>`SUM(${orders.size} - ${orders.filledSize})`,
        count: sql<number>`COUNT(*)`,
      })
      .from(orders)
      .where(and(
        eq(orders.pollId, pollId),
        eq(orders.optionIndex, optIdx),
        eq(orders.side, "sell"),
        or(eq(orders.status, "open"), eq(orders.status, "partial")),
      ))
      .groupBy(orders.price)
      .orderBy(asc(orders.price))
      .limit(depth);

    // Spread & mid price
    const bestBid = bids[0] ? Number(bids[0].price) : null;
    const bestAsk = asks[0] ? Number(asks[0].price) : null;
    const midPrice = bestBid && bestAsk ? ((bestBid + bestAsk) / 2).toFixed(4) : null;
    const spread = bestBid && bestAsk ? (bestAsk - bestBid).toFixed(4) : null;

    return c.json({
      data: {
        optionIndex: optIdx,
        bids: bids.map(b => ({ price: b.price, size: Number(b.size), orders: Number(b.count) })),
        asks: asks.map(a => ({ price: a.price, size: Number(a.size), orders: Number(a.count) })),
        bestBid,
        bestAsk,
        midPrice,
        spread,
      },
    });
  },

  // GET /api/polls/:id/activity — recent trades (activity feed)
  async getActivity(c: Context) {
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const limit = Math.min(safeInt(c.req.query("limit") ?? "50") ?? 50, 200);
    const optIdx = c.req.query("optionIndex");

    const rows = await db
      .select({
        id: trades.id,
        optionIndex: trades.optionIndex,
        side: trades.side,
        price: trades.price,
        size: trades.size,
        livesTransferred: trades.livesTransferred,
        createdAt: trades.createdAt,
        buyerUsername: sql<string>`(SELECT username FROM users WHERE id = CASE WHEN ${trades.side} = 'buy' THEN ${trades.takerUserId} ELSE ${trades.makerUserId} END)`,
        sellerUsername: sql<string>`(SELECT username FROM users WHERE id = CASE WHEN ${trades.side} = 'sell' THEN ${trades.takerUserId} ELSE ${trades.makerUserId} END)`,
      })
      .from(trades)
      .where(and(
        eq(trades.pollId, pollId),
        ...(optIdx !== undefined ? [eq(trades.optionIndex, Number(optIdx))] : []),
      ))
      .orderBy(desc(trades.createdAt))
      .limit(limit);
    return c.json({ data: rows });
  },

  // GET /api/polls/:id/price-history — historis harga untuk chart
  async getPriceHistory(c: Context) {
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const optIdx = safeInt(c.req.query("optionIndex") ?? "0") ?? 0;
    const limit = Math.min(safeInt(c.req.query("limit") ?? "200") ?? 200, 1000);
    const timeframe = (c.req.query("timeframe") ?? "ALL").toUpperCase();

    const timeframeMs: Record<string, number | null> = {
      "1H": 60 * 60 * 1000,
      "6H": 6 * 60 * 60 * 1000,
      "24H": 24 * 60 * 60 * 1000,
      "7D": 7 * 24 * 60 * 60 * 1000,
      "30D": 30 * 24 * 60 * 60 * 1000,
      "ALL": null,
    };
    const selectedWindow = timeframeMs[timeframe] ?? null;
    const since = selectedWindow ? new Date(Date.now() - selectedWindow) : null;

    const rows = await db
      .select({ price: priceSnapshots.price, snapshotAt: priceSnapshots.snapshotAt })
      .from(priceSnapshots)
      .where(and(
        eq(priceSnapshots.pollId, pollId),
        eq(priceSnapshots.optionIndex, optIdx),
        ...(since ? [gte(priceSnapshots.snapshotAt, since)] : []),
      ))
      .orderBy(asc(priceSnapshots.snapshotAt))
      .limit(limit);

    return c.json({
      data: rows,
      meta: {
        pollId,
        optionIndex: optIdx,
        timeframe,
        limit,
        points: rows.length,
      },
    });
  },

  // DELETE /api/polls/:id/orders/:orderId — batalkan order sendiri
  async cancelOrder(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    const orderId = safeInt(c.req.param("orderId"));
    if (!pollId || !orderId) return c.json({ error: "ID tidak valid" }, 400);

    const [order] = await db.select().from(orders).where(
      and(eq(orders.id, orderId), eq(orders.pollId, pollId)),
    );

    if (!order) return c.json({ error: "Order tidak ditemukan" }, 404);
    if (order.userId !== Number(me.sub) && me.role !== "admin") {
      return c.json({ error: "Bukan order kamu" }, 403);
    }
    if (order.status === "cancelled") return c.json({ error: "Order sudah dibatalkan" }, 409);
    if (order.status === "filled") return c.json({ error: "Order sudah terisi penuh, tidak bisa dibatalkan" }, 409);

    const remainingSize = order.size - order.filledSize;

    // Refund untuk BUY order: kembalikan sisa lives dari pool
    if (order.side === "buy" && remainingSize > 0) {
      const refundLives = Math.ceil(remainingSize * Number(order.price));
      await db.update(users)
        .set({ livesBalance: sql`lives_balance + ${refundLives}` })
        .where(eq(users.id, order.userId));
      await db.update(polls)
        .set({ prizePool: sql`prize_pool - ${refundLives}` })
        .where(eq(polls.id, pollId));
    }

    // Kembalikan shares untuk SELL order yang belum terisi
    if (order.side === "sell" && remainingSize > 0) {
      await restoreSharesForCancel(order.userId, pollId, order.optionIndex, remainingSize);
    }

    await db.update(orders)
      .set({ status: "cancelled", updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    return c.json({ message: `Order #${orderId} berhasil dibatalkan` });
  },
};
