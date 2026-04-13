import type { Context } from "hono";
import { db } from "../../db";
import { trends, articles } from "../../db/schema";
import { desc, eq, like } from "drizzle-orm";

export const trendsController = {
  async list(c: Context) {
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);

    const result = await db
      .select()
      .from(trends)
      .orderBy(desc(trends.trendScore))
      .limit(limit);

    return c.json({ data: result });
  },

  async getByTopic(c: Context) {
    const topic = c.req.param("topic");
    if (!topic) return c.json({ error: "Topic parameter is required" }, 400);

    const [trend] = await db.select().from(trends).where(eq(trends.topic, topic));

    if (!trend) return c.json({ error: "Trend not found" }, 404);

    const relatedArticles = await db
      .select()
      .from(articles)
      .where(like(articles.title, `%${topic}%`))
      .orderBy(desc(articles.scrapedAt))
      .limit(20);

    return c.json({ data: { ...trend, relatedArticles } });
  },
};
