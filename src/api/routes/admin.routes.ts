import { Hono } from "hono";
import { adminController } from "../controllers/admin.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { defaultRateLimit } from "../middlewares/rate-limit.middleware";

export const adminRoutes = new Hono();

adminRoutes.use("/*", authMiddleware, requireRole("admin"), defaultRateLimit);

adminRoutes.get("/stats", adminController.stats);
adminRoutes.get("/users", adminController.listUsers);
adminRoutes.get("/users/:id", adminController.getUser);
adminRoutes.patch("/users/:id/toggle", adminController.toggleUser);
adminRoutes.patch("/users/:id/role", adminController.changeRole);
adminRoutes.post("/users/:id/credit", adminController.creditLives);
