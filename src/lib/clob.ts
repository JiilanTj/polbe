/**
 * CLOB Matching Engine — Polymarket-style Central Limit Order Book
 *
 * Mekanisme (pool model):
 * - BUY order ditempatkan: lives dibayar ke poll.prizePool, order masuk buku
 * - SELL order ditempatkan: shares dikunci (dikurangi dari positions), order masuk buku
 * - Saat match: pool → seller (langsung), buyer dapat shares
 * - Saat resolve: pool → winners (1 life per share, atau proporsional jika kurang)
 * - Saat cancel BUY: pool → refund ke user
 * - Saat cancel SELL: shares dikembalikan ke positions
 */

import { db } from "../db";
import { orders, trades, positions, polls, users, priceSnapshots, notifications } from "../db/schema";
import { eq, and, lte, gte, asc, desc, or, sql, isNull } from "drizzle-orm";
import { broadcastEvent } from "../ws/handler";

// Creator fee: 1.5% dari setiap trade, dikreditkan ke kreator poll
const CREATOR_FEE_PERCENT = 0.015;

export interface MatchResult {
  filledShares: number;
  avgFillPrice: number;
  tradeCount: number;
}

/**
 * Jalankan matching untuk sebuah order baru.
 * Semua operasi DB dijalankan dalam satu transaction.
 */
export async function matchOrder(orderId: number): Promise<MatchResult> {
  return db.transaction(async (tx) => {
    const [order] = await tx.select().from(orders).where(eq(orders.id, orderId));
    if (!order || order.status === "cancelled" || order.status === "filled") {
      return { filledShares: 0, avgFillPrice: 0, tradeCount: 0 };
    }

    // Ambil creatorId poll untuk fee
    const [poll] = await tx
      .select({ creatorId: polls.creatorId, lastPrices: polls.lastPrices })
      .from(polls)
      .where(eq(polls.id, order.pollId));

    const isBuy = order.side === "buy";
    let remaining = order.size - order.filledSize;
    let totalFilled = 0;
    let totalLives = 0;
    let tradeCount = 0;
    let lastPrice = 0;

    // Cari order lawan yang bisa dicocokkan
    // BUY: cari SELL dengan harga ≤ bid (ascending price = ambil ask paling murah dulu)
    // SELL: cari BUY dengan harga ≥ ask (descending price = ambil bid paling mahal dulu)
    const counterOrders = await tx
      .select()
      .from(orders)
      .where(and(
        eq(orders.pollId, order.pollId),
        eq(orders.optionIndex, order.optionIndex),
        eq(orders.side, isBuy ? "sell" : "buy"),
        or(eq(orders.status, "open"), eq(orders.status, "partial")),
        or(isNull(orders.expiresAt), sql`${orders.expiresAt} > NOW()`),
        isBuy
          ? lte(orders.price, order.price)    // SELL price ≤ BUY bid
          : gte(orders.price, order.price),   // BUY price ≥ SELL ask
      ))
      .orderBy(
        isBuy ? asc(orders.price) : desc(orders.price),  // best price first
        asc(orders.createdAt),                            // earliest order first (FIFO)
      );

    for (const maker of counterOrders) {
      if (remaining <= 0) break;

      const makerAvail = maker.size - maker.filledSize;
      const tradeSize = Math.min(remaining, makerAvail);
      const tradePrice = Number(maker.price);
      const tradeLives = Math.round(tradeSize * tradePrice); // integer lives

      const buyerId = isBuy ? order.userId : maker.userId;
      const sellerId = isBuy ? maker.userId : order.userId;

      // Creator fee (1.5% dari lives yang ditransfer, dibayar dari pool)
      const creatorFee = poll?.creatorId ? Math.floor(tradeLives * CREATOR_FEE_PERCENT) : 0;
      const sellerReceives = tradeLives - creatorFee;

      // ── Update maker order ──────────────────────────────────
      const makerNewFilled = maker.filledSize + tradeSize;
      await tx.update(orders)
        .set({
          filledSize: makerNewFilled,
          status: makerNewFilled >= maker.size ? "filled" : "partial",
          updatedAt: new Date(),
        })
        .where(eq(orders.id, maker.id));

      // ── Catat trade ────────────────────────────────────────
      await tx.insert(trades).values({
        pollId: order.pollId,
        optionIndex: order.optionIndex,
        makerOrderId: maker.id,
        takerOrderId: order.id,
        makerUserId: maker.userId,
        takerUserId: order.userId,
        side: order.side,
        price: String(tradePrice),
        size: tradeSize,
        livesTransferred: tradeLives,
      });

      // ── Bayar seller dari prize pool ───────────────────────
      // Pool sudah terisi dari BUY order placement
      await tx.update(users)
        .set({ livesBalance: sql`lives_balance + ${sellerReceives}` })
        .where(eq(users.id, sellerId));

      // Bayar creator fee jika ada creatorId
      if (creatorFee > 0 && poll?.creatorId) {
        await tx.update(users)
          .set({ livesBalance: sql`lives_balance + ${creatorFee}` })
          .where(eq(users.id, poll.creatorId));
        // Notifikasi untuk kreator
        await tx.insert(notifications).values({
          userId: poll.creatorId,
          type: "trade_executed",
          title: "Fee kreator diterima",
          body: `Kamu menerima ${creatorFee} lives sebagai fee kreator dari trade di market ini.`,
          refId: order.pollId,
          refType: "poll",
        });
      }

      await tx.update(polls)
        .set({ prizePool: sql`prize_pool - ${tradeLives}` })
        .where(eq(polls.id, order.pollId));

      // ── Update posisi buyer (tambah shares) ───────────────
      await upsertBuyerPosition(tx, buyerId, order.pollId, order.optionIndex, tradeSize, tradePrice, tradeLives);

      // ── Update posisi seller (catat realized P&L) ─────────
      // Shares sudah dikurangi di order placement, hanya update P&L
      await updateSellerPnl(tx, sellerId, order.pollId, order.optionIndex, tradeSize, tradeLives);

      // ── Snapshot harga ─────────────────────────────────────
      await tx.insert(priceSnapshots).values({
        pollId: order.pollId,
        optionIndex: order.optionIndex,
        price: String(tradePrice),
      });

      lastPrice = tradePrice;
      remaining -= tradeSize;
      totalFilled += tradeSize;
      totalLives += tradeLives;
      tradeCount++;
    }

    // Update taker order status
    const takerNewFilled = order.filledSize + totalFilled;
    let takerStatus: "open" | "partial" | "filled" | "cancelled" = "open";
    if (takerNewFilled >= order.size) takerStatus = "filled";
    else if (takerNewFilled > 0) takerStatus = "partial";

    await tx.update(orders)
      .set({ filledSize: takerNewFilled, status: takerStatus, updatedAt: new Date() })
      .where(eq(orders.id, orderId));

    // ── Notifikasi untuk taker ───────────────────────────────
    if (tradeCount > 0 && takerStatus !== "open") {
      const filled = takerStatus === "filled" ? "penuh" : "sebagian";
      await tx.insert(notifications).values({
        userId: order.userId,
        type: "order_filled",
        title: `Order ${order.side.toUpperCase()} terisi ${filled}`,
        body: `${takerNewFilled}/${order.size} shares @${Number(order.price).toFixed(2)} telah terisi.`,
        refId: order.id,
        refType: "order",
      });
    }

    // Update lastPrices di poll jika ada trade
    if (tradeCount > 0) {
      const newLastPrices: Record<string, string> = (poll?.lastPrices as Record<string, string>) || {};
      newLastPrices[String(order.optionIndex)] = lastPrice.toFixed(4);
      await tx.update(polls)
        .set({ lastPrices: newLastPrices, totalVolume: sql`total_volume + ${totalLives}`, updatedAt: new Date() })
        .where(eq(polls.id, order.pollId));

      // Broadcast ke subscribers
      broadcastEvent("poll:trade", {
        pollId: order.pollId,
        optionIndex: order.optionIndex,
        price: lastPrice,
        size: totalFilled,
        side: order.side,
      }, "polls");
    }

    return { filledShares: totalFilled, avgFillPrice: totalFilled > 0 ? totalLives / totalFilled : 0, tradeCount };
  });
}

/** Upsert posisi buyer: tambah shares, update avgEntryPrice & totalLivesIn */
async function upsertBuyerPosition(
  tx: any,
  userId: number,
  pollId: number,
  optionIndex: number,
  shares: number,
  price: number,
  livesCost: number,
) {
  const [pos] = await tx.select().from(positions).where(
    and(eq(positions.userId, userId), eq(positions.pollId, pollId), eq(positions.optionIndex, optionIndex)),
  );

  if (pos) {
    const newShares = pos.shares + shares;
    const newAvg = (Number(pos.avgEntryPrice) * pos.shares + price * shares) / newShares;
    await tx.update(positions)
      .set({
        shares: newShares,
        avgEntryPrice: newAvg.toFixed(4),
        totalLivesIn: pos.totalLivesIn + livesCost,
        updatedAt: new Date(),
      })
      .where(eq(positions.id, pos.id));
  } else {
    await tx.insert(positions).values({
      userId, pollId, optionIndex,
      shares,
      avgEntryPrice: price.toFixed(4),
      totalLivesIn: livesCost,
    });
  }
}

/** Update realized P&L seller (shares sudah dikurangi saat SELL order ditempatkan) */
async function updateSellerPnl(
  tx: any,
  userId: number,
  pollId: number,
  optionIndex: number,
  sharesSold: number,
  livesReceived: number,
) {
  const [pos] = await tx.select().from(positions).where(
    and(eq(positions.userId, userId), eq(positions.pollId, pollId), eq(positions.optionIndex, optionIndex)),
  );
  if (!pos) return;

  const costBasis = Math.round(sharesSold * Number(pos.avgEntryPrice));
  const pnl = livesReceived - costBasis;

  await tx.update(positions)
    .set({ realizedPnl: pos.realizedPnl + pnl, updatedAt: new Date() })
    .where(eq(positions.id, pos.id));
}

/**
 * Kunci shares untuk SELL order (dikurangi dari positions saat order ditempatkan).
 * Dipanggil dari orders.controller sebelum insert order.
 */
export async function lockSharesForSell(
  userId: number,
  pollId: number,
  optionIndex: number,
  size: number,
): Promise<{ ok: boolean; error?: string }> {
  const [pos] = await db.select().from(positions).where(
    and(eq(positions.userId, userId), eq(positions.pollId, pollId), eq(positions.optionIndex, optionIndex)),
  );

  if (!pos || pos.shares < size) {
    return { ok: false, error: `Shares tidak cukup. Kamu punya ${pos?.shares ?? 0} shares, butuh ${size}` };
  }

  await db.update(positions)
    .set({ shares: pos.shares - size, updatedAt: new Date() })
    .where(eq(positions.id, pos.id));

  return { ok: true };
}

/**
 * Kembalikan shares ke positions saat SELL order dibatalkan.
 */
export async function restoreSharesForCancel(
  userId: number,
  pollId: number,
  optionIndex: number,
  shares: number,
) {
  const [pos] = await db.select().from(positions).where(
    and(eq(positions.userId, userId), eq(positions.pollId, pollId), eq(positions.optionIndex, optionIndex)),
  );

  if (pos) {
    await db.update(positions)
      .set({ shares: pos.shares + shares, updatedAt: new Date() })
      .where(eq(positions.id, pos.id));
  } else {
    // Posisi tidak ada (sudah 0 di semua kolom) — recreate
    await db.insert(positions).values({
      userId, pollId, optionIndex, shares,
      avgEntryPrice: "0.5000", totalLivesIn: 0,
    });
  }
}
