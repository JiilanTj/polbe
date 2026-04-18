import { Hono } from "hono";
import { uploadController } from "../controllers/upload.controller";
import { authMiddleware } from "../middlewares/auth.middleware";
import { uploadRateLimit } from "../middlewares/rate-limit.middleware";

export const uploadRoutes = new Hono();

// Semua user login bisa upload file
uploadRoutes.post("/", authMiddleware, uploadRateLimit, uploadController.upload);
