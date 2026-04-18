import { db } from "../db";
import { orders, users, polls } from "../db/schema";
import { and, eq, lt, or, isNotNull, sql } from "drizzle-orm";
import { restoreSharesForCancel } from "../lib/clob";

/**
 * Batalkan semua GTD (Good-Till-Date) orders yang sudah melewati expiresAt.
 * Refund lives untuk BUY orders, restore shares untuk SELL orders.
 * Dipanggil setiap menit oleh scheduler.
 */
export async function runOrderExpiry(): Promise<void> {
  const now = new Date();

  const expiredOrders = await db
    .select()
    .from(orders)
    .where(and(
      isNotNull(orders.expiresAt),
      lt(orders.expiresAt, now),
      or(eq(orders.status, "open"), eq(orders.status, "partial")),
    ));

  if (expiredOrders.length === 0) return;

  console.log(`[OrderExpiry] Cancelling ${expiredOrders.length} expired order(s)`);

  for (const order of expiredOrders) {
    const remaining = order.size - order.filledSize;
    if (remaining <= 0) continue;

    if (order.side === "buy") {
      const refund = Math.ceil(remaining * Number(order.price));
      await db.update(users)
        .set({ livesBalance: sql`lives_balance + ${refund}` })
        .where(eq(users.id, order.userId));
      await db.update(polls)
        .set({ prizePool: sql`prize_pool - ${refund}` })
        .where(eq(polls.id, order.pollId));
    } else {
      await restoreSharesForCancel(order.userId, order.pollId, order.optionIndex, remaining);
    }

    await db.update(orders)
      .set({ status: "cancelled", updatedAt: now })
      .where(eq(orders.id, order.id));
  }

  console.log(`[OrderExpiry] Done — ${expiredOrders.length} order(s) cancelled`);
}
