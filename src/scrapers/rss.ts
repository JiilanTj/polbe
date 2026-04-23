import Parser from "rss-parser";
import { db } from "../db";
import { articles } from "../db/schema";
import { config } from "../config";

const parser = new Parser({
  timeout: 15000,
  headers: {
    "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
  },
});

export interface ScrapedArticle {
  title: string;
  description: string | null;
  content: string | null;
  url: string;
  imageUrl: string | null;
  source: string;
  publishedAt: Date | null;
}

/**
 * Strip HTML tags and clean up text
 */
function stripHtml(html: string | null | undefined): string | null {
  if (!html) return null;
  return html
    .replace(/<[^>]*>/g, "")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'")
    .replace(/\s+/g, " ")
    .trim() || null;
}

/**
 * Resolve Google News redirect URL to the real article URL.
 */
async function resolveGoogleNewsUrl(url: string): Promise<string> {
  if (!url.includes("news.google.com")) return url;

  try {
    const res = await fetch(url, {
      redirect: "follow",
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      },
      signal: AbortSignal.timeout(8000),
    });
    // The final URL after redirects is the real article URL
    return res.url || url;
  } catch {
    return url;
  }
}

export async function scrapeRssFeeds(): Promise<ScrapedArticle[]> {
  const allArticles: ScrapedArticle[] = [];

  for (const feed of config.rssFeeds) {
    try {
      console.log(`[RSS] Scraping ${feed.name}...`);
      const result = await parser.parseURL(feed.url);
      const isGoogleNews = feed.name.startsWith("Google News");

      for (const item of result.items) {
        if (!item.title || !item.link) continue;

        // Resolve Google News redirect URLs to real article URLs
        const url = isGoogleNews ? await resolveGoogleNewsUrl(item.link) : item.link;

        // Strip HTML from content — Google News RSS returns HTML link lists, not real content
        const description = stripHtml(item.contentSnippet) || stripHtml(item.content);

        // Extract image URL from common RSS fields
        const imageUrl = (item as any).enclosure?.url || (item as any).image?.url || null;

        allArticles.push({
          title: item.title,
          description,
          content: null, // Will be enriched later by content scraper
          url,
          imageUrl,
          source: isGoogleNews ? feed.name : (feed.name || "RSS"),
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
          imageUrl: article.imageUrl,
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
