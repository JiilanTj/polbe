import Parser from "rss-parser";
import { db } from "../db";
import { articles } from "../db/schema";
import { config } from "../config";

const parser = new Parser({
  timeout: 10000,
  headers: {
    "User-Agent": "PolymarketBot/1.0",
  },
});

export interface ScrapedArticle {
  title: string;
  description: string | null;
  content: string | null;
  url: string;
  source: string;
  publishedAt: Date | null;
}

export async function scrapeRssFeeds(): Promise<ScrapedArticle[]> {
  const allArticles: ScrapedArticle[] = [];

  for (const feed of config.rssFeeds) {
    try {
      console.log(`[RSS] Scraping ${feed.name}...`);
      const result = await parser.parseURL(feed.url);

      for (const item of result.items) {
        if (!item.title || !item.link) continue;

        allArticles.push({
          title: item.title,
          description: item.contentSnippet || item.content || null,
          content: item.content || null,
          url: item.link,
          source: feed.name,
          publishedAt: item.pubDate ? new Date(item.pubDate) : null,
        });
      }

      console.log(`[RSS] Got ${result.items.length} articles from ${feed.name}`);
    } catch (error) {
      console.error(`[RSS] Error scraping ${feed.name}:`, error);
    }
  }

  return allArticles;
}

export async function saveArticles(scrapedArticles: ScrapedArticle[]): Promise<number> {
  let saved = 0;

  for (const article of scrapedArticles) {
    try {
      await db
        .insert(articles)
        .values({
          title: article.title,
          description: article.description,
          content: article.content,
          url: article.url,
          source: article.source,
          publishedAt: article.publishedAt,
        })
        .onConflictDoNothing({ target: articles.url });
      saved++;
    } catch (error) {
      // Skip duplicates silently
    }
  }

  return saved;
}
