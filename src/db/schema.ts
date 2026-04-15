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

export const generatedQuestions = pgTable("generated_questions", {
  id: serial("id").primaryKey(),
  question: text("question").notNull(),
  description: text("description"),
  category: varchar("category", { length: 50 }),
  sourceArticleIds: integer("source_article_ids").array(),
  resolutionDate: timestamp("resolution_date"),
  createdAt: timestamp("created_at").defaultNow().notNull(),
  aiModel: varchar("ai_model", { length: 50 }),
  confidenceScore: decimal("confidence_score"),
  status: varchar("status", { length: 20 }).default("draft").notNull(),
});
