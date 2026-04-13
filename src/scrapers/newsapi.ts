import { db } from "../db";
import { articles } from "../db/schema";
import { config } from "../config";
import type { ScrapedArticle } from "./rss";

interface NewsApiArticle {
  title: string;
  description: string | null;
  content: string | null;
  url: string;
  source: { id: string | null; name: string };
  publishedAt: string;
}

interface NewsApiResponse {
  status: string;
  totalResults: number;
  articles: NewsApiArticle[];
}

export async function scrapeNewsApi(query?: string): Promise<ScrapedArticle[]> {
  if (!config.newsapi.key) {
    console.warn("[NewsAPI] No API key configured, skipping");
    return [];
  }

  const allArticles: ScrapedArticle[] = [];

  try {
    // Top headlines
    const headlinesUrl = new URL(`${config.newsapi.baseUrl}/top-headlines`);
    headlinesUrl.searchParams.set("language", "en");
    headlinesUrl.searchParams.set("pageSize", "50");
    if (query) {
      headlinesUrl.searchParams.set("q", query);
    } else {
      headlinesUrl.searchParams.set("country", "us");
    }

    console.log("[NewsAPI] Fetching top headlines...");
    const response = await fetch(headlinesUrl.toString(), {
      headers: { "X-Api-Key": config.newsapi.key },
    });

    if (!response.ok) {
      console.error(`[NewsAPI] HTTP ${response.status}: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as NewsApiResponse;

    for (const item of data.articles) {
      if (!item.title || !item.url || item.title === "[Removed]") continue;

      allArticles.push({
        title: item.title,
        description: item.description,
        content: item.content,
        url: item.url,
        source: `newsapi:${item.source.name}`,
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      });
    }

    console.log(`[NewsAPI] Got ${allArticles.length} articles`);
  } catch (error) {
    console.error("[NewsAPI] Error:", error);
  }

  return allArticles;
}

export async function scrapeNewsApiEverything(query: string): Promise<ScrapedArticle[]> {
  if (!config.newsapi.key) {
    console.warn("[NewsAPI] No API key configured, skipping");
    return [];
  }

  const allArticles: ScrapedArticle[] = [];

  try {
    const url = new URL(`${config.newsapi.baseUrl}/everything`);
    url.searchParams.set("q", query);
    url.searchParams.set("language", "en");
    url.searchParams.set("sortBy", "publishedAt");
    url.searchParams.set("pageSize", "50");

    console.log(`[NewsAPI] Searching for "${query}"...`);
    const response = await fetch(url.toString(), {
      headers: { "X-Api-Key": config.newsapi.key },
    });

    if (!response.ok) {
      console.error(`[NewsAPI] HTTP ${response.status}: ${response.statusText}`);
      return [];
    }

    const data = (await response.json()) as NewsApiResponse;

    for (const item of data.articles) {
      if (!item.title || !item.url || item.title === "[Removed]") continue;

      allArticles.push({
        title: item.title,
        description: item.description,
        content: item.content,
        url: item.url,
        source: `newsapi:${item.source.name}`,
        publishedAt: item.publishedAt ? new Date(item.publishedAt) : null,
      });
    }

    console.log(`[NewsAPI] Got ${allArticles.length} articles for "${query}"`);
  } catch (error) {
    console.error("[NewsAPI] Error:", error);
  }

  return allArticles;
}
