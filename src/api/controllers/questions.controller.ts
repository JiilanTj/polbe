import type { Context } from "hono";
import { db } from "../../db";
import { articles, generatedQuestions } from "../../db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { generateQuestions } from "../../ai/question-generator";
import { config } from "../../config";

const VALID_MARKET_TYPES = ["binary", "categorical", "scalar"] as const;
const VALID_STATUSES = ["draft", "pending", "active", "resolved", "closed"] as const;

type MarketType = (typeof VALID_MARKET_TYPES)[number];
type QuestionStatus = (typeof VALID_STATUSES)[number];

function toSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 200) +
    "-" +
    Date.now()
  );
}

export const questionsController = {
  async list(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const status = c.req.query("status");
    const category = c.req.query("category");
    const marketType = c.req.query("marketType");
    const offset = (page - 1) * limit;

    let query = db
      .select()
      .from(generatedQuestions)
      .orderBy(desc(generatedQuestions.createdAt))
      .limit(limit)
      .offset(offset);

    if (status) {
      query = query.where(eq(generatedQuestions.status, status as QuestionStatus)) as typeof query;
    }
    if (category) {
      query = query.where(eq(generatedQuestions.category, category)) as typeof query;
    }
    if (marketType) {
      query = query.where(eq(generatedQuestions.marketType, marketType as MarketType)) as typeof query;
    }

    const result = await query;
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(generatedQuestions);
    const total = Number(countResult?.count ?? 0);

    return c.json({
      data: result,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },

  async getById(c: Context) {
    const id = Number(c.req.param("id"));
    const [question] = await db.select().from(generatedQuestions).where(eq(generatedQuestions.id, id));

    if (!question) return c.json({ error: "Question not found" }, 404);
    return c.json({ data: question });
  },

  async create(c: Context) {
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Request body tidak valid (harus JSON)" }, 400);

    const {
      question,
      description,
      category,
      tags,
      imageUrl,
      marketType = "binary",
      outcomes,
      initialLiquidity,
      minTradeSize,
      startDate,
      resolutionDate,
      resolutionSource,
      resolutionCriteria,
      sourceArticleIds,
      status = "draft",
    } = body as Record<string, any>;

    // ─── Validation ──────────────────────────────────────────────
    if (!question?.trim()) {
      return c.json({ error: "Field 'question' wajib diisi" }, 422);
    }
    if (!resolutionDate) {
      return c.json({ error: "Field 'resolutionDate' wajib diisi (ISO 8601)" }, 422);
    }
    if (!VALID_MARKET_TYPES.includes(marketType)) {
      return c.json({ error: `marketType harus salah satu: ${VALID_MARKET_TYPES.join(", ")}` }, 422);
    }
    if (!VALID_STATUSES.includes(status)) {
      return c.json({ error: `status harus salah satu: ${VALID_STATUSES.join(", ")}` }, 422);
    }
    if (startDate && resolutionDate && new Date(startDate) >= new Date(resolutionDate)) {
      return c.json({ error: "startDate harus sebelum resolutionDate" }, 422);
    }

    // ─── Outcomes default ────────────────────────────────────────
    const resolvedOutcomes: string[] | null =
      outcomes ?? (marketType === "binary" ? ["Yes", "No"] : null);

    if (marketType !== "scalar" && (!resolvedOutcomes || resolvedOutcomes.length < 2)) {
      return c.json({ error: "Minimal 2 outcomes diperlukan untuk market binary/categorical" }, 422);
    }

    // ─── Liquidity guard ─────────────────────────────────────────
    if (initialLiquidity !== undefined && Number(initialLiquidity) < 0) {
      return c.json({ error: "initialLiquidity tidak boleh negatif" }, 422);
    }
    if (minTradeSize !== undefined && Number(minTradeSize) <= 0) {
      return c.json({ error: "minTradeSize harus lebih besar dari 0" }, 422);
    }

    const slug = toSlug(question.trim());

    const [created] = await db
      .insert(generatedQuestions)
      .values({
        question: question.trim(),
        slug,
        description: description ?? null,
        category: category ?? null,
        tags: Array.isArray(tags) ? tags : null,
        imageUrl: imageUrl ?? null,
        marketType: marketType as MarketType,
        outcomes: resolvedOutcomes,
        initialLiquidity: initialLiquidity != null ? String(initialLiquidity) : null,
        minTradeSize: minTradeSize != null ? String(minTradeSize) : null,
        startDate: startDate ? new Date(startDate) : null,
        resolutionDate: new Date(resolutionDate),
        resolutionSource: resolutionSource ?? null,
        resolutionCriteria: resolutionCriteria ?? null,
        sourceArticleIds: Array.isArray(sourceArticleIds) ? sourceArticleIds : null,
        status: status as QuestionStatus,
      })
      .returning();

    return c.json({ data: created }, 201);
  },

  async generate(c: Context) {
    const recentArticles = await db
      .select({ title: articles.title, description: articles.description })
      .from(articles)
      .orderBy(desc(articles.scrapedAt))
      .limit(30);

    const titles = recentArticles.map((a) => a.title);
    const descriptions = recentArticles.map((a) => a.description || "");

    const questions = await generateQuestions(titles, descriptions);

    for (const q of questions) {
      await db.insert(generatedQuestions).values({
        question: q.question,
        slug: toSlug(q.question),
        description: q.description,
        category: q.category,
        resolutionDate: new Date(q.resolutionDate),
        aiModel: config.openai.model,
        confidenceScore: String(q.confidenceScore),
        status: "draft",
        marketType: "binary",
        outcomes: ["Yes", "No"],
      });
    }

    return c.json({ message: `Generated ${questions.length} questions`, data: questions });
  },
};
