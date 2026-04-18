import { db } from "../db";
import { polls } from "../db/schema";
import { and, eq, lte, isNotNull } from "drizzle-orm";
import { broadcastEvent } from "../ws/handler";

/**
 * Tutup semua poll aktif yang sudah melewati endAt.
 * Dipanggil oleh scheduler setiap menit.
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

  if (expired.length > 0) {
    console.log(`[PollExpiry] Closed ${expired.length} expired poll(s): ${expired.map((p) => `#${p.id}`).join(", ")}`);

    for (const poll of expired) {
      broadcastEvent("poll:closed", { pollId: poll.id, title: poll.title }, "polls");
    }
  }
}
