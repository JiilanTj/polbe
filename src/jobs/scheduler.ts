import cron from "node-cron";
import { config } from "../config";
import { runLivesRecovery } from "./lives-recovery";
import { runPollExpiry } from "./poll-expiry";
import { runOrderExpiry } from "./order-expiry";
import { scrapeRssFeeds, saveArticles } from "../scrapers/rss";
import { scrapeNewsApi } from "../scrapers/newsapi";
import { scrapeArticleContent } from "../scrapers/content";
import { deduplicateArticles, cleanText } from "../processors/cleaner";
import { detectTrends } from "../ai/trend";
import { analyzeSentiment } from "../ai/sentiment";
import { generateQuestions } from "../ai/question-generator";
import { db } from "../db";
import { articles, trends, generatedQuestions } from "../db/schema";
import { desc, gte, eq, isNull, or, like, sql } from "drizzle-orm";
import { broadcastEvent } from "../ws/handler";

async function runScrapeJob() {
  console.log(`\n[Scheduler] Starting scrape job at ${new Date().toISOString()}`);

  // 1. Scrape from all sources
  const rssArticles = await scrapeRssFeeds();
  const newsApiArticles = await scrapeNewsApi();

  // 2. Merge, clean & deduplicate
  const allArticles = deduplicateArticles([...rssArticles, ...newsApiArticles]).map((a) => ({
    ...a,
    title: cleanText(a.title) || a.title,
    description: cleanText(a.description),
    content: cleanText(a.content),
  }));

  console.log(`[Scheduler] Total unique articles: ${allArticles.length}`);

  // 3. Save to DB
  const savedCount = await saveArticles(allArticles);
  console.log(`[Scheduler] Saved ${savedCount} new articles`);

  // Broadcast new articles
  if (savedCount > 0) {
    broadcastEvent("news:new", { count: savedCount });
  }

  // 4. Enrich articles with full content (scrape truncated ones)
  await enrichTruncatedArticles();

  // 5. AI Processing (only if we have OpenAI key)
  if (config.openai.apiKey) {
    try {
      // Get recent article titles for AI analysis
      const recentArticles = await db
        .select({ id: articles.id, title: articles.title, description: articles.description })
        .from(articles)
        .orderBy(desc(articles.scrapedAt))
        .limit(50);

      const titles = recentArticles.map((a) => a.title);
      const descriptions = recentArticles.map((a) => a.description || "");

      // Sentiment analysis
      const sentiments = await analyzeSentiment(titles.slice(0, 20));
      console.log(`[Scheduler] Analyzed sentiment for ${sentiments.length} articles`);

      // Trend detection
      const detectedTrends = await detectTrends(titles);
      for (const trend of detectedTrends) {
        await db
          .insert(trends)
          .values({
            topic: trend.topic,
            category: trend.category,
            mentionCount: trend.mentionCount,
            trendScore: String(trend.trendScore),
          })
          .onConflictDoNothing();
      }
      console.log(`[Scheduler] Detected ${detectedTrends.length} trends`);
      if (detectedTrends.length > 0) {
        broadcastEvent("trend:update", { trends: detectedTrends });
      }

      // Question generation
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
      console.log(`[Scheduler] Generated ${questions.length} questions`);
      if (questions.length > 0) {
        broadcastEvent("question:new", { questions });
      }
    } catch (error) {
      console.error("[Scheduler] AI processing error:", error);
    }
  }

  console.log(`[Scheduler] Job completed at ${new Date().toISOString()}\n`);
}

/**
 * Find articles with truncated/missing content and scrape full content from source URL.
 * Processes up to 10 articles per run to avoid overloading.
 */
async function enrichTruncatedArticles() {
  const truncated = await db
    .select({ id: articles.id, url: articles.url, content: articles.content })
    .from(articles)
    .where(
      or(
        isNull(articles.content),
        like(articles.content, "%[+%chars]%")
      )
    )
    .orderBy(desc(articles.scrapedAt))
    .limit(15);

  // Also find articles with very short content (< 300 chars = likely snippet)
  const shortContent = await db
    .select({ id: articles.id, url: articles.url, content: articles.content })
    .from(articles)
    .where(sql`LENGTH(${articles.content}) < 300 AND ${articles.content} IS NOT NULL`)
    .orderBy(desc(articles.scrapedAt))
    .limit(10);

  const toEnrich = [...truncated, ...shortContent];
  // Deduplicate by id
  const seen = new Set<number>();
  const unique = toEnrich.filter((a) => {
    if (seen.has(a.id)) return false;
    seen.add(a.id);
    return true;
  });

  if (unique.length === 0) return;

  console.log(`[Enricher] Enriching ${unique.length} articles with full content...`);
  let enriched = 0;

  for (const article of unique) {
    const fullContent = await scrapeArticleContent(article.url);
    if (fullContent && fullContent.length > (article.content?.length ?? 0)) {
      await db
        .update(articles)
        .set({ content: fullContent })
        .where(eq(articles.id, article.id));
      enriched++;
    }
  }

  console.log(`[Enricher] Enriched ${enriched}/${unique.length} articles`);
}

export function startScheduler() {
  const interval = config.scraping.intervalMinutes;
  const cronExpr = `*/${interval} * * * *`;

  console.log(`[Scheduler] Starting with interval: every ${interval} minutes (${cronExpr})`);

  cron.schedule(cronExpr, () => {
    runScrapeJob().catch((err) => console.error("[Scheduler] Job failed:", err));
  });

  // Run once immediately on start
  runScrapeJob().catch((err) => console.error("[Scheduler] Initial job failed:", err));

  // Auto-recovery nyawa: +1 setiap 6 jam
  cron.schedule("0 */6 * * *", () => {
    runLivesRecovery().catch((err) => console.error("[LivesRecovery] Job gagal:", err));
  });

  console.log("[Scheduler] Lives recovery job dijadwalkan setiap 6 jam.");

  // Auto-close poll kadaluarsa + cancel orders: cek setiap menit
  cron.schedule("* * * * *", () => {
    runPollExpiry().catch((err) => console.error("[PollExpiry] Job gagal:", err));
    runOrderExpiry().catch((err) => console.error("[OrderExpiry] Job gagal:", err));
  });

  console.log("[Scheduler] Poll expiry + order expiry job dijadwalkan setiap menit.");
}

export { runScrapeJob };
