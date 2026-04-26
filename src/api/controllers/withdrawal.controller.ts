import type { Context } from "hono";
import { db } from "../../db";
import { adminAuditLogs, livesTransactions, withdrawalRequests, users, platformSettings } from "../../db/schema";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";
import { parseBody, safeInt } from "../../lib/validate";
import { withdrawalCreateSchema } from "../../lib/schemas";

function requestIp(c: Context) {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

const WITHDRAWAL_NETWORKS = ["TRC-20", "ERC-20", "BEP-20", "POLYGON"];

function normalizeNetwork(value: string) {
  return value.trim().toUpperCase();
}

export const withdrawalController = {
  // GET /api/withdrawal/settings — user lihat fee dan rate konversi Lives → USDT
  async settings(c: Context) {
    const [settings] = await db.select().from(platformSettings).limit(1);
    return c.json({
      data: {
        withdrawalFeePercent: Number(settings?.withdrawalFeePercent ?? 1),
        livesToUsdtRate: Number(settings?.livesToUsdtRate ?? 1),
        withdrawalNetworks: WITHDRAWAL_NETWORKS,
        minWithdrawalUsdt: 10,
        maxWithdrawalUsdt: 5000,
      },
    });
  },

  // POST /api/withdrawal — user minta tarik saldo USDT/Lives/hybrid
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await parseBody(c, withdrawalCreateSchema);
    if (body instanceof Response) return body;

    const { usdtAmount, livesAmount, withdrawalNetwork, walletAddress } = body;
    const userId = Number(me.sub);
    const usdtDebit = Number(usdtAmount || 0);
    const livesDebit = Number(livesAmount || 0);
    const selectedNetwork = normalizeNetwork(withdrawalNetwork);

    if (!WITHDRAWAL_NETWORKS.includes(selectedNetwork)) {
      return c.json({ error: "Network withdrawal tidak valid" }, 422);
    }

    // ── Rate limit: maks 3 withdrawal per hari ─────────────────────────────
    const startOfDay = new Date();
    startOfDay.setHours(0, 0, 0, 0);

    const todayCountRow = await db
      .select({ count: sql<number>`COUNT(*)` })
      .from(withdrawalRequests)
      .where(and(
        eq(withdrawalRequests.userId, userId),
        gte(withdrawalRequests.createdAt, startOfDay),
      ));

    if (Number(todayCountRow[0]?.count ?? 0) >= 3) {
      return c.json({ error: "Batas maksimum 3 request withdrawal per hari telah tercapai." }, 429);
    }

    // Ambil platform fee dari settings (default 1% jika belum ada row)
    const settingsRow = await db.select().from(platformSettings).limit(1);
    const feePercent = Number(settingsRow[0]?.withdrawalFeePercent ?? 1);
    const livesToUsdtRate = Number(settingsRow[0]?.livesToUsdtRate ?? 1);
    const livesAsUsdt = livesDebit * livesToUsdtRate;
    const grossAmount = usdtDebit + livesAsUsdt;
    const withdrawalSource = usdtDebit > 0 && livesDebit > 0 ? "hybrid" : livesDebit > 0 ? "lives" : "usdt";

    // ── Minimum & maksimum withdrawal dihitung setelah Lives dikonversi ───
    if (grossAmount < 10) {
      return c.json({ error: "Minimum withdrawal adalah 10 USDT setelah konversi" }, 422);
    }
    if (grossAmount > 5000) {
      return c.json({ error: "Maksimum withdrawal adalah 5.000 USDT per request" }, 422);
    }

    const feeAmount = Math.round(grossAmount * feePercent) / 100;
    const netAmount = grossAmount - feeAmount;

    const request = await db.transaction(async (tx) => {
      const [userData] = await tx
        .select({ usdtBalance: users.usdtBalance, livesBalance: users.livesBalance })
        .from(users)
        .where(eq(users.id, userId))
        .for("update");

      if (!userData) throw new Error("USER_NOT_FOUND");

      const currentUsdt = Number(userData.usdtBalance ?? 0);
      const currentLives = Number(userData.livesBalance ?? 0);
      if (currentUsdt < usdtDebit) throw new Error(`INSUFFICIENT_USDT:${currentUsdt}:${usdtDebit}`);
      if (currentLives < livesDebit) throw new Error(`INSUFFICIENT_LIVES:${currentLives}:${livesDebit}`);

      await tx
        .update(users)
        .set({
          usdtBalance: sql`usdt_balance - ${usdtDebit.toFixed(2)}`,
          livesBalance: sql`lives_balance - ${livesDebit.toFixed(6)}`,
        })
        .where(eq(users.id, userId));

      const [row] = await tx
        .insert(withdrawalRequests)
        .values({
          userId,
          usdtAmount: grossAmount.toFixed(2),
          usdtDebited: usdtDebit.toFixed(2),
          livesDebited: livesDebit.toFixed(6),
          livesToUsdtRate: livesToUsdtRate.toFixed(4),
          withdrawalSource,
          feePercent: feePercent.toFixed(2),
          feeAmount: feeAmount.toFixed(2),
          netAmount: netAmount.toFixed(2),
          withdrawalNetwork: selectedNetwork,
          walletAddress: walletAddress.trim(),
          status: "pending",
        })
        .returning();

      if (livesDebit > 0 && row) {
        await tx.insert(livesTransactions).values({
          userId,
          amount: (-livesDebit).toFixed(6),
          type: "withdrawal_debit",
          refId: row.id,
          refType: "withdrawal",
          note: `Freeze ${livesDebit} lives untuk withdrawal (${livesAsUsdt.toFixed(2)} USDT)`,
          balanceAfter: (currentLives - livesDebit).toFixed(6),
        });
      }

      return row;
    }).catch((err: Error) => {
      if (err.message === "USER_NOT_FOUND") return c.json({ error: "User tidak ditemukan" }, 404);
      if (err.message.startsWith("INSUFFICIENT_USDT")) {
        const [, have, need] = err.message.split(":");
        return c.json({ error: `Saldo USDT tidak cukup. Kamu punya ${Number(have).toFixed(2)} USDT, butuh ${Number(need).toFixed(2)} USDT` }, 400);
      }
      if (err.message.startsWith("INSUFFICIENT_LIVES")) {
        const [, have, need] = err.message.split(":");
        return c.json({ error: `Saldo Lives tidak cukup. Kamu punya ${Number(have).toFixed(6)}, butuh ${Number(need).toFixed(6)}` }, 400);
      }
      throw err;
    });

    if (request instanceof Response) return request;
    if (!request) return c.json({ error: "Gagal membuat request withdrawal" }, 500);

    broadcastEvent("withdrawal:created", {
      userId: request.userId,
      withdrawalId: request.id,
      usdtAmount: request.usdtAmount,
      netAmount: request.netAmount,
      withdrawalSource: request.withdrawalSource,
      withdrawalNetwork: request.withdrawalNetwork,
    }, "admin");

    return c.json({
      message: "Request withdrawal berhasil dikirim. Menunggu konfirmasi admin.",
      data: {
        ...request,
        feeInfo: {
          grossAmount,
          usdtDebited: usdtDebit,
          livesDebited: livesDebit,
          livesToUsdtRate,
          feePercent,
          feeAmount,
          netAmount,
        },
      },
    }, 201);
  },

  // GET /api/withdrawal — user lihat history; admin lihat semua
  async list(c: Context) {
    const me = c.get("user") as TokenPayload;
    const isAdmin = me.role === "admin";
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;

    let query = db
      .select()
      .from(withdrawalRequests)
      .orderBy(desc(withdrawalRequests.createdAt))
      .limit(limit)
      .offset(offset);

    if (!isAdmin) {
      query = query.where(eq(withdrawalRequests.userId, Number(me.sub))) as typeof query;
    }

    const rows = await query;
    return c.json({ data: rows });
  },

  // PATCH /api/withdrawal/:id/approve — admin approve, isi txHash
  async approve(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID tidak valid" }, 400);
    const body = await c.req.json().catch(() => ({})) as { txHash?: string; adminNote?: string };

    const [req] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, id));
    if (!req) return c.json({ error: "Request tidak ditemukan" }, 404);
    if (req.status !== "pending") {
      return c.json({ error: `Request sudah ${req.status}, tidak bisa diubah` }, 409);
    }

    const [updated] = await db
      .update(withdrawalRequests)
      .set({
        status: "approved",
        txHash: body.txHash ?? null,
        adminNote: body.adminNote ?? null,
        approvedBy: Number(me.sub),
        processedAt: new Date(),
      })
      .where(eq(withdrawalRequests.id, id))
      .returning();

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "approve_withdrawal",
      targetUserId: req.userId,
      targetResourceId: req.id,
      targetResourceType: "withdrawal",
      metadata: {
        usdtAmount: req.usdtAmount,
        usdtDebited: req.usdtDebited,
        livesDebited: req.livesDebited,
        livesToUsdtRate: req.livesToUsdtRate,
        withdrawalSource: req.withdrawalSource,
        netAmount: req.netAmount,
        txHash: body.txHash ?? null,
        adminNote: body.adminNote ?? null,
      },
      ipAddress: requestIp(c),
    });

    broadcastEvent("withdrawal:approved", {
      userId: req.userId,
      withdrawalId: id,
      usdtAmount: req.usdtAmount,
      txHash: body.txHash ?? null,
    }, `user:${req.userId}`);
    broadcastEvent("withdrawal:approved", {
      userId: req.userId,
      withdrawalId: id,
      usdtAmount: req.usdtAmount,
      txHash: body.txHash ?? null,
    }, "admin");

    return c.json({
      message: `Withdrawal #${id} disetujui${body.txHash ? ` (TxHash: ${body.txHash})` : ""}`,
      data: updated,
    });
  },

  // PATCH /api/withdrawal/:id/reject — admin reject (refund saldo USDT ke user)
  async reject(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID tidak valid" }, 400);
    const body = await c.req.json().catch(() => ({})) as { adminNote?: string };

    const [req] = await db.select().from(withdrawalRequests).where(eq(withdrawalRequests.id, id));
    if (!req) return c.json({ error: "Request tidak ditemukan" }, 404);
    if (req.status !== "pending") {
      return c.json({ error: `Request sudah ${req.status}, tidak bisa diubah` }, 409);
    }

    await db
      .update(withdrawalRequests)
      .set({
        status: "rejected",
        adminNote: body.adminNote ?? null,
        approvedBy: Number(me.sub),
        processedAt: new Date(),
      })
      .where(eq(withdrawalRequests.id, id));

    // Refund saldo USDT/Lives karena sudah di-freeze saat create
    await db.transaction(async (tx) => {
      const [userData] = await tx
        .select({ livesBalance: users.livesBalance })
        .from(users)
        .where(eq(users.id, req.userId))
        .for("update");

      await tx
        .update(users)
        .set({
          usdtBalance: sql`usdt_balance + ${req.usdtDebited}`,
          livesBalance: sql`lives_balance + ${req.livesDebited}`,
        })
        .where(eq(users.id, req.userId));

      const livesRefund = Number(req.livesDebited ?? 0);
      if (livesRefund > 0) {
        await tx.insert(livesTransactions).values({
          userId: req.userId,
          amount: livesRefund.toFixed(6),
          type: "withdrawal_refund",
          refId: req.id,
          refType: "withdrawal",
          note: `Refund ${livesRefund} lives dari withdrawal #${req.id}`,
          balanceAfter: (Number(userData?.livesBalance ?? 0) + livesRefund).toFixed(6),
        });
      }
    });

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "reject_withdrawal",
      targetUserId: req.userId,
      targetResourceId: req.id,
      targetResourceType: "withdrawal",
      metadata: {
        usdtAmount: req.usdtAmount,
        usdtDebited: req.usdtDebited,
        livesDebited: req.livesDebited,
        livesToUsdtRate: req.livesToUsdtRate,
        withdrawalSource: req.withdrawalSource,
        netAmount: req.netAmount,
        adminNote: body.adminNote ?? null,
      },
      ipAddress: requestIp(c),
    });

    broadcastEvent("withdrawal:rejected", {
      userId: req.userId,
      withdrawalId: id,
      usdtRefunded: req.usdtDebited,
      livesRefunded: req.livesDebited,
      note: body.adminNote ?? null,
    }, `user:${req.userId}`);
    broadcastEvent("withdrawal:rejected", {
      userId: req.userId,
      withdrawalId: id,
      usdtRefunded: req.usdtDebited,
      livesRefunded: req.livesDebited,
      note: body.adminNote ?? null,
    }, "admin");

    return c.json({ message: `Withdrawal #${id} ditolak. Saldo yang di-freeze dikembalikan.` });
  },
};
