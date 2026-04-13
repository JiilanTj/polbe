import { Hono } from "hono";
import { questionsController } from "../controllers/questions.controller";

export const questionsRoutes = new Hono();

questionsRoutes.get("/", questionsController.list);
questionsRoutes.get("/:id", questionsController.getById);
questionsRoutes.post("/generate", questionsController.generate);
