import type { Context } from "hono";
import { db } from "../../db";
import { topupRequests, lifePackages, users, livesTransactions, referralEarnings, notifications } from "../../db/schema";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";
import { parseBody, safeInt } from "../../lib/validate";
import { topupCreateSchema } from "../../lib/schemas";


// Referral fee rate: 0.05 USDT per 1 USDT topup downline
const REFERRAL_FEE_RATE = 0.05;
// 1 USDT = 1 live untuk konversi referral bonus
const USDT_TO_LIVES = 1;

/**
 * Kredit nyawa ke user dalam konteks tx (atau db langsung).
 * Menerima tx/db agar bisa dipakai di dalam transaction.
 */
async function creditLivesTx(
  tx: typeof db,
  userId: number,
  amount: number,
  type: "purchase" | "referral_bonus" | "admin_credit",
  refId: number | null,
  refType: string,
  note: string,
) {
  const [current] = await tx
    .select({ livesBalance: users.livesBalance })
    .from(users)
    .where(eq(users.id, userId));

  if (!current) throw new Error("User tidak ditemukan");

  const balanceAfter = Number(current.livesBalance) + amount;

  await tx.update(users).set({ livesBalance: balanceAfter.toString() }).where(eq(users.id, userId));

  await tx.insert(livesTransactions).values({
    userId, amount: amount.toString(), type, refId, refType, note, balanceAfter: balanceAfter.toString(),
  });

  return balanceAfter;
}

async function creditLives(
  userId: number,
  amount: number,
  type: "purchase" | "referral_bonus" | "admin_credit",
  refId: number | null,
  refType: string,
  note: string,
) {
  return creditLivesTx(db as any, userId, amount, type, refId, refType, note);
}

export const topupController = {
  // POST /api/topup — user buat request topup
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await parseBody(c, topupCreateSchema);
    if (body instanceof Response) return body;

    const { packageId, proofImageUrl, walletAddress } = body;

    // Ambil paket
    const [pkg] = await db
      .select()
      .from(lifePackages)
      .where(eq(lifePackages.id, packageId));

    if (!pkg) return c.json({ error: "Paket tidak ditemukan" }, 404);
    if (!pkg.isActive) return c.json({ error: "Paket sedang tidak aktif" }, 400);

    const [request] = await db
      .insert(topupRequests)
      .values({
        userId: Number(me.sub),
        packageId: pkg.id,
        usdtAmount: pkg.usdtPrice,
        livesAmount: pkg.livesAmount,
        proofImageUrl,
        walletAddress: walletAddress ?? null,
        status: "pending",
      })
      .returning();
    if (!request) return c.json({ error: "Gagal membuat request topup" }, 500);

    broadcastEvent("topup:created", {
      userId: request.userId,
      topupId: request.id,
      livesAmount: request.livesAmount,
      usdtAmount: request.usdtAmount,
    }, "admin");

    return c.json({
      message: "Request topup berhasil dikirim. Menunggu konfirmasi admin.",
      data: request,
    }, 201);
  },

  // GET /api/topup — user lihat history topup mereka; admin lihat semua
  async list(c: Context) {
    const me = c.get("user") as TokenPayload;
    const isAdmin = me.role === "admin";
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    let query = db
      .select()
      .from(topupRequests)
      .orderBy(desc(topupRequests.createdAt))
      .limit(limit)
      .offset(offset);

    // User biasa hanya lihat milik sendiri
    if (!isAdmin) {
      query = query.where(eq(topupRequests.userId, Number(me.sub))) as typeof query;
    }

    const rows = await query;
    return c.json({ data: rows });
  },

  // PATCH /api/topup/:id/approve — admin approve
  async approve(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID tidak valid" }, 400);
    const body = await c.req.json().catch(() => ({})) as { adminNote?: string };

    const [req] = await db.select().from(topupRequests).where(eq(topupRequests.id, id));
    if (!req) return c.json({ error: "Request tidak ditemukan" }, 404);
    if (req.status !== "pending") {
      return c.json({ error: `Request sudah ${req.status}, tidak bisa diubah` }, 409);
    }

    // ── Semua operasi dalam satu transaction (atomic) ──────────────────────
    const { newBalance, referrerId } = await db.transaction(async (tx) => {
      // 1. Update status topup
      await tx.update(topupRequests)
        .set({
          status: "approved",
          adminNote: body.adminNote ?? null,
          approvedBy: Number(me.sub),
          processedAt: new Date(),
        })
        .where(eq(topupRequests.id, id));

      // 2. Credit lives ke user
      const newBalance = await creditLivesTx(
        tx as any, req.userId, req.livesAmount, "purchase",
        req.id, "topup_request",
        `Topup ${req.livesAmount} nyawa (${req.usdtAmount} USDT) — approved`,
      );

      // 3. Notifikasi untuk buyer
      await tx.insert(notifications).values({
        userId: req.userId,
        type: "payout_credited",
        title: "Topup disetujui",
        body: `${req.livesAmount} nyawa berhasil ditambahkan ke akunmu. Saldo baru: ${newBalance}.`,
        refId: req.id,
        refType: "topup",
      });

      // 4. Referral: beri komisi ke referrer (dalam tx yang sama)
      const [buyer] = await tx
        .select({ referredBy: users.referredBy })
        .from(users)
        .where(eq(users.id, req.userId));

      let referrerId: number | null = null;
      if (buyer?.referredBy) {
        referrerId = buyer.referredBy;
        const usdtEarned = Number(req.usdtAmount) * REFERRAL_FEE_RATE;
        const livesEarned = Math.floor(usdtEarned * USDT_TO_LIVES);

        await tx.insert(referralEarnings).values({
          referrerId,
          refereeId: req.userId,
          topupRequestId: req.id,
          usdtEarned: String(usdtEarned.toFixed(2)),
          livesEarned,
        });

        await tx.update(users)
          .set({ usdtBalance: sql`usdt_balance + ${usdtEarned.toFixed(2)}` })
          .where(eq(users.id, referrerId));

        if (livesEarned >= 1) {
          await creditLivesTx(
            tx as any, referrerId, livesEarned, "referral_bonus",
            req.id, "topup_request",
            `Komisi referral dari topup user #${req.userId}`,
          );
        }
      }

      return { newBalance, referrerId };
    });

    // ── Broadcast WS di luar transaction (non-critical) ────────────────────
    broadcastEvent("topup:approved", {
      userId: req.userId, livesAmount: req.livesAmount, newBalance,
    }, `user:${req.userId}`);
    broadcastEvent("topup:approved", {
      userId: req.userId,
      topupId: req.id,
      livesAmount: req.livesAmount,
      newBalance,
    }, "admin");

    return c.json({
      message: `Topup disetujui. User #${req.userId} mendapat ${req.livesAmount} nyawa (saldo baru: ${newBalance})`,
    });
  },

  // PATCH /api/topup/:id/reject — admin reject
  async reject(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID tidak valid" }, 400);
    const body = await c.req.json().catch(() => ({})) as { adminNote?: string };

    const [req] = await db.select().from(topupRequests).where(eq(topupRequests.id, id));
    if (!req) return c.json({ error: "Request tidak ditemukan" }, 404);
    if (req.status !== "pending") {
      return c.json({ error: `Request sudah ${req.status}, tidak bisa diubah` }, 409);
    }

    await db
      .update(topupRequests)
      .set({
        status: "rejected",
        adminNote: body.adminNote ?? null,
        approvedBy: Number(me.sub),
        processedAt: new Date(),
      })
      .where(eq(topupRequests.id, id));

    broadcastEvent("topup:rejected", {
      userId: req.userId,
      topupId: id,
      note: body.adminNote ?? null,
    }, `user:${req.userId}`);
    broadcastEvent("topup:rejected", {
      userId: req.userId,
      topupId: id,
      note: body.adminNote ?? null,
    }, "admin");

    return c.json({ message: `Topup #${id} ditolak` });
  },
};
