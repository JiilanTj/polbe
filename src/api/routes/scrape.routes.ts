import { Hono } from "hono";
import { scrapeController } from "../controllers/scrape.controller";

export const scrapeRoutes = new Hono();

scrapeRoutes.post("/trigger", scrapeController.trigger);
