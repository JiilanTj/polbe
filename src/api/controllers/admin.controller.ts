import type { Context } from "hono";
import { db } from "../../db";
import { users, livesTransactions, topupRequests, withdrawalRequests, polls, orders, positions, trades, adminAuditLogs, platformSettings } from "../../db/schema";
import { eq, desc, ilike, sql, or, and } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { parseBody, safeInt } from "../../lib/validate";
import { adminCreditSchema, adminRoleSchema } from "../../lib/schemas";

type TopupPaymentMethod = {
  network: string;
  label: string;
  address: string;
  isActive: boolean;
};

function normalizeTopupPaymentMethods(input: unknown): TopupPaymentMethod[] {
  if (!Array.isArray(input)) return [];

  const seen = new Set<string>();
  const methods: TopupPaymentMethod[] = [];

  for (const raw of input) {
    if (!raw || typeof raw !== "object") continue;
    const item = raw as Record<string, unknown>;
    const network = String(item.network ?? "").trim().toUpperCase();
    const address = String(item.address ?? "").trim();
    const label = String(item.label ?? network).trim() || network;
    const isActive = item.isActive !== false;

    if (!network || !address || seen.has(network)) continue;
    seen.add(network);
    methods.push({ network, label, address, isActive });
  }

  return methods;
}

export const adminController = {
  // GET /api/admin/stats — ringkasan dashboard admin
  async stats(c: Context) {
    const [pendingTopup, pendingWithdrawal, totalUsers, activePolls, livesStats] = await Promise.all([
      db.select({ count: sql<number>`count(*)` }).from(topupRequests).where(eq(topupRequests.status, "pending")),
      db.select({ count: sql<number>`count(*)` }).from(withdrawalRequests).where(eq(withdrawalRequests.status, "pending")),
      db.select({ count: sql<number>`count(*)` }).from(users),
      db.select({ count: sql<number>`count(*)` }).from(polls).where(eq(polls.status, "active")),
      db.select({ total: sql<number>`coalesce(sum(lives_balance), 0)` }).from(users),
    ]);

    return c.json({
      data: {
        pendingTopup: Number(pendingTopup[0]?.count ?? 0),
        pendingWithdrawal: Number(pendingWithdrawal[0]?.count ?? 0),
        totalUsers: Number(totalUsers[0]?.count ?? 0),
        activePolls: Number(activePolls[0]?.count ?? 0),
        totalLivesInCirculation: Number(livesStats[0]?.total ?? 0),
      },
    });
  },

  // GET /api/admin/users — list semua user dengan filter
  async listUsers(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;
    const search = c.req.query("search")?.trim();
    const role = c.req.query("role");
    const conditions: any[] = [];

    if (search) {
      conditions.push(or(ilike(users.email, `%${search}%`), ilike(users.username, `%${search}%`)));
    }
    if (role === 'contributor') {
      conditions.push(sql`${users.contributorUntil} > now()`);
    } else if (role) {
      conditions.push(eq(users.role, role as any));
    }

    let query = db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
        livesBalance: users.livesBalance,
        livesRecoveryAt: users.livesRecoveryAt,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    const rows = await query;

    const countResult = await db
      .select({ total: sql<number>`count(*)` })
      .from(users)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    const total = countResult[0]?.total ?? 0;

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  },

  // GET /api/admin/users/:id — detail user
  async getUser(c: Context) {
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID tidak valid" }, 400);
    const [user] = await db
      .select({
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
        isActive: users.isActive,
        livesBalance: users.livesBalance,
        livesRecoveryAt: users.livesRecoveryAt,
        referralCode: users.referralCode,
        referredBy: users.referredBy,
        createdAt: users.createdAt,
        updatedAt: users.updatedAt,
      })
      .from(users)
      .where(eq(users.id, id));

    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    // Recent lives transactions
    const recentTx = await db
      .select()
      .from(livesTransactions)
      .where(eq(livesTransactions.userId, id))
      .orderBy(desc(livesTransactions.createdAt))
      .limit(10);

    return c.json({ data: { ...user, recentTransactions: recentTx } });
  },

  // PATCH /api/admin/users/:id/toggle — aktifkan / nonaktifkan akun
  async toggleUser(c: Context) {
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID tidak valid" }, 400);
    const me = c.get("user") as TokenPayload;

    if (Number(me.sub) === id) {
      return c.json({ error: "Tidak bisa menonaktifkan akun sendiri" }, 400);
    }

    const [user] = await db.select({ isActive: users.isActive }).from(users).where(eq(users.id, id));
    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    const [updated] = await db
      .update(users)
      .set({ isActive: !user.isActive, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, username: users.username, isActive: users.isActive });

    if (!updated) return c.json({ error: "User tidak ditemukan" }, 404);

    // Audit log
    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: updated.isActive ? "activate_user" : "deactivate_user",
      targetUserId: id,
      metadata: { isActive: updated.isActive },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({
      message: `User #${id} (${updated.username}) ${updated.isActive ? "diaktifkan" : "dinonaktifkan"}`,
      data: updated,
    });
  },

  // POST /api/admin/users/:id/credit — manual kredit/debit nyawa
  async creditLives(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID user tidak valid" }, 400);

    const body = await parseBody(c, adminCreditSchema);
    if (body instanceof Response) return body;

    const { amount, note } = body;

    const [user] = await db.select({ livesBalance: users.livesBalance, username: users.username }).from(users).where(eq(users.id, id));
    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    const currentBalance = Number(user.livesBalance);
    const newBalance = currentBalance + amount;
    if (newBalance < 0) {
      return c.json({ error: `Saldo tidak cukup. Saldo saat ini: ${user.livesBalance}` }, 400);
    }

    await db.update(users).set({ livesBalance: newBalance.toString(), updatedAt: new Date() }).where(eq(users.id, id));
    await db.insert(livesTransactions).values({
      userId: id,
      amount: amount.toString(),
      type: amount > 0 ? "admin_credit" : "admin_debit",
      refId: Number(me.sub),
      refType: "admin_action",
      note: note ?? `Admin ${amount > 0 ? "kredit" : "debit"} ${Math.abs(amount)} nyawa`,
      balanceAfter: newBalance.toString(),
    });

    // Audit log
    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: amount > 0 ? "credit_lives" : "debit_lives",
      targetUserId: id,
      metadata: { amount, note, newBalance },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({
      message: `${amount > 0 ? "Kredit" : "Debit"} ${Math.abs(amount)} nyawa ke @${user.username}. Saldo baru: ${newBalance}`,
    });
  },

  // PATCH /api/admin/users/:id/role — ubah role user
  async changeRole(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = safeInt(c.req.param("id"));
    if (!id) return c.json({ error: "ID user tidak valid" }, 400);

    const body = await parseBody(c, adminRoleSchema);
    if (body instanceof Response) return body;

    const { role } = body;

    if (Number(me.sub) === id && role !== "admin") {
      return c.json({ error: "Tidak bisa mencopot role admin dari akun sendiri" }, 400);
    }

    const [updated] = await db
      .update(users)
      .set({ role: role as any, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, username: users.username, role: users.role });

    if (!updated) return c.json({ error: "User tidak ditemukan" }, 404);

    // Audit log
    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "change_role",
      targetUserId: id,
      metadata: { newRole: role },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    return c.json({ message: `Role @${updated.username} diubah ke '${role}'`, data: updated });
  },

  // GET /api/admin/orders — semua orders dengan filter
  async listOrders(c: Context) {
    const page = Math.max(1, safeInt(c.req.query("page") ?? "1") ?? 1);
    const limit = Math.min(100, safeInt(c.req.query("limit") ?? "50") ?? 50);
    const offset = (page - 1) * limit;
    const pollId = safeInt(c.req.query("pollId") ?? "");
    const userId = safeInt(c.req.query("userId") ?? "");
    const status = c.req.query("status");
    const side = c.req.query("side");

    const conditions: any[] = [];
    if (pollId) conditions.push(eq(orders.pollId, pollId));
    if (userId) conditions.push(eq(orders.userId, userId));
    if (status) conditions.push(eq(orders.status, status as any));
    if (side) conditions.push(eq(orders.side, side as any));

    const rows = await db
      .select({
        order: orders,
        username: users.username,
        pollTitle: polls.title,
      })
      .from(orders)
      .leftJoin(users, eq(users.id, orders.userId))
      .leftJoin(polls, eq(polls.id, orders.pollId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(orders.createdAt))
      .limit(limit)
      .offset(offset);

    const [countResult] = await db
      .select({ total: sql<number>`count(*)` })
      .from(orders)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    const total = Number(countResult?.total ?? 0);

    return c.json({
      data: rows,
      page,
      limit,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },

  // GET /api/admin/positions — semua posisi dengan filter
  async listPositions(c: Context) {
    const page = Math.max(1, safeInt(c.req.query("page") ?? "1") ?? 1);
    const limit = Math.min(100, safeInt(c.req.query("limit") ?? "50") ?? 50);
    const offset = (page - 1) * limit;
    const pollId = safeInt(c.req.query("pollId") ?? "");
    const userId = safeInt(c.req.query("userId") ?? "");

    const conditions: any[] = [];
    if (pollId) conditions.push(eq(positions.pollId, pollId));
    if (userId) conditions.push(eq(positions.userId, userId));

    const rows = await db
      .select({
        position: positions,
        username: users.username,
        pollTitle: polls.title,
      })
      .from(positions)
      .leftJoin(users, eq(users.id, positions.userId))
      .leftJoin(polls, eq(polls.id, positions.pollId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(positions.updatedAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data: rows, page, limit });
  },

  // GET /api/admin/trades — semua trades dengan filter
  async listTrades(c: Context) {
    const page = Math.max(1, safeInt(c.req.query("page") ?? "1") ?? 1);
    const limit = Math.min(100, safeInt(c.req.query("limit") ?? "50") ?? 50);
    const offset = (page - 1) * limit;
    const pollId = safeInt(c.req.query("pollId") ?? "");

    const conditions: any[] = [];
    if (pollId) conditions.push(eq(trades.pollId, pollId));

    const makerUser = {
      username: sql<string>`maker_u.username`.as("makerUsername"),
    };

    const rows = await db
      .select({
        trade: trades,
        makerUsername: sql<string>`(SELECT username FROM users WHERE id = ${trades.makerUserId})`,
        takerUsername: sql<string>`(SELECT username FROM users WHERE id = ${trades.takerUserId})`,
        pollTitle: polls.title,
      })
      .from(trades)
      .leftJoin(polls, eq(polls.id, trades.pollId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(trades.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data: rows, page, limit });
  },

  // GET /api/admin/audit-logs — riwayat aksi admin
  async listAuditLogs(c: Context) {
    const page = Math.max(1, safeInt(c.req.query("page") ?? "1") ?? 1);
    const limit = Math.min(100, safeInt(c.req.query("limit") ?? "50") ?? 50);
    const offset = (page - 1) * limit;
    const adminId = safeInt(c.req.query("adminId") ?? "");
    const action = c.req.query("action")?.trim();
    const targetResourceType = c.req.query("targetResourceType")?.trim();
    const targetUserId = safeInt(c.req.query("targetUserId") ?? "");
    const targetResourceId = safeInt(c.req.query("targetResourceId") ?? "");

    const conditions: any[] = [];
    if (adminId) conditions.push(eq(adminAuditLogs.adminId, adminId));
    if (action) conditions.push(ilike(adminAuditLogs.action, `%${action}%`));
    if (targetResourceType) conditions.push(eq(adminAuditLogs.targetResourceType, targetResourceType));
    if (targetUserId) conditions.push(eq(adminAuditLogs.targetUserId, targetUserId));
    if (targetResourceId) conditions.push(eq(adminAuditLogs.targetResourceId, targetResourceId));

    const rows = await db
      .select({
        log: adminAuditLogs,
        adminUsername: users.username,
      })
      .from(adminAuditLogs)
      .leftJoin(users, eq(users.id, adminAuditLogs.adminId))
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(adminAuditLogs.createdAt))
      .limit(limit)
      .offset(offset);

    return c.json({ data: rows, page, limit });
  },

  // GET /api/admin/settings — ambil konfigurasi platform
  async getSettings(c: Context) {
    const [settings] = await db.select().from(platformSettings).limit(1);
    return c.json({
      data: {
        withdrawalFeePercent: Number(settings?.withdrawalFeePercent ?? 1),
        livesToUsdtRate: Number(settings?.livesToUsdtRate ?? 1),
        topupPaymentMethods: normalizeTopupPaymentMethods(settings?.topupPaymentMethods),
      },
    });
  },

  // PATCH /api/admin/settings/withdrawal-fee — ubah withdrawal fee
  async updateWithdrawalFee(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await c.req.json().catch(() => ({})) as { feePercent?: number };

    const fee = Number(body.feePercent);
    if (isNaN(fee) || fee < 0 || fee > 100) {
      return c.json({ error: "feePercent harus antara 0 dan 100" }, 422);
    }

    // Upsert: update row id=1, atau insert jika belum ada
    const existing = await db.select({ id: platformSettings.id }).from(platformSettings).limit(1);
    if (existing.length > 0 && existing[0]) {
      await db
        .update(platformSettings)
        .set({ withdrawalFeePercent: fee.toFixed(2), updatedAt: new Date(), updatedBy: Number(me.sub) })
        .where(eq(platformSettings.id, existing[0].id));
    } else {
      await db
        .insert(platformSettings)
        .values({ withdrawalFeePercent: fee.toFixed(2), updatedBy: Number(me.sub) });
    }

    // Audit log
    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "update_withdrawal_fee",
      metadata: { withdrawalFeePercent: fee },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    const [settings] = await db.select().from(platformSettings).limit(1);
    return c.json({
      message: `Withdrawal fee diubah ke ${fee}%`,
      data: {
        withdrawalFeePercent: fee,
        livesToUsdtRate: Number(settings?.livesToUsdtRate ?? 1),
        topupPaymentMethods: normalizeTopupPaymentMethods(settings?.topupPaymentMethods),
      },
    });
  },

  // PATCH /api/admin/settings/lives-to-usdt-rate — ubah rate konversi WD Lives → USDT
  async updateLivesToUsdtRate(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await c.req.json().catch(() => ({})) as { rate?: number };

    const rate = Number(body.rate);
    if (isNaN(rate) || rate <= 0 || rate > 1000000) {
      return c.json({ error: "rate harus angka > 0" }, 422);
    }

    const existing = await db.select({ id: platformSettings.id }).from(platformSettings).limit(1);
    if (existing.length > 0 && existing[0]) {
      await db
        .update(platformSettings)
        .set({ livesToUsdtRate: rate.toFixed(4), updatedAt: new Date(), updatedBy: Number(me.sub) })
        .where(eq(platformSettings.id, existing[0].id));
    } else {
      await db
        .insert(platformSettings)
        .values({ livesToUsdtRate: rate.toFixed(4), updatedBy: Number(me.sub) });
    }

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "update_lives_to_usdt_rate",
      metadata: { livesToUsdtRate: rate },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    const [settings] = await db.select().from(platformSettings).limit(1);
    return c.json({
      message: `Rate Lives to USDT diubah ke ${rate}`,
      data: {
        withdrawalFeePercent: Number(settings?.withdrawalFeePercent ?? 1),
        livesToUsdtRate: Number(settings?.livesToUsdtRate ?? rate),
        topupPaymentMethods: normalizeTopupPaymentMethods(settings?.topupPaymentMethods),
      },
    });
  },

  // PATCH /api/admin/settings/topup-payment-methods — ubah alamat tujuan topup USDT
  async updateTopupPaymentMethods(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await c.req.json().catch(() => ({})) as { methods?: unknown };
    const methods = normalizeTopupPaymentMethods(body.methods);

    if (methods.length === 0) {
      return c.json({ error: "Minimal satu network aktif/alamat USDT wajib diisi" }, 422);
    }

    const existing = await db.select({ id: platformSettings.id }).from(platformSettings).limit(1);
    if (existing.length > 0 && existing[0]) {
      await db
        .update(platformSettings)
        .set({ topupPaymentMethods: methods, updatedAt: new Date(), updatedBy: Number(me.sub) })
        .where(eq(platformSettings.id, existing[0].id));
    } else {
      await db
        .insert(platformSettings)
        .values({ topupPaymentMethods: methods, updatedBy: Number(me.sub) });
    }

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "update_topup_payment_methods",
      metadata: { networks: methods.map((method) => method.network) },
      ipAddress: c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null,
    });

    const [settings] = await db.select().from(platformSettings).limit(1);
    return c.json({
      message: "Payment method topup berhasil disimpan",
      data: {
        withdrawalFeePercent: Number(settings?.withdrawalFeePercent ?? 1),
        livesToUsdtRate: Number(settings?.livesToUsdtRate ?? 1),
        topupPaymentMethods: methods,
      },
    });
  },
};
