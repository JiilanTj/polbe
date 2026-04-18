import { Hono } from "hono";
import { meController } from "../controllers/me.controller";
import { authMiddleware } from "../middlewares/auth.middleware";

export const meRoutes = new Hono();

meRoutes.use("/*", authMiddleware);

meRoutes.get("/", meController.profile);
meRoutes.patch("/", meController.updateProfile);
meRoutes.get("/lives-history", meController.livesHistory);
meRoutes.get("/referrals", meController.referrals);
meRoutes.get("/polls", meController.myPolls);
meRoutes.get("/portfolio", meController.portfolio);
meRoutes.get("/orders", meController.myOrders);
meRoutes.get("/trades", meController.myTrades);
meRoutes.get("/watchlist", meController.getWatchlist);
meRoutes.post("/watchlist/:pollId", meController.addWatchlist);
meRoutes.delete("/watchlist/:pollId", meController.removeWatchlist);

// ─── Notifications ──────────────────────────────────────────────────────────
meRoutes.get("/notifications", meController.getNotifications);
meRoutes.patch("/notifications/read-all", meController.markAllRead);
meRoutes.patch("/notifications/:id/read", meController.markOneRead);
