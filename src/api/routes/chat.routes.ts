import { Hono } from "hono";
import { chatController } from "../controllers/chat.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";

export const chatRoutes = new Hono();

chatRoutes.use("/*", authMiddleware);

chatRoutes.get("/thread", chatController.myThread);
chatRoutes.post("/messages", chatController.sendUserMessage);

chatRoutes.get("/admin/threads", requireRole("admin", "platform"), chatController.adminThreads);
chatRoutes.get("/admin/threads/:userId", requireRole("admin", "platform"), chatController.adminMessages);
chatRoutes.post("/admin/threads/:userId/messages", requireRole("admin", "platform"), chatController.sendAdminMessage);
