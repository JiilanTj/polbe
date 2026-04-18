import { Hono } from "hono";
import { adminController } from "../controllers/admin.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";

export const adminRoutes = new Hono();

adminRoutes.use("/*", authMiddleware, requireRole("admin"));

adminRoutes.get("/users", adminController.listUsers);
adminRoutes.get("/users/:id", adminController.getUser);
adminRoutes.patch("/users/:id/toggle", adminController.toggleUser);
adminRoutes.patch("/users/:id/role", adminController.changeRole);
adminRoutes.post("/users/:id/credit", adminController.creditLives);
