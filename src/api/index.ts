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

export function registerRoutes(app: Hono) {
  const api = new Hono();

  api.route("/auth", authRoutes);
  api.route("/news", newsRoutes);
  api.route("/trends", trendsRoutes);
  api.route("/questions", questionsRoutes);
  api.route("/scrape", scrapeRoutes);
  api.route("/packages", packagesRoutes);
  api.route("/topup", topupRoutes);
  api.route("/withdrawal", withdrawalRoutes);
  api.route("/polls", pollsRoutes);

  app.route("/api", api);
}
