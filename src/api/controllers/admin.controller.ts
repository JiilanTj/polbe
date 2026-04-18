import type { Context } from "hono";
import { db } from "../../db";
import { users, livesTransactions } from "../../db/schema";
import { eq, desc, ilike, sql, or } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";

export const adminController = {
  // GET /api/admin/users — list semua user dengan filter
  async listUsers(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const offset = (page - 1) * limit;
    const search = c.req.query("search")?.trim();
    const role = c.req.query("role");

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
      .orderBy(desc(users.createdAt))
      .limit(limit)
      .offset(offset);

    if (search) {
      query = query.where(
        or(ilike(users.email, `%${search}%`), ilike(users.username, `%${search}%`)),
      ) as typeof query;
    }
    if (role) {
      query = query.where(eq(users.role, role as any)) as typeof query;
    }

    const rows = await query;

    const countResult = await db.select({ total: sql<number>`count(*)` }).from(users);
    const total = countResult[0]?.total ?? 0;

    return c.json({
      data: rows,
      pagination: { page, limit, total: Number(total), totalPages: Math.ceil(Number(total) / limit) },
    });
  },

  // GET /api/admin/users/:id — detail user
  async getUser(c: Context) {
    const id = Number(c.req.param("id"));
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
    const id = Number(c.req.param("id"));
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

    return c.json({
      message: `User #${id} (${updated.username}) ${updated.isActive ? "diaktifkan" : "dinonaktifkan"}`,
      data: updated,
    });
  },

  // POST /api/admin/users/:id/credit — manual kredit/debit nyawa
  async creditLives(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { amount, note } = body as { amount?: number; note?: string };
    if (amount === undefined || amount === 0) {
      return c.json({ error: "Field 'amount' wajib diisi dan tidak boleh 0 (negatif = debit)" }, 422);
    }

    const [user] = await db.select({ livesBalance: users.livesBalance, username: users.username }).from(users).where(eq(users.id, id));
    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    const newBalance = user.livesBalance + Number(amount);
    if (newBalance < 0) {
      return c.json({ error: `Saldo tidak cukup. Saldo saat ini: ${user.livesBalance}` }, 400);
    }

    await db.update(users).set({ livesBalance: newBalance, updatedAt: new Date() }).where(eq(users.id, id));
    await db.insert(livesTransactions).values({
      userId: id,
      amount: Number(amount),
      type: amount > 0 ? "admin_credit" : "admin_debit",
      refId: Number(me.sub),
      refType: "admin_action",
      note: note ?? `Admin ${amount > 0 ? "kredit" : "debit"} ${Math.abs(amount)} nyawa`,
      balanceAfter: newBalance,
    });

    return c.json({
      message: `${amount > 0 ? "Kredit" : "Debit"} ${Math.abs(amount)} nyawa ke @${user.username}. Saldo baru: ${newBalance}`,
    });
  },

  // PATCH /api/admin/users/:id/role — ubah role user
  async changeRole(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = Number(c.req.param("id"));
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { role } = body as { role?: string };
    const VALID_ROLES = ["user", "admin", "platform"];
    if (!role || !VALID_ROLES.includes(role)) {
      return c.json({ error: `Role tidak valid. Pilihan: ${VALID_ROLES.join(", ")}` }, 422);
    }

    if (Number(me.sub) === id && role !== "admin") {
      return c.json({ error: "Tidak bisa mencopot role admin dari akun sendiri" }, 400);
    }

    const [updated] = await db
      .update(users)
      .set({ role: role as any, updatedAt: new Date() })
      .where(eq(users.id, id))
      .returning({ id: users.id, username: users.username, role: users.role });

    if (!updated) return c.json({ error: "User tidak ditemukan" }, 404);

    return c.json({ message: `Role @${updated.username} diubah ke '${role}'`, data: updated });
  },
};
