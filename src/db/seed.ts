/**
 * Seed script — jalankan dengan: bun run db:seed
 *
 * Membuat:
 *  1. Admin user    — admin@polymarket.dev / Admin1234!
 *  2. Platform user — platform@polymarket.dev / Platform1234!
 *  3. 3 demo user   — user1/2/3@polymarket.dev / User1234!
 *  4. 6 life packages (Starter → Whale)
 *  5. Platform settings (withdrawal fee 1%)
 *  6. 5 sample polls (active, berbagai kategori)
 */

import { drizzle } from "drizzle-orm/postgres-js";
import postgres from "postgres";
import {
  users,
  lifePackages,
  polls,
  platformSettings,
  livesTransactions,
  pollVotes,
} from "./schema";
import { eq } from "drizzle-orm";

const DATABASE_URL = process.env.DATABASE_URL ?? "postgresql://postgres:postgres@localhost:5432/polymarket";

const client = postgres(DATABASE_URL, { max: 1 });
const db = drizzle(client);

// ─── Helpers ─────────────────────────────────────────────────────────────────

function log(msg: string) {
  console.log(`[seed] ${msg}`);
}

async function hashPassword(plain: string) {
  return Bun.password.hash(plain, { algorithm: "bcrypt", cost: 12 });
}

function randomCode(len = 8) {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789";
  return Array.from({ length: len }, () => chars[Math.floor(Math.random() * chars.length)]).join("");
}

// ─── 1. Users ────────────────────────────────────────────────────────────────

async function seedUsers() {
  const usersData = [
    { email: "admin@polymarket.dev", username: "admin", role: "admin" as const, password: "Admin1234!", lives: "999.00" },
    { email: "platform@polymarket.dev", username: "platform", role: "platform" as const, password: "Platform1234!", lives: "999.00" },
    { email: "user1@polymarket.dev", username: "demo_alice", role: "user" as const, password: "User1234!", lives: "50.00" },
    { email: "user2@polymarket.dev", username: "demo_bob", role: "user" as const, password: "User1234!", lives: "30.00" },
    { email: "user3@polymarket.dev", username: "demo_carol", role: "user" as const, password: "User1234!", lives: "20.00" },
  ];

  const created: Record<string, number> = {};

  for (const u of usersData) {
    const existing = await db.select({ id: users.id }).from(users).where(eq(users.email, u.email));
    if (existing.length > 0 && existing[0]) {
      log(`  skip user ${u.email} (sudah ada)`);
      created[u.role === "admin" || u.role === "platform" ? u.role : u.username] = existing[0].id;
      continue;
    }

    const passwordHash = await hashPassword(u.password);
    const [row] = await db.insert(users).values({
      email: u.email,
      username: u.username,
      passwordHash,
      role: u.role,
      livesBalance: u.lives,
      emailVerifiedAt: new Date(),
      referralCode: randomCode(),
      usdtBalance: "0",
    }).returning({ id: users.id });

    if (!row) continue;

    // Catat transaksi awal lives
    if (Number(u.lives) > 0) {
      await db.insert(livesTransactions).values({
        userId: row.id,
        amount: u.lives,
        type: "admin_credit",
        note: "Seed: saldo awal",
        balanceAfter: u.lives,
      });
    }

    created[u.role === "admin" || u.role === "platform" ? u.role : u.username] = row.id;
    log(`  ✓ user ${u.email} (id=${row.id})`);
  }

  return created;
}

// ─── 2. Life Packages ────────────────────────────────────────────────────────

async function seedPackages() {
  const packages = [
    { label: "Starter", usdtPrice: "1", livesAmount: 1, sortOrder: 1 },
    { label: "Basic", usdtPrice: "5", livesAmount: 6, sortOrder: 2 },
    { label: "Value", usdtPrice: "10", livesAmount: 15, sortOrder: 3 },
    { label: "Pro", usdtPrice: "50", livesAmount: 80, sortOrder: 4 },
    { label: "Elite", usdtPrice: "100", livesAmount: 180, sortOrder: 5 },
    { label: "Whale", usdtPrice: "500", livesAmount: 1000, sortOrder: 6 },
  ];

  for (const pkg of packages) {
    const existing = await db.select({ id: lifePackages.id }).from(lifePackages)
      .where(eq(lifePackages.label, pkg.label));
    if (existing.length > 0) {
      log(`  skip package ${pkg.label} (sudah ada)`);
      continue;
    }
    await db.insert(lifePackages).values({ ...pkg, isActive: true });
    log(`  ✓ package ${pkg.label} (${pkg.usdtPrice} USDT → ${pkg.livesAmount} nyawa)`);
  }
}

// ─── 3. Platform Settings ────────────────────────────────────────────────────

async function seedSettings() {
  const existing = await db.select({ id: platformSettings.id }).from(platformSettings).limit(1);
  if (existing.length > 0) {
    log("  skip platform settings (sudah ada)");
    return;
  }
  await db.insert(platformSettings).values({ withdrawalFeePercent: "1.00" });
  log("  ✓ platform settings (withdrawal fee = 1%)");
}

// ─── 4. Sample Polls ─────────────────────────────────────────────────────────

async function seedPolls(adminId: number, userIds: number[]) {
  const now = new Date();
  const inOneMonth = new Date(now.getTime() + 30 * 24 * 60 * 60 * 1000);
  const inTwoMonths = new Date(now.getTime() + 60 * 24 * 60 * 60 * 1000);

  const samplePolls = [
    {
      title: "Apakah Bitcoin akan melebihi $150.000 sebelum akhir 2026?",
      description: "Market ini resolve YES jika harga BTC/USD di Coinbase melampaui $150.000 sebelum 31 Desember 2026.",
      category: "crypto",
      options: ["Ya", "Tidak"],
      endAt: inTwoMonths,
      platformFeePercent: "30",
    },
    {
      title: "Siapa yang akan memenangkan Pilpres AS 2028?",
      description: "Prediksi pemenang pemilihan presiden Amerika Serikat tahun 2028.",
      category: "politics",
      options: ["Demokrat", "Republik", "Independen"],
      endAt: inTwoMonths,
      platformFeePercent: "30",
    },
    {
      title: "Apakah Fed akan memangkas suku bunga di pertemuan Juni 2026?",
      description: "Market ini memprediksi keputusan Federal Reserve.",
      category: "economy",
      options: ["Pangkas", "Tahan", "Naikan"],
      endAt: inOneMonth,
      platformFeePercent: "30",
    },
  ];

  for (const p of samplePolls) {
    const existing = await db.select({ id: polls.id }).from(polls).where(eq(polls.title, p.title));
    let pollId: number;

    if (existing.length > 0 && existing[0]) {
      log(`  skip poll "${p.title.slice(0, 40)}..." (sudah ada)`);
      pollId = existing[0].id;
    } else {
      const [row] = await db.insert(polls).values({
        title: p.title,
        description: p.description,
        category: p.category,
        options: p.options,
        status: "active",
        creatorId: adminId,
        aiGenerated: false,
        startAt: now,
        endAt: p.endAt,
        livesPerVote: 1,
        platformFeePercent: p.platformFeePercent,
        totalVolume: "0",
        totalVotes: 0,
      }).returning({ id: polls.id });
      pollId = row!.id;
      log(`  ✓ poll "${p.title.slice(0, 50)}..." (id=${pollId})`);
    }

    // ─── 5. Seed Votes (Taruhan Awal) ───────────────────────────────────
    for (const userId of userIds) {
      const randomOption = Math.floor(Math.random() * p.options.length);
      const randomWager = Math.floor(Math.random() * 5) + 1; // 1-5 nyawa

      const [existingVote] = await db.select().from(pollVotes).where(and(eq(pollVotes.pollId, pollId), eq(pollVotes.userId, userId)));
      if (existingVote) continue;

      await db.insert(pollVotes).values({
        pollId,
        userId,
        optionIndex: randomOption,
        livesWagered: String(randomWager),
      });

      // Update total volume
      await db.update(polls)
        .set({
          totalVotes: sql`${polls.totalVotes} + 1`,
          totalVolume: sql`${polls.totalVolume} + ${randomWager}`
        })
        .where(eq(polls.id, pollId));

      log(`    -> User #${userId} pasang ${randomWager} nyawa di "${p.options[randomOption]}"`);
    }
  }
}

// ─── Main ────────────────────────────────────────────────────────────────────

async function main() {
  console.log("\n🌱 Starting seed (Decimal & Pool Concept)...\n");

  log("Users:");
  const createdUsers = await seedUsers();

  log("\nLife Packages:");
  await seedPackages();

  log("\nPlatform Settings:");
  await seedSettings();

  const adminId = createdUsers["admin"]!;
  const userIds = [createdUsers["demo_alice"]!, createdUsers["demo_bob"]!, createdUsers["demo_carol"]!];

  log("\nPolls & Initial Votes:");
  await seedPolls(adminId, userIds);

  console.log("\n✅ Seed selesai!\n");
  await client.end();
}

import { sql, and } from "drizzle-orm";
main().catch((err) => {
  console.error("Seed error:", err);
  process.exit(1);
});
