import { Hono } from "hono";
import { trendsController } from "../controllers/trends.controller";

export const trendsRoutes = new Hono();

trendsRoutes.get("/", trendsController.list);
trendsRoutes.get("/:topic", trendsController.getByTopic);
