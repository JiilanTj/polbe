import type { Context } from "hono";
import { db } from "../../db";
import { adminAuditLogs, withdrawalRequests, users, platformSettings } from "../../db/schema";
import { eq, desc, sql, and, gte } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";
import { parseBody, safeInt } from "../../lib/validate";
import { withdrawalCreateSchema } from "../../lib/schemas";

function requestIp(c: Context) {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

export const withdrawalController = {
  // POST /api/withdrawal — user minta tarik saldo USDT
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await parseBody(c, withdrawalCreateSchema);
    if (body instanceof Response) return body;

    const { usdtAmount, walletAddress } = body;
    const userId = Number(me.sub);

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

    // ── Minimum & maksimum withdrawal ─────────────────────────────────────
    if (usdtAmount < 10) {
      return c.json({ error: "Minimum withdrawal adalah 10 USDT" }, 422);
    }
    if (usdtAmount > 5000) {
      return c.json({ error: "Maksimum withdrawal adalah 5.000 USDT per request" }, 422);
    }

    // Cek saldo USDT mencukupi
    const [userData] = await db
      .select({ usdtBalance: users.usdtBalance })
      .from(users)
      .where(eq(users.id, userId));

    if (!userData) return c.json({ error: "User tidak ditemukan" }, 404);

    const currentBalance = Number(userData.usdtBalance ?? 0);
    if (currentBalance < usdtAmount) {
      return c.json({
        error: `Saldo USDT tidak cukup. Kamu punya ${currentBalance.toFixed(2)} USDT, butuh ${usdtAmount.toFixed(2)} USDT`,
      }, 400);
    }

    // Ambil platform fee dari settings (default 1% jika belum ada row)
    const settingsRow = await db.select().from(platformSettings).limit(1);
    const feePercent = Number(settingsRow[0]?.withdrawalFeePercent ?? 1);
    const feeAmount = Math.round(usdtAmount * feePercent) / 100;
    const netAmount = usdtAmount - feeAmount;

    // Freeze saldo gross (deduct saat create, refund saat reject)
    await db
      .update(users)
      .set({ usdtBalance: sql`usdt_balance - ${usdtAmount.toFixed(2)}` })
      .where(eq(users.id, userId));

    const [request] = await db
      .insert(withdrawalRequests)
      .values({
        userId,
        usdtAmount: usdtAmount.toFixed(2),
        feePercent: feePercent.toFixed(2),
        feeAmount: feeAmount.toFixed(2),
        netAmount: netAmount.toFixed(2),
        walletAddress: walletAddress.trim(),
        status: "pending",
      })
      .returning();
    if (!request) return c.json({ error: "Gagal membuat request withdrawal" }, 500);

    broadcastEvent("withdrawal:created", {
      userId: request.userId,
      withdrawalId: request.id,
      usdtAmount: request.usdtAmount,
      netAmount: request.netAmount,
    }, "admin");

    return c.json({
      message: "Request withdrawal berhasil dikirim. Menunggu konfirmasi admin.",
      data: {
        ...request,
        feeInfo: {
          grossAmount: usdtAmount,
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

    // Refund saldo USDT karena sudah di-freeze saat create
    await db
      .update(users)
      .set({ usdtBalance: sql`usdt_balance + ${req.usdtAmount}` })
      .where(eq(users.id, req.userId));

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "reject_withdrawal",
      targetUserId: req.userId,
      targetResourceId: req.id,
      targetResourceType: "withdrawal",
      metadata: {
        usdtAmount: req.usdtAmount,
        netAmount: req.netAmount,
        adminNote: body.adminNote ?? null,
      },
      ipAddress: requestIp(c),
    });

    broadcastEvent("withdrawal:rejected", {
      userId: req.userId,
      withdrawalId: id,
      usdtRefunded: req.usdtAmount,
      note: body.adminNote ?? null,
    }, `user:${req.userId}`);
    broadcastEvent("withdrawal:rejected", {
      userId: req.userId,
      withdrawalId: id,
      usdtRefunded: req.usdtAmount,
      note: body.adminNote ?? null,
    }, "admin");

    return c.json({ message: `Withdrawal #${id} ditolak. Saldo ${req.usdtAmount} USDT dikembalikan.` });
  },
};
