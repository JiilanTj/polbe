import type { Context } from "hono";
import { db } from "../../db";
import { orders, trades, positions, polls, users, priceSnapshots } from "../../db/schema";
import { eq, and, desc, asc, or, sql, ne, isNull } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { parseBody, safeInt } from "../../lib/validate";
import { orderPlaceSchema } from "../../lib/schemas";
import { matchOrder, lockSharesForSell, restoreSharesForCancel } from "../../lib/clob";

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

    if (side === "buy") {
      // BUY: hitung biaya & potong dari lives balance
      const cost = Math.ceil(size * price);
      const [user] = await db.select({ livesBalance: users.livesBalance }).from(users).where(eq(users.id, userId));
      if (!user) return c.json({ error: "User tidak ditemukan" }, 404);
      if (user.livesBalance < cost) {
        return c.json({ error: `Lives tidak cukup. Punya ${user.livesBalance}, butuh ${cost}` }, 400);
      }

      // Potong lives, masukkan ke prize pool
      await db.update(users).set({ livesBalance: sql`lives_balance - ${cost}` }).where(eq(users.id, userId));
      await db.update(polls).set({ prizePool: sql`prize_pool + ${cost}` }).where(eq(polls.id, pollId));

      // Insert order
      const inserted = await db.insert(orders).values({
        pollId, userId, optionIndex,
        side: "buy",
        price: price.toFixed(4),
        size,
        livesPaidIn: cost,
      }).returning();
      const order = inserted[0];
      if (!order) return c.json({ error: "Gagal membuat order" }, 500);

      // Jalankan matching engine
      const result = await matchOrder(order.id);

      return c.json({
        message: `Order BUY ditempatkan${result.filledShares > 0 ? ` — ${result.filledShares}/${size} shares terisi` : " — menunggu counterpart"}`,
        data: { order, matched: result },
      }, 201);
    } else {
      // SELL: kunci shares dari positions
      const lockResult = await lockSharesForSell(userId, pollId, optionIndex, size);
      if (!lockResult.ok) return c.json({ error: lockResult.error }, 400);

      // Insert order
      const insertedSell = await db.insert(orders).values({
        pollId, userId, optionIndex,
        side: "sell",
        price: price.toFixed(4),
        size,
        livesPaidIn: 0,
      }).returning();
      const order = insertedSell[0];
      if (!order) return c.json({ error: "Gagal membuat order" }, 500);

      // Jalankan matching engine
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

    const rows = await db
      .select({ price: priceSnapshots.price, snapshotAt: priceSnapshots.snapshotAt })
      .from(priceSnapshots)
      .where(and(eq(priceSnapshots.pollId, pollId), eq(priceSnapshots.optionIndex, optIdx)))
      .orderBy(asc(priceSnapshots.snapshotAt))
      .limit(limit);

    return c.json({ data: rows });
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
