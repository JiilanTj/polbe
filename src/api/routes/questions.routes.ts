import { Hono } from "hono";
import { questionsController } from "../controllers/questions.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";

export const questionsRoutes = new Hono();

// Public
questionsRoutes.get("/", questionsController.list);
questionsRoutes.get("/:id", questionsController.getById);

// Protected (admin / platform only)
questionsRoutes.post("/", authMiddleware, requireRole("admin", "platform"), questionsController.create);
questionsRoutes.post("/generate", authMiddleware, requireRole("admin", "platform"), questionsController.generate);
