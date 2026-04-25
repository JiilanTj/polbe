import { Hono } from "hono";
import { questionsController } from "../controllers/questions.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { adminMutationRateLimit } from "../middlewares/rate-limit.middleware";

export const questionsRoutes = new Hono();

// Public
questionsRoutes.get("/", questionsController.list);
questionsRoutes.get("/:id", questionsController.getById);

// Protected (admin / platform only)
questionsRoutes.post("/", authMiddleware, requireRole("admin", "platform"), adminMutationRateLimit, questionsController.create);
questionsRoutes.post("/generate", authMiddleware, requireRole("admin", "platform"), adminMutationRateLimit, questionsController.generate);
questionsRoutes.post("/:id/make-poll", authMiddleware, requireRole("admin"), adminMutationRateLimit, questionsController.makePoll);

// Admin only — approve / reject / update status
questionsRoutes.patch("/:id/status", authMiddleware, requireRole("admin"), adminMutationRateLimit, questionsController.updateStatus);
