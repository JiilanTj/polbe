import { Hono } from "hono";
import { adminController } from "../controllers/admin.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { adminMutationRateLimit, defaultRateLimit } from "../middlewares/rate-limit.middleware";

export const adminRoutes = new Hono();

adminRoutes.use("/*", authMiddleware, requireRole("admin"), defaultRateLimit);

adminRoutes.get("/stats", adminController.stats);
adminRoutes.get("/users", adminController.listUsers);
adminRoutes.post("/users", adminMutationRateLimit, adminController.createUser);
adminRoutes.get("/users/:id", adminController.getUser);
adminRoutes.patch("/users/:id/toggle", adminMutationRateLimit, adminController.toggleUser);
adminRoutes.patch("/users/:id/role", adminMutationRateLimit, adminController.changeRole);
adminRoutes.patch("/users/:id/master", adminMutationRateLimit, adminController.setMaster);
adminRoutes.post("/users/:id/credit", adminMutationRateLimit, adminController.creditLives);

// ─── Audit endpoints ────────────────────────────────────────────────────────
adminRoutes.get("/orders", adminController.listOrders);
adminRoutes.get("/positions", adminController.listPositions);
adminRoutes.get("/trades", adminController.listTrades);
adminRoutes.get("/audit-logs", adminController.listAuditLogs);

// ─── Platform Settings ───────────────────────────────────────────────────────
adminRoutes.get("/settings", adminController.getSettings);
adminRoutes.patch("/settings/withdrawal-fee", adminMutationRateLimit, adminController.updateWithdrawalFee);
adminRoutes.patch("/settings/lives-to-usdt-rate", adminMutationRateLimit, adminController.updateLivesToUsdtRate);
adminRoutes.patch("/settings/topup-payment-methods", adminMutationRateLimit, adminController.updateTopupPaymentMethods);
