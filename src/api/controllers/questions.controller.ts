import type { Context } from "hono";
import { db } from "../../db";
import { articles, generatedQuestions } from "../../db/schema";
import { desc, eq, sql } from "drizzle-orm";
import { generateQuestions } from "../../ai/question-generator";
import { config } from "../../config";

export const questionsController = {
  async list(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const status = c.req.query("status");
    const offset = (page - 1) * limit;

    let query = db
      .select()
      .from(generatedQuestions)
      .orderBy(desc(generatedQuestions.createdAt))
      .limit(limit)
      .offset(offset);

    if (status) {
      query = query.where(eq(generatedQuestions.status, status)) as typeof query;
    }

    const result = await query;
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(generatedQuestions);
    const total = Number(countResult?.count ?? 0);

    return c.json({
      data: result,
      pagination: {
        page,
        limit,
        total,
        totalPages: Math.ceil(total / limit),
      },
    });
  },

  async getById(c: Context) {
    const id = Number(c.req.param("id"));
    const [question] = await db.select().from(generatedQuestions).where(eq(generatedQuestions.id, id));

    if (!question) return c.json({ error: "Question not found" }, 404);
    return c.json({ data: question });
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
        description: q.description,
        category: q.category,
        resolutionDate: new Date(q.resolutionDate),
        aiModel: config.openai.model,
        confidenceScore: String(q.confidenceScore),
        status: "draft",
      });
    }

    return c.json({ message: `Generated ${questions.length} questions`, data: questions });
  },
};
