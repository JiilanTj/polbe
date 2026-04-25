import { Hono } from "hono";
import { packagesController } from "../controllers/packages.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { adminMutationRateLimit } from "../middlewares/rate-limit.middleware";

export const packagesRoutes = new Hono();

// Publik — lihat daftar paket nyawa
packagesRoutes.get("/", packagesController.list);

// Admin only
packagesRoutes.post("/seed", authMiddleware, requireRole("admin"), adminMutationRateLimit, packagesController.seed);
packagesRoutes.post("/", authMiddleware, requireRole("admin"), adminMutationRateLimit, packagesController.create);
packagesRoutes.patch("/:id/toggle", authMiddleware, requireRole("admin"), adminMutationRateLimit, packagesController.toggle);
