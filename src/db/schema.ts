import { pgTable, serial, text, varchar, timestamp, decimal, integer, pgEnum, boolean } from "drizzle-orm/pg-core";

export const roleEnum = pgEnum("user_role", ["user", "admin", "platform"]);

export const users = pgTable("users", {
  id: serial("id").primaryKey(),
  email: varchar("email", { length: 255 }).notNull().unique(),
  username: varchar("username", { length: 100 }).notNull().unique(),
  passwordHash: text("password_hash").notNull(),
  role: roleEnum("role").default("user").notNull(),
  isActive: boolean("is_active").default(true).notNull(),
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
