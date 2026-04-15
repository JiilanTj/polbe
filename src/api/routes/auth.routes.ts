import { Hono } from "hono";
import { authController } from "../controllers/auth.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

export const authRoutes = new Hono();

authRoutes.post("/register", authController.register);
authRoutes.post("/login", authController.login);
authRoutes.post("/refresh", authController.refresh);
authRoutes.get("/verify-me", authMiddleware, authController.verifyMe);
authRoutes.post("/logout", authMiddleware, authController.logout);
