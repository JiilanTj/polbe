import { Hono } from "hono";
import { newsController } from "../controllers/news.controller";

export const newsRoutes = new Hono();

newsRoutes.get("/", newsController.list);
newsRoutes.get("/:id", newsController.getById);
