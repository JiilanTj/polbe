export const config = {
  database: {
    url: process.env.DATABASE_URL || "postgresql://postgres:postgres@localhost:5432/polymarket",
  },
  redis: {
    url: process.env.REDIS_URL || "redis://:redis123@localhost:6379",
  },
  jwt: {
    accessSecret: process.env.JWT_ACCESS_SECRET || "change-me-access-secret-min-32chars!!",
    refreshSecret: process.env.JWT_REFRESH_SECRET || "change-me-refresh-secret-min-32chars!",
    accessExpiresIn: process.env.JWT_ACCESS_EXPIRES_IN || "15m",
    refreshExpiresIn: process.env.JWT_REFRESH_EXPIRES_IN || "7d",
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
  cors: {
    // Pisahkan dengan koma jika lebih dari satu: "http://localhost:5173,https://app.example.com"
    origin: (process.env.CORS_ORIGIN || "*").split(",").map((s) => s.trim()),
  },
  scraping: {
    intervalMinutes: Number(process.env.SCRAPE_INTERVAL_MINUTES) || 15,
  },
  minio: {
    endpoint: process.env.MINIO_ENDPOINT || "localhost",
    port: Number(process.env.MINIO_PORT) || 9000,
    useSSL: process.env.MINIO_USE_SSL === "true",
    accessKey: process.env.MINIO_ACCESS_KEY || "minioadmin",
    secretKey: process.env.MINIO_SECRET_KEY || "minioadmin123",
    bucket: process.env.MINIO_BUCKET || "polymarket",
    publicUrl: process.env.MINIO_PUBLIC_URL || "http://localhost:9000",
  },
  rssFeeds: [
    { name: "Google News", url: "https://news.google.com/rss?hl=en-US&gl=US&ceid=US:en" },
    { name: "Google News - World", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx1YlY4U0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en" },
    { name: "Google News - Business", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGx6TVdZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en" },
    { name: "Google News - Technology", url: "https://news.google.com/rss/topics/CAAqJggKIiBDQkFTRWdvSUwyMHZNRGRqTVhZU0FtVnVHZ0pWVXlnQVAB?hl=en-US&gl=US&ceid=US:en" },
    { name: "BBC News", url: "https://feeds.bbci.co.uk/news/world/rss.xml" },
    { name: "CNN Top Stories", url: "http://rss.cnn.com/rss/edition.rss" },
    { name: "Al Jazeera", url: "https://www.aljazeera.com/xml/rss/all.xml" },
  ],
} as const;
