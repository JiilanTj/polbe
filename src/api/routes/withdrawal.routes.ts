import { Hono } from "hono";
import { withdrawalController } from "../controllers/withdrawal.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";

export const withdrawalRoutes = new Hono();

// User: buat request & lihat history
withdrawalRoutes.post("/", authMiddleware, withdrawalController.create);
withdrawalRoutes.get("/", authMiddleware, withdrawalController.list);

// Admin: approve / reject
withdrawalRoutes.patch("/:id/approve", authMiddleware, requireRole("admin"), withdrawalController.approve);
withdrawalRoutes.patch("/:id/reject", authMiddleware, requireRole("admin"), withdrawalController.reject);
