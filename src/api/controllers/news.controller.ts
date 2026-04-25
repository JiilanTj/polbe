import type { Context } from "hono";
import { db } from "../../db";
import { articles } from "../../db/schema";
import { desc, eq, like, sql } from "drizzle-orm";
import { scrapeArticleContent } from "../../scrapers/content";

export const newsController = {
  async list(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const category = c.req.query("category");
    const source = c.req.query("source");
    const offset = (page - 1) * limit;

    let query = db.select().from(articles).orderBy(desc(articles.scrapedAt)).limit(limit).offset(offset);

    if (category) {
      query = query.where(eq(articles.category, category)) as typeof query;
    }
    if (source) {
      query = query.where(like(articles.source, `%${source}%`)) as typeof query;
    }

    const result = await query;
    const [countResult] = await db.select({ count: sql<number>`count(*)` }).from(articles);
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
    const [article] = await db.select().from(articles).where(eq(articles.id, id));

    if (!article) return c.json({ error: "Article not found" }, 404);

    // Auto-enrich: if content is missing, truncated, or too short — scrape on-demand
    const needsEnrich = !article.content 
      || (article.content.includes("[+") && article.content.includes("chars]"))
      || article.content.length < 300;

    if (needsEnrich) {
      const enriched = await scrapeArticleContent(article.url);
      const content = enriched?.content;
      if (content && content.length > (article.content?.length ?? 0)) {
        await db.update(articles).set({
          content,
          imageUrl: enriched.imageUrl ?? article.imageUrl,
        }).where(eq(articles.id, id));
        article.content = content;
        article.imageUrl = enriched.imageUrl ?? article.imageUrl;
      }
    }

    return c.json({ data: article });
  },
};
