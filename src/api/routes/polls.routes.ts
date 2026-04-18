import { Hono } from "hono";
import { pollsController } from "../controllers/polls.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { voteRateLimit } from "../middlewares/rate-limit.middleware";

export const pollsRoutes = new Hono();

// Publik — list, trending & detail (trending HARUS sebelum /:id agar tidak ditangkap sebagai ID)
pollsRoutes.get("/", pollsController.list);
pollsRoutes.get("/trending", pollsController.trending);
pollsRoutes.get("/:id", pollsController.getById);

// User auth — vote & lihat vote sendiri
pollsRoutes.post("/:id/vote", authMiddleware, voteRateLimit, pollsController.vote);
pollsRoutes.get("/:id/my-vote", authMiddleware, pollsController.myVote);

// Admin/platform — kelola poll
pollsRoutes.post("/", authMiddleware, requireRole("admin", "platform"), pollsController.create);
pollsRoutes.patch("/:id/status", authMiddleware, requireRole("admin"), pollsController.updateStatus);
pollsRoutes.patch("/:id/resolve", authMiddleware, requireRole("admin"), pollsController.resolve);
pollsRoutes.delete("/:id", authMiddleware, requireRole("admin"), pollsController.deletePoll);
