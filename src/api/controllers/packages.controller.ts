import type { Context } from "hono";
import { db } from "../../db";
import { adminAuditLogs, lifePackages } from "../../db/schema";
import { asc, eq, inArray } from "drizzle-orm";
import { verifyAccessToken, type TokenPayload } from "../../lib/jwt";

// Paket default sesuai spec klien
const DEFAULT_PACKAGES = [
  { label: "Starter",    usdtPrice: "1",   livesAmount: 1,    sortOrder: 1 },
  { label: "Basic",      usdtPrice: "5",   livesAmount: 6,    sortOrder: 2 },
  { label: "Value",      usdtPrice: "10",  livesAmount: 15,   sortOrder: 3 },
  { label: "Pro",        usdtPrice: "50",  livesAmount: 80,   sortOrder: 4 },
  { label: "Elite",      usdtPrice: "100", livesAmount: 180,  sortOrder: 5 },
  { label: "Legend",     usdtPrice: "500", livesAmount: 1000, sortOrder: 6 },
];

function requestIp(c: Context) {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

export const packagesController = {
  // GET /api/packages — publik
  async list(c: Context) {
    const includeInactive = c.req.query("includeInactive") === "true";

    if (includeInactive) {
      const authorization = c.req.header("Authorization");
      if (!authorization?.startsWith("Bearer ")) {
        return c.json({ error: "Missing or invalid Authorization header" }, 401);
      }

      try {
        const payload = await verifyAccessToken(authorization.slice(7));
        if (payload.role !== "admin") {
          return c.json({ error: "Insufficient permissions" }, 403);
        }
      } catch {
        return c.json({ error: "Token expired or invalid" }, 401);
      }

      const rows = await db
        .select()
        .from(lifePackages)
        .orderBy(asc(lifePackages.sortOrder));

      return c.json({ data: rows });
    }

    const rows = await db
      .select()
      .from(lifePackages)
      .where(eq(lifePackages.isActive, true))
      .orderBy(asc(lifePackages.sortOrder));

    return c.json({ data: rows });
  },

  // POST /api/packages/seed — admin only, seed default packages
  async seed(c: Context) {
    const me = c.get("user") as TokenPayload;
    const labels = DEFAULT_PACKAGES.map((pkg) => pkg.label);
    const existing = await db
      .select({ label: lifePackages.label })
      .from(lifePackages)
      .where(inArray(lifePackages.label, labels));
    const existingLabels = new Set(existing.map((pkg) => pkg.label));
    const missing = DEFAULT_PACKAGES.filter((pkg) => !existingLabels.has(pkg.label));

    if (missing.length === 0) {
      return c.json({ message: "Default packages already exist", data: [] });
    }

    const inserted = await db
      .insert(lifePackages)
      .values(missing)
      .returning();

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "seed_life_packages",
      metadata: { inserted: inserted.map((pkg) => ({ id: pkg.id, label: pkg.label })) },
      ipAddress: requestIp(c),
    });

    return c.json({ message: `Seeded ${inserted.length} packages`, data: inserted });
  },

  // POST /api/packages — admin, tambah paket custom
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Body tidak valid" }, 400);

    const { label, usdtPrice, livesAmount, sortOrder } = body as Record<string, any>;
    if (!label || !usdtPrice || !livesAmount) {
      return c.json({ error: "Field 'label', 'usdtPrice', 'livesAmount' wajib diisi" }, 422);
    }
    if (Number(usdtPrice) <= 0 || Number(livesAmount) <= 0) {
      return c.json({ error: "usdtPrice dan livesAmount harus > 0" }, 422);
    }

    const [pkg] = await db
      .insert(lifePackages)
      .values({
        label,
        usdtPrice: String(usdtPrice),
        livesAmount: Number(livesAmount),
        sortOrder: Number(sortOrder ?? 99),
      })
      .returning();

    if (pkg) {
      await db.insert(adminAuditLogs).values({
        adminId: Number(me.sub),
        action: "create_life_package",
        metadata: { packageId: pkg.id, label: pkg.label, usdtPrice: pkg.usdtPrice, livesAmount: pkg.livesAmount },
        ipAddress: requestIp(c),
      });
    }

    return c.json({ data: pkg }, 201);
  },

  // PATCH /api/packages/:id — admin, toggle aktif/nonaktif
  async toggle(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = Number(c.req.param("id"));
    const [pkg] = await db.select().from(lifePackages).where(eq(lifePackages.id, id));
    if (!pkg) return c.json({ error: "Package tidak ditemukan" }, 404);

    const [updated] = await db
      .update(lifePackages)
      .set({ isActive: !pkg.isActive })
      .where(eq(lifePackages.id, id))
      .returning();

    if (updated) {
      await db.insert(adminAuditLogs).values({
        adminId: Number(me.sub),
        action: updated.isActive ? "activate_life_package" : "deactivate_life_package",
        metadata: { packageId: updated.id, label: updated.label, isActive: updated.isActive },
        ipAddress: requestIp(c),
      });
    }

    return c.json({ data: updated });
  },
};
