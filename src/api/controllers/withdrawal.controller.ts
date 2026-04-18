import type { Context } from "hono";
import { db } from "../../db";
import { withdrawalRequests } from "../../db/schema";
import { eq, desc } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { broadcastEvent } from "../../ws/handler";

export const withdrawalController = {
  // POST /api/withdrawal — user minta tarik saldo
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { usdtAmount, walletAddress } = body as Record<string, any>;

    if (!usdtAmount || Number(usdtAmount) <= 0) {
      return c.json({ error: "Field 'usdtAmount' wajib > 0" }, 422);
    }
    if (!walletAddress?.trim()) {
      return c.json({ error: "Field 'walletAddress' wajib diisi (alamat USDT tujuan)" }, 422);
    }
    if (Number(usdtAmount) < 1) {
      return c.json({ error: "Minimum withdrawal 1 USDT" }, 422);
    }

    const [request] = await db
      .insert(withdrawalRequests)
      .values({
        userId: Number(me.sub),
        usdtAmount: String(Number(usdtAmount).toFixed(2)),
        walletAddress: walletAddress.trim(),
        status: "pending",
      })
      .returning();

    return c.json({
      message: "Request withdrawal berhasil dikirim. Menunggu konfirmasi admin.",
      data: request,
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
    const id = Number(c.req.param("id"));
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

    broadcastEvent("withdrawal:approved", {
      userId: req.userId,
      withdrawalId: id,
      usdtAmount: req.usdtAmount,
      txHash: body.txHash ?? null,
    }, `user:${req.userId}`);

    return c.json({
      message: `Withdrawal #${id} disetujui${body.txHash ? ` (TxHash: ${body.txHash})` : ""}`,
      data: updated,
    });
  },

  // PATCH /api/withdrawal/:id/reject — admin reject
  async reject(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = Number(c.req.param("id"));
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

    broadcastEvent("withdrawal:rejected", {
      userId: req.userId,
      withdrawalId: id,
      note: body.adminNote ?? null,
    }, `user:${req.userId}`);

    return c.json({ message: `Withdrawal #${id} ditolak` });
  },
};
