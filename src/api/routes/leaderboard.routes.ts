import { Hono } from "hono";
import { leaderboardController } from "../controllers/leaderboard.controller";

export const leaderboardRoutes = new Hono();

leaderboardRoutes.get("/", leaderboardController.byLives);
leaderboardRoutes.get("/wins", leaderboardController.byWins);
leaderboardRoutes.get("/referrals", leaderboardController.byReferrals);
