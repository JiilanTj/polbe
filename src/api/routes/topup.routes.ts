import { Hono } from "hono";
import { topupController } from "../controllers/topup.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { adminMutationRateLimit } from "../middlewares/rate-limit.middleware";

export const topupRoutes = new Hono();

topupRoutes.get("/payment-methods", authMiddleware, topupController.paymentMethods);

// User: buat request & lihat history
topupRoutes.post("/", authMiddleware, topupController.create);
topupRoutes.get("/", authMiddleware, topupController.list);

// Admin: approve / reject
topupRoutes.patch("/:id/approve", authMiddleware, requireRole("admin"), adminMutationRateLimit, topupController.approve);
topupRoutes.patch("/:id/reject", authMiddleware, requireRole("admin"), adminMutationRateLimit, topupController.reject);
