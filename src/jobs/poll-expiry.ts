import { db } from "../db";
import { polls, orders, users } from "../db/schema";
import { and, eq, lte, isNotNull, or, sql } from "drizzle-orm";
import { broadcastEvent } from "../ws/handler";
import { restoreSharesForCancel } from "../lib/clob";

/**
 * Tutup semua poll aktif yang sudah melewati endAt.
 * Saat poll ditutup, semua open/partial orders dibatalkan dan lives di-refund.
 */
export async function runPollExpiry() {
  const now = new Date();

  const expired = await db
    .update(polls)
    .set({ status: "closed", updatedAt: now })
    .where(
      and(
        eq(polls.status, "active"),
        isNotNull(polls.endAt),
        lte(polls.endAt, now),
      ),
    )
    .returning({ id: polls.id, title: polls.title });

  if (expired.length === 0) return;

  console.log(`[PollExpiry] Closed ${expired.length} expired poll(s): ${expired.map((p) => `#${p.id}`).join(", ")}`);

  for (const poll of expired) {
    // Batalkan & refund semua open/partial orders
    const openOrders = await db
      .select()
      .from(orders)
      .where(and(
        eq(orders.pollId, poll.id),
        or(eq(orders.status, "open"), eq(orders.status, "partial")),
      ));

    for (const order of openOrders) {
      const remaining = order.size - order.filledSize;
      if (remaining <= 0) continue;

      if (order.side === "buy") {
        // Refund lives dari prizePool ke user
        const refund = Math.ceil(remaining * Number(order.price));
        await db.update(users)
          .set({ livesBalance: sql`lives_balance + ${refund}` })
          .where(eq(users.id, order.userId));
        await db.update(polls)
          .set({ prizePool: sql`prize_pool - ${refund}` })
          .where(eq(polls.id, poll.id));
      } else {
        // SELL: kembalikan shares yang terkunci
        await restoreSharesForCancel(order.userId, poll.id, order.optionIndex, remaining);
      }

      await db.update(orders)
        .set({ status: "cancelled", updatedAt: now })
        .where(eq(orders.id, order.id));
    }

    if (openOrders.length > 0) {
      console.log(`[PollExpiry] Cancelled ${openOrders.length} open orders for poll #${poll.id}`);
    }

    broadcastEvent("poll:closed", { pollId: poll.id, title: poll.title }, "polls");
  }
}

