import { db } from "../db";
import { users, livesTransactions } from "../db/schema";
import { lte, sql } from "drizzle-orm";

const RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 jam
const RECOVERY_LIVES = 1;
const BATCH_SIZE = 100;

/**
 * Proses auto-recovery nyawa:
 * - Ambil user yang livesRecoveryAt <= sekarang
 * - Tambah +1 nyawa, set livesRecoveryAt = sekarang + 6 jam
 * - Catat di livesTransactions
 */
export async function runLivesRecovery(): Promise<void> {
  const now = new Date();
  let offset = 0;
  let processedTotal = 0;

  console.log(`[LivesRecovery] Memulai recovery nyawa @ ${now.toISOString()}`);

  while (true) {
    // Ambil batch user yang perlu recovery
    const batch = await db
      .select({ id: users.id, livesBalance: users.livesBalance })
      .from(users)
      .where(lte(users.livesRecoveryAt, now))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) break;

    const nextRecoveryAt = new Date(now.getTime() + RECOVERY_INTERVAL_MS);

    // Update batch sekaligus via SQL
    await db.execute(
      sql`
        UPDATE users
        SET lives_balance = lives_balance + ${RECOVERY_LIVES},
            lives_recovery_at = ${nextRecoveryAt}
        WHERE id = ANY(${sql.raw(
          "ARRAY[" + batch.map((u) => u.id).join(",") + "]::integer[]",
        )})
      `,
    );

    // Catat transaksi recovery untuk setiap user
    const txRows = batch.map((u) => ({
      userId: u.id,
      amount: RECOVERY_LIVES,
      type: "recovery" as const,
      refId: null,
      refType: "auto_recovery",
      note: `Auto-recovery +${RECOVERY_LIVES} nyawa`,
      balanceAfter: u.livesBalance + RECOVERY_LIVES,
    }));

    if (txRows.length > 0) {
      await db.insert(livesTransactions).values(txRows);
    }

    processedTotal += batch.length;
    offset += BATCH_SIZE;
    console.log(`[LivesRecovery] Batch selesai: ${batch.length} user (total: ${processedTotal})`);
  }

  if (processedTotal === 0) {
    console.log("[LivesRecovery] Tidak ada user yang perlu recovery saat ini.");
  } else {
    console.log(`[LivesRecovery] Selesai. Total user diproses: ${processedTotal}`);
  }
}
