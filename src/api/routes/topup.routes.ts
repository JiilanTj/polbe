import { Hono } from "hono";
import { topupController } from "../controllers/topup.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";

export const topupRoutes = new Hono();

// User: buat request & lihat history
topupRoutes.post("/", authMiddleware, topupController.create);
topupRoutes.get("/", authMiddleware, topupController.list);

// Admin: approve / reject
topupRoutes.patch("/:id/approve", authMiddleware, requireRole("admin"), topupController.approve);
topupRoutes.patch("/:id/reject", authMiddleware, requireRole("admin"), topupController.reject);
