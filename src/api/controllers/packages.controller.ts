import type { Context } from "hono";
import { db } from "../../db";
import { lifePackages } from "../../db/schema";
import { asc, eq } from "drizzle-orm";

// Paket default sesuai spec klien
const DEFAULT_PACKAGES = [
  { label: "Starter",    usdtPrice: "1",   livesAmount: 1,    sortOrder: 1 },
  { label: "Basic",      usdtPrice: "5",   livesAmount: 6,    sortOrder: 2 },
  { label: "Value",      usdtPrice: "10",  livesAmount: 15,   sortOrder: 3 },
  { label: "Pro",        usdtPrice: "50",  livesAmount: 80,   sortOrder: 4 },
  { label: "Elite",      usdtPrice: "100", livesAmount: 180,  sortOrder: 5 },
  { label: "Legend",     usdtPrice: "500", livesAmount: 1000, sortOrder: 6 },
];

export const packagesController = {
  // GET /api/packages — publik
  async list(c: Context) {
    const rows = await db
      .select()
      .from(lifePackages)
      .where(eq(lifePackages.isActive, true))
      .orderBy(asc(lifePackages.sortOrder));

    return c.json({ data: rows });
  },

  // POST /api/packages/seed — admin only, seed default packages
  async seed(c: Context) {
    const inserted = await db
      .insert(lifePackages)
      .values(DEFAULT_PACKAGES)
      .onConflictDoNothing()
      .returning();

    return c.json({ message: `Seeded ${inserted.length} packages`, data: inserted });
  },

  // POST /api/packages — admin, tambah paket custom
  async create(c: Context) {
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

    return c.json({ data: pkg }, 201);
  },

  // PATCH /api/packages/:id — admin, toggle aktif/nonaktif
  async toggle(c: Context) {
    const id = Number(c.req.param("id"));
    const [pkg] = await db.select().from(lifePackages).where(eq(lifePackages.id, id));
    if (!pkg) return c.json({ error: "Package tidak ditemukan" }, 404);

    const [updated] = await db
      .update(lifePackages)
      .set({ isActive: !pkg.isActive })
      .where(eq(lifePackages.id, id))
      .returning();

    return c.json({ data: updated });
  },
};
