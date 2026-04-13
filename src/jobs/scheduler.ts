import cron from "node-cron";
import { config } from "../config";
import { scrapeRssFeeds, saveArticles } from "../scrapers/rss";
import { scrapeNewsApi } from "../scrapers/newsapi";
import { deduplicateArticles, cleanText } from "../processors/cleaner";
import { detectTrends } from "../ai/trend";
import { analyzeSentiment } from "../ai/sentiment";
import { generateQuestions } from "../ai/question-generator";
import { db } from "../db";
import { articles, trends, generatedQuestions } from "../db/schema";
import { desc, gte } from "drizzle-orm";
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

  // 4. AI Processing (only if we have OpenAI key)
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

export function startScheduler() {
  const interval = config.scraping.intervalMinutes;
  const cronExpr = `*/${interval} * * * *`;

  console.log(`[Scheduler] Starting with interval: every ${interval} minutes (${cronExpr})`);

  cron.schedule(cronExpr, () => {
    runScrapeJob().catch((err) => console.error("[Scheduler] Job failed:", err));
  });

  // Run once immediately on start
  runScrapeJob().catch((err) => console.error("[Scheduler] Initial job failed:", err));
}

export { runScrapeJob };
