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
