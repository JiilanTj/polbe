import { pgTable, serial, text, varchar, timestamp, decimal, integer, pgEnum, boolean, uniqueIndex, index, jsonb, type AnyPgColumn } from "drizzle-orm/pg-core";

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
  livesBalance: decimal("lives_balance", { precision: 18, scale: 6 }).default("0").notNull(),
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
  imageUrl: text("image_url"),
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
  usdtAmount: decimal("usdt_amount", { precision: 10, scale: 2 }).notNull(),  // gross amount
  feePercent: decimal("fee_percent", { precision: 5, scale: 2 }).default("0").notNull(), // % fee saat create
  feeAmount: decimal("fee_amount", { precision: 10, scale: 2 }).default("0").notNull(),  // fee dalam USDT
  netAmount: decimal("net_amount", { precision: 10, scale: 2 }).notNull(),              // yang diterima user
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
  // ─── CLOB Prize Pool ────────────────────────────────────
  prizePool: integer("prize_pool").default(0).notNull(),
  lastPrices: jsonb("last_prices"),                      // { "0": "0.5000", "1": "0.5000" }
  // ─── Stats ─────────────────────────────────────────────
  totalVotes: integer("total_votes").default(0).notNull(),
  totalVolume: integer("total_volume").default(0).notNull(), // total lives traded (semua trades)
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
  livesWagered: decimal("lives_wagered", { precision: 18, scale: 6 }).default("0").notNull(),
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
  amount: decimal("amount", { precision: 18, scale: 6 }).notNull(),                  // positif = kredit, negatif = debit
  type: livesTransactionTypeEnum("type").notNull(),
  refId: integer("ref_id"),                             // topup_request_id / poll_vote_id / dll
  refType: varchar("ref_type", { length: 50 }),
  note: text("note"),
  balanceAfter: decimal("balance_after", { precision: 18, scale: 6 }).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // Riwayat per user diurutkan waktu
  idxUserCreatedAt: index("lives_tx_user_created_at").on(t.userId, t.createdAt),
}));

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

// ─── CLOB: Orders ─────────────────────────────────────────────────────────
// Order book — setiap entry adalah limit order BUY atau SELL shares
export const orderSideEnum = pgEnum("order_side", ["buy", "sell"]);
export const orderStatusEnum = pgEnum("order_status", ["open", "partial", "filled", "cancelled"]);

export const orders = pgTable("orders", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id),
  optionIndex: integer("option_index").notNull(),
  side: orderSideEnum("side").notNull(),
  // Harga 0.0001–0.9999 mewakili probabilitas (0.60 = 60%)
  price: decimal("price", { precision: 6, scale: 4 }).notNull(),
  size: integer("size").notNull(),                      // jumlah shares yang diminta
  filledSize: integer("filled_size").default(0).notNull(),
  status: orderStatusEnum("status").default("open").notNull(),
  livesPaidIn: integer("lives_paid_in").default(0).notNull(), // lives dibayar ke pool (BUY only)
  expiresAt: timestamp("expires_at"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  // Matching engine: cari counterpart orders untuk poll+option tertentu
  idxPollOptionStatus: index("orders_poll_option_status").on(t.pollId, t.optionIndex, t.status),
  // User history
  idxUserId: index("orders_user_id").on(t.userId),
}));

// ─── CLOB: Trades ─────────────────────────────────────────────────────────
// Setiap trade adalah matching antara 1 BUY order dan 1 SELL order
export const trades = pgTable("trades", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id),
  optionIndex: integer("option_index").notNull(),
  makerOrderId: integer("maker_order_id").notNull().references(() => orders.id),
  takerOrderId: integer("taker_order_id").notNull().references(() => orders.id),
  makerUserId: integer("maker_user_id").notNull().references(() => users.id),
  takerUserId: integer("taker_user_id").notNull().references(() => users.id),
  side: orderSideEnum("side").notNull(),                // taker's perspective
  price: decimal("price", { precision: 6, scale: 4 }).notNull(),
  size: integer("size").notNull(),                      // shares traded
  livesTransferred: integer("lives_transferred").notNull(), // lives dibayar ke seller
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  // Activity feed per poll (recent trades)
  idxPollCreatedAt: index("trades_poll_created_at").on(t.pollId, t.createdAt),
  // User trade history
  idxMaker: index("trades_maker_user_id").on(t.makerUserId),
  idxTaker: index("trades_taker_user_id").on(t.takerUserId),
}));

// ─── CLOB: Positions ──────────────────────────────────────────────────────
// Posisi agregat user per (pollId, optionIndex)
export const positions = pgTable("positions", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id),
  userId: integer("user_id").notNull().references(() => users.id),
  optionIndex: integer("option_index").notNull(),
  shares: integer("shares").default(0).notNull(),       // net shares dipegang
  avgEntryPrice: decimal("avg_entry_price", { precision: 6, scale: 4 }).default("0.5000").notNull(),
  totalLivesIn: integer("total_lives_in").default(0).notNull(), // total biaya masuk
  realizedPnl: integer("realized_pnl").default(0).notNull(),   // P&L dari posisi yang sudah ditutup
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
}, (t) => ({
  uniquePos: uniqueIndex("positions_user_poll_option").on(t.userId, t.pollId, t.optionIndex),
}));

// ─── CLOB: Price Snapshots ────────────────────────────────────────────────
// Historis harga per opsi per poll — direkam setiap trade
export const priceSnapshots = pgTable("price_snapshots", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id),
  optionIndex: integer("option_index").notNull(),
  price: decimal("price", { precision: 6, scale: 4 }).notNull(),
  snapshotAt: timestamp("snapshot_at").defaultNow().notNull(),
}, (t) => ({
  // Chart query: ambil history per poll+option diurutkan waktu
  idxPollOptionTime: index("price_snapshots_poll_option_time").on(t.pollId, t.optionIndex, t.snapshotAt),
}));

// ─── Poll Comments ─────────────────────────────────────────────────────────
export const pollComments = pgTable("poll_comments", {
  id: serial("id").primaryKey(),
  pollId: integer("poll_id").notNull().references(() => polls.id, { onDelete: "cascade" }),
  userId: integer("user_id").notNull().references(() => users.id),
  body: text("body").notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  deletedAt: timestamp("deleted_at"),
});

// ─── Watchlist ─────────────────────────────────────────────────────────────
// User mem-bookmark poll yang ingin dipantau
export const watchlist = pgTable("watchlist", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  pollId: integer("poll_id").notNull().references(() => polls.id, { onDelete: "cascade" }),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  unique: uniqueIndex("watchlist_user_poll").on(t.userId, t.pollId),
}));

// ─── Notifications ─────────────────────────────────────────────────────────
// In-app notification untuk user (order fill, payout, dll)
export const notificationTypeEnum = pgEnum("notification_type", [
  "order_filled",      // order terisi (sebagian atau penuh)
  "order_cancelled",   // order dibatalkan sistem
  "poll_resolved",     // market telah di-resolve, cek payout
  "payout_credited",   // lives/USDT dikreditkan ke akun
  "trade_executed",    // ada trade yang melibatkan user
  "watchlist_update",  // poll di watchlist berubah status
]);

export const notifications = pgTable("notifications", {
  id: serial("id").primaryKey(),
  userId: integer("user_id").notNull().references(() => users.id, { onDelete: "cascade" }),
  type: notificationTypeEnum("type").notNull(),
  title: varchar("title", { length: 200 }).notNull(),
  body: text("body").notNull(),
  refId: integer("ref_id"),                             // orderId / pollId / tradeId
  refType: varchar("ref_type", { length: 50 }),         // "order" | "poll" | "trade"
  isRead: boolean("is_read").default(false).notNull(),
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  idxUserId: index("notifications_user_id").on(t.userId),
  idxUserUnread: index("notifications_user_unread").on(t.userId, t.isRead),
}));

// ─── Indexes untuk performance ─────────────────────────────────────────────
// Indexes didefinisikan inline di masing-masing tabel melalui table config.
// Migration SQL akan di-generate oleh drizzle-kit generate.

// ─── Platform Settings ────────────────────────────────────────────────────
// Singleton row (id=1) untuk konfigurasi global platform
export const platformSettings = pgTable("platform_settings", {
  id: serial("id").primaryKey(),
  withdrawalFeePercent: decimal("withdrawal_fee_percent", { precision: 5, scale: 2 }).default("1").notNull(), // default 1%
  updatedAt: timestamp("updated_at").defaultNow().notNull(),
  updatedBy: integer("updated_by").references(() => users.id),
});

// ─── Admin Audit Logs ──────────────────────────────────────────────────────
// Rekam semua aksi admin untuk keperluan governance dan keamanan
export const adminAuditLogs = pgTable("admin_audit_logs", {
  id: serial("id").primaryKey(),
  adminId: integer("admin_id").notNull().references(() => users.id),
  action: varchar("action", { length: 100 }).notNull(), // "credit_lives" | "approve_topup" | dll
  targetUserId: integer("target_user_id").references(() => users.id),
  targetResourceId: integer("target_resource_id"),       // pollId / topupId / dll
  targetResourceType: varchar("target_resource_type", { length: 50 }), // "poll" | "topup" | dll
  metadata: jsonb("metadata"),                           // detail aksi dalam JSON
  ipAddress: varchar("ip_address", { length: 45 }),      // IPv4/IPv6
  createdAt: timestamp("created_at").defaultNow().notNull(),
}, (t) => ({
  idxAdminId: index("audit_logs_admin_id").on(t.adminId),
  idxCreatedAt: index("audit_logs_created_at").on(t.createdAt),
}));
