import { Hono } from "hono";
import { scrapeController } from "../controllers/scrape.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";

export const scrapeRoutes = new Hono();

// Hanya admin yang boleh trigger scraping
scrapeRoutes.post("/trigger", authMiddleware, requireRole("admin"), scrapeController.trigger);
