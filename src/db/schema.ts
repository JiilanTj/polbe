import { pgTable, serial, text, varchar, timestamp, decimal, integer, pgEnum, boolean, uniqueIndex, type AnyPgColumn } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("user_role", ["user", "admin", "platform"]);
export const topupStatusEnum = pgEnum("topup_status", ["pending", "approved", "rejected"]);
export const withdrawalStatusEnum = pgEnum("withdrawal_status", ["pending", "approved", "rejected"]);
export const pollStatusEnum = pgEnum("poll_status", ["draft", "active", "resolved", "closed"]);
export const livesTransactionTypeEnum = pgEnum("lives_transaction_type", [
  "purchase", "vote_debit", "vote_payout", "recovery", "referral_bonus", "admin_credit", "admin_debit",
]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").default("user").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  avatarUrl: text("avatar_url"),
  emailVerifiedAt: timestamp("email_verified_at"),
  // ─── USDT Balance ──────────────────────────────────────
  usdtBalance: decimal("usdt_balance", { precision: 10, scale: 2 }).default("0").notNull(),
  // ─── Lives ────────────────────────────────────────────
  livesBalance: integer("lives_balance").default(5).notNull(),
  livesRecoveryAt: timestamp("lives_recovery_at").defaultNow().notNull(),
  // ─── Referral ─────────────────────────────────────────
  referralCode: varchar("referral_code", { length: 20 }).unique(),
  referredBy: integer("referred_by").references((): AnyPgColumn => users.id),
  // ─── Timestamps ───────────────────────────────────────
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

export const articles = pgTable("articles", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  content: text("content"),
  url: text("url").notNull().unique(),
  source: varchar("source", { length: 100 }).notNull(),
  category: varchar("category", { length: 50 }),
  publishedAt: timestamp("published_at"),
  scrapedAt: timestamp("scraped_at").defaultNow().notNull(),
  sentiment: varchar("sentiment", { length: 20 }),
  sentimentScore: decimal("sentiment_score"),
});

export const trends = pgTable("trends", {
  id: serial("id").primaryKey(),
  topic: varchar("topic", { length: 200 }).notNull(),
  mentionCount: integer("mention_count").default(1).notNull(),
  category: varchar("category", { length: 50 }),
  firstSeen: timestamp("first_seen").defaultNow().notNull(),
  lastSeen: timestamp("last_seen").defaultNow().notNull(),
  trendScore: decimal("trend_score").default("0"),
});

export const marketTypeEnum = pgEnum("market_type", ["binary", "categorical", "scalar"]);
export const questionStatusEnum = pgEnum("question_status", ["draft", "pending", "active", "resolved", "closed"]);

export const generatedQuestions = pgTable("generated_questions", {
  id: serial("id").primaryKey(),

  // ─── Core ────────────────────────────────────────────────────────
  question: text("question").notNull(),
  slug: varchar("slug", { length: 300 }).unique(),
  description: text("description"),
  category: varchar("category", { length: 100 }),
  tags: text("tags").array(),
  imageUrl: text("image_url"),

  // ─── Market Mechanics ────────────────────────────────────────────
  marketType: marketTypeEnum("market_type").default("binary").notNull(),
  outcomes: text("outcomes").array(),           // ["Yes","No"] for binary; custom for categorical
  initialLiquidity: decimal("initial_liquidity"),
  minTradeSize: decimal("min_trade_size"),
  volume: decimal("volume").default("0").notNull(),

  // ─── Resolution ──────────────────────────────────────────────────
  startDate: timestamp("start_date"),
  resolutionDate: timestamp("resolution_date"),
  resolutionSource: text("resolution_source"), // URL/source used to resolve
  resolutionCriteria: text("resolution_criteria"), // explicit YES/NO criteria
  resolvedOutcome: text("resolved_outcome"),   // filled when status = resolved

  // ─── Status & Ownership ──────────────────────────────────────────
  status: questionStatusEnum("status").default("draft").notNull(),
  createdBy: integer("created_by").references(() => users.id),

  // ─── AI Metadata (null for manually created) ─────────────────────
  sourceArticleIds: integer("source_article_ids").array(),
  aiModel: varchar("ai_model", { length: 50 }),
  confidenceScore: decimal("confidence_score"),

  // ─── Timestamps ───────────────────────────────────────────────────
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Life Packages ─────────────────────────────────────────────────────────
// Paket pembelian nyawa (1 USDT = 1 nyawa, 5 USDT = 6 nyawa, dst)
export const lifePackages = pgTable("life_packages", {
  id: serial("id").primaryKey(),
  label: varchar("label", { length: 100 }).notNull(),       // "Starter", "Value", dst
  usdtPrice: decimal("usdt_price", { precision: 10, scale: 2 }).notNull(),
  livesAmount: integer("lives_amount").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
  sortOrder: integer("sort_order").default(0).notNull(),
});

// ─── Topup Requests ────────────────────────────────────────────────────────
// User kirim bukti pembayaran → admin approve → nyawa masuk
export const topupRequests = pgTable("topup_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  packageId: integer("package_id").references(() => lifePackages.id),
  usdtAmount: decimal("usdt_amount", { precision: 10, scale: 2 }).notNull(),
  livesAmount: integer("lives_amount").notNull(),
  proofImageUrl: text("proof_image_url"),         // URL gambar bukti transfer
  walletAddress: varchar("wallet_address", { length: 100 }), // alamat USDT platform
  status: topupStatusEnum("status").default("pending").notNull(),
  adminNote: text("admin_note"),
  approvedBy: integer("approved_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
});

// ─── Withdrawal Requests ───────────────────────────────────────────────────
// User minta tarik saldo → admin approve → transfer manual
export const withdrawalRequests = pgTable("withdrawal_requests", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  usdtAmount: decimal("usdt_amount", { precision: 10, scale: 2 }).notNull(),
  walletAddress: varchar("wallet_address", { length: 100 }).notNull(), // alamat tujuan user
  txHash: varchar("tx_hash", { length: 150 }),    // diisi admin saat approve
  status: withdrawalStatusEnum("status").default("pending").notNull(),
  adminNote: text("admin_note"),
  approvedBy: integer("approved_by").references(() => users.id),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  processedAt: timestamp("processed_at"),
});

// ─── Polls ─────────────────────────────────────────────────────────────────
// Market prediksi multi-opsi tempat user memilih dengan nyawa
export const polls = pgTable("polls", {
  id: serial("id").primaryKey(),
  title: text("title").notNull(),
  description: text("description"),
  category: varchar("category", { length: 100 }),
  options: text("options").array().notNull(),           // ["Opsi A", "Opsi B", "Opsi C"]
  imageUrl: text("image_url"),
  status: pollStatusEnum("status").default("draft").notNull(),
  creatorId: integer("creator_id").references(() => users.id),
  aiGenerated: boolean("ai_generated").default(false).notNull(),
  sourceArticleIds: integer("source_article_ids").array(),
  // ─── Resolusi ──────────────────────────────────────────
  winnerOptionIndex: integer("winner_option_index"),   // index opsi yang menang
  resolvedAt: timestamp("resolved_at"),
  resolvedBy: integer("resolved_by").references(() => users.id),
  // ─── Timing ────────────────────────────────────────────
  startAt: timestamp("start_at"),
  endAt: timestamp("end_at"),
  // ─── Mekanik ───────────────────────────────────────────
  livesPerVote: integer("lives_per_vote").default(1).notNull(),
  platformFeePercent: decimal("platform_fee_percent", { precision: 5, scale: 2 }).default("30").notNull(),
  // ─── Stats ─────────────────────────────────────────────
  totalVotes: integer("total_votes").default(0).notNull(),
  // ─── Timestamps ────────────────────────────────────────
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
});

// ─── Poll Votes ────────────────────────────────────────────────────────────
// Setiap user hanya bisa vote 1x per poll
export const pollVotes = pgTable("poll_votes", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").references(() => polls.id).notNull(),
  userId: integer("user_id").references(() => users.id).notNull(),
  optionIndex: integer("option_index").notNull(),       // index opsi yang dipilih
  livesWagered: integer("lives_wagered").default(1).notNull(),
  payoutLives: decimal("payout_lives"),                 // diisi saat resolusi
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  uniqueUserPoll: uniqueIndex("unique_user_poll_vote").on(t.userId, t.pollId),
}));

// ─── Lives Transactions ────────────────────────────────────────────────────
// Audit log semua perubahan nyawa
export const livesTransactions = pgTable("lives_transactions", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").references(() => users.id).notNull(),
  amount: integer("amount").notNull(),                  // positif = kredit, negatif = debit
  type: livesTransactionTypeEnum("type").notNull(),
  refId: integer("ref_id"),                             // topup_request_id / poll_vote_id / dll
  refType: varchar("ref_type", { length: 50 }),
  note: text("note"),
  balanceAfter: integer("balance_after").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
});

// ─── Referral Earnings ─────────────────────────────────────────────────────
// Track komisi referral (0.05 USDT per topup downline)
export const referralEarnings = pgTable("referral_earnings", {
  id: serial("id").primaryKey(),
  referrerId: integer("referrer_id").references(() => users.id).notNull(),
  refereeId: integer("referee_id").references(() => users.id).notNull(),
  topupRequestId: integer("topup_request_id").references(() => topupRequests.id).notNull(),
  usdtEarned: decimal("usdt_earned", { precision: 10, scale: 2 }).notNull(),
  livesEarned: integer("lives_earned").notNull(),       // floor(usdtEarned) lives credited
  createdAt: timestamp("created_at").defaultNow().notNull(),
});
