import { Hono } from "hono";
import { pollsController } from "../controllers/polls.controller";
import { ordersController } from "../controllers/orders.controller";
import { commentsController } from "../controllers/comments.controller";
import { authMiddleware, requireRole } from "../middlewares/auth.middleware";
import { voteRateLimit } from "../middlewares/rate-limit.middleware";

export const pollsRoutes = new Hono();

// Publik — list, trending & detail (trending HARUS sebelum /:id agar tidak ditangkap sebagai ID)
pollsRoutes.get("/", pollsController.list);
pollsRoutes.get("/trending", pollsController.trending);
pollsRoutes.get("/:id", pollsController.getById);

// User auth — vote & lihat vote sendiri (legacy)
pollsRoutes.post("/:id/vote", authMiddleware, voteRateLimit, pollsController.vote);
pollsRoutes.get("/:id/my-vote", authMiddleware, pollsController.myVote);

// ─── CLOB: Order Book ─────────────────────────────────────────
pollsRoutes.post("/:id/orders", authMiddleware, ordersController.placeOrder);
pollsRoutes.get("/:id/orderbook", ordersController.getOrderBook);
pollsRoutes.get("/:id/activity", ordersController.getActivity);
pollsRoutes.get("/:id/price-history", ordersController.getPriceHistory);
pollsRoutes.delete("/:id/orders/:orderId", authMiddleware, ordersController.cancelOrder);

// ─── Comments ─────────────────────────────────────────────────
pollsRoutes.get("/:id/comments", commentsController.list);
pollsRoutes.post("/:id/comments", authMiddleware, commentsController.create);
pollsRoutes.delete("/:id/comments/:commentId", authMiddleware, commentsController.deleteComment);

// Admin/platform — kelola poll
pollsRoutes.post("/", authMiddleware, requireRole("admin", "platform"), pollsController.create);
pollsRoutes.patch("/:id/status", authMiddleware, requireRole("admin"), pollsController.updateStatus);
pollsRoutes.patch("/:id/resolve", authMiddleware, requireRole("admin"), pollsController.resolve);
pollsRoutes.delete("/:id", authMiddleware, requireRole("admin"), pollsController.deletePoll);
