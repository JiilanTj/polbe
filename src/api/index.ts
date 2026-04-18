import { Hono } from "hono";
import { newsRoutes } from "./routes/news.routes";
import { trendsRoutes } from "./routes/trends.routes";
import { questionsRoutes } from "./routes/questions.routes";
import { scrapeRoutes } from "./routes/scrape.routes";
import { authRoutes } from "./routes/auth.routes";
import { packagesRoutes } from "./routes/packages.routes";
import { topupRoutes } from "./routes/topup.routes";
import { withdrawalRoutes } from "./routes/withdrawal.routes";
import { pollsRoutes } from "./routes/polls.routes";
import { meRoutes } from "./routes/me.routes";
import { adminRoutes } from "./routes/admin.routes";
import { leaderboardRoutes } from "./routes/leaderboard.routes";
import { uploadRoutes } from "./routes/upload.routes";
import { defaultRateLimit } from "./middlewares/rate-limit.middleware";

export function registerRoutes(app: Hono) {
  const api = new Hono();

  // Global rate limit
  api.use("/*", defaultRateLimit);

  api.route("/auth", authRoutes);
  api.route("/news", newsRoutes);
  api.route("/trends", trendsRoutes);
  api.route("/questions", questionsRoutes);
  api.route("/scrape", scrapeRoutes);
  api.route("/packages", packagesRoutes);
  api.route("/topup", topupRoutes);
  api.route("/withdrawal", withdrawalRoutes);
  api.route("/polls", pollsRoutes);
  api.route("/me", meRoutes);
  api.route("/admin", adminRoutes);
  api.route("/leaderboard", leaderboardRoutes);
  api.route("/upload", uploadRoutes);

  app.route("/api", api);
}
