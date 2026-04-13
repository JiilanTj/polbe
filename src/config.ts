export const config = {
  database: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/polymarket",
  },
  newsapi: {
    key: process.env.NEWSAPI_KEY || "",
    baseUrl: "https://newsapi.org/v2",
  },
  openai: {
    apiKey: process.env.OPENAI_API_KEY || "",
    model: process.env.OPENAI_MODEL || "gpt-4o",
  },
  server: {
    port: Number(process.env.PORT) || 3000,
  },
  scraping: {
    intervalMinutes: Number(process.env.SCRAPE_INTERVAL_MINUTES) || 15,
  },
  rssFeeds: [
    { name: "Google News", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" },
    { name: "Google News - World", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en" },
    { name: "Reuters - World", url: "https://www.reutersagency.com/feed/?best-topics=political-general&post_type=best" },
    { name: "AP News", url: "https://rsshub.app/apnews/topics/apf-topnews" },
  ],
} as const;
