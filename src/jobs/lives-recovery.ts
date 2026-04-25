import { db } from "../db";
import { users, livesTransactions } from "../db/schema";
import { lte, sql, and, lt, inArray } from "drizzle-orm";

const RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000; // 6 jam
const RECOVERY_LIVES = 1;
const MAX_LIVES = 10; // Tidak recovery jika saldo sudah >= batas ini
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
    // Ambil batch user yang perlu recovery: waktu sudah tiba DAN saldo < MAX_LIVES
    const batch = await db
      .select({ id: users.id, livesBalance: users.livesBalance })
      .from(users)
      .where(and(lte(users.livesRecoveryAt, now), lt(users.livesBalance, MAX_LIVES.toString())))
      .limit(BATCH_SIZE)
      .offset(offset);

    if (batch.length === 0) break;

    const nextRecoveryAt = new Date(now.getTime() + RECOVERY_INTERVAL_MS);
    const batchIds = batch.map((u) => u.id);

    // Update batch menggunakan inArray — aman dari SQL injection
    await db.update(users)
      .set({
        livesBalance: sql`lives_balance + ${RECOVERY_LIVES}`,
        livesRecoveryAt: nextRecoveryAt,
      })
      .where(inArray(users.id, batchIds));

    // Catat transaksi recovery untuk setiap user
    const txRows = batch.map((u) => ({
      userId: u.id,
      amount: RECOVERY_LIVES.toString(),
      type: "recovery" as const,
      refId: null,
      refType: "auto_recovery",
      note: `Auto-recovery +${RECOVERY_LIVES} nyawa`,
      balanceAfter: (Number(u.livesBalance) + RECOVERY_LIVES).toString(),
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
