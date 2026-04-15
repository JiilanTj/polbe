import type { Context } from "hono";
import { db } from "../../db";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../lib/jwt";
import { redis } from "../../lib/redis";

// Refresh token TTL in seconds (7 days)
const REFRESH_TTL = 60 * 60 * 24 * 7;

function refreshTokenKey(userId: number, tokenId: string) {
  return `refresh:${userId}:${tokenId}`;
}

export const authController = {
  async register(c: Context) {
    const body = await c.req.json<{ email: string; username: string; password: string; role?: string }>();
    const { email, username, password, role } = body;

    if (!email || !username || !password) {
      return c.json({ error: "Email, username, and password are required" }, 400);
    }

    // Basic email format validation
    if (!/^[^\s@]+@[^\s@]+\.[^\s@]+$/.test(email)) {
      return c.json({ error: "Invalid email format" }, 400);
    }

    if (password.length < 8) {
      return c.json({ error: "Password must be at least 8 characters" }, 400);
    }

    // Check duplicates
    const [existingEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase()));
    if (existingEmail) return c.json({ error: "Email already registered" }, 409);

    const [existingUsername] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (existingUsername) return c.json({ error: "Username already taken" }, 409);

    // Only allow specific roles on registration (prevent self-escalation)
    const allowedRoles = ["user", "platform"] as const;
    const assignedRole = allowedRoles.includes(role as any) ? (role as "user" | "platform") : "user";

    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 });

    const [user] = await db
      .insert(users)
      .values({ email: email.toLowerCase(), username, passwordHash, role: assignedRole })
      .returning({ id: users.id, email: users.email, username: users.username, role: users.role, createdAt: users.createdAt });

    return c.json({ message: "Registration successful", data: user }, 201);
  },

  async login(c: Context) {
    const body = await c.req.json<{ email: string; password: string }>();
    const { email, password } = body;

    if (!email || !password) {
      return c.json({ error: "Email and password are required" }, 400);
    }

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

    if (!user) return c.json({ error: "Invalid email or password" }, 401);
    if (!user.isActive) return c.json({ error: "Account is deactivated" }, 403);

    const validPassword = await Bun.password.verify(password, user.passwordHash);
    if (!validPassword) return c.json({ error: "Invalid email or password" }, 401);

    const tokenPayload = {
      sub: String(user.id),
      email: user.email,
      username: user.username,
      role: user.role,
    };

    const accessToken = await signAccessToken(tokenPayload);
    const tokenId = crypto.randomUUID();
    const refreshToken = await signRefreshToken({ ...tokenPayload, jti: tokenId });

    // Store refresh token in Redis
    await redis.set(refreshTokenKey(user.id, tokenId), "1", "EX", REFRESH_TTL);

    return c.json({
      data: {
        accessToken,
        refreshToken,
        user: { id: user.id, email: user.email, username: user.username, role: user.role },
      },
    });
  },

  async refresh(c: Context) {
    const body = await c.req.json<{ refreshToken: string }>();
    const { refreshToken } = body;

    if (!refreshToken) return c.json({ error: "Refresh token is required" }, 400);

    let payload;
    try {
      payload = await verifyRefreshToken(refreshToken);
    } catch {
      return c.json({ error: "Invalid or expired refresh token" }, 401);
    }

    const userId = Number(payload.sub);
    const tokenId = payload.jti as string;

    // Verify token exists in Redis (not revoked)
    const exists = await redis.get(refreshTokenKey(userId, tokenId));
    if (!exists) return c.json({ error: "Refresh token has been revoked" }, 401);

    // Fetch fresh user data
    const [user] = await db
      .select({ id: users.id, email: users.email, username: users.username, role: users.role, isActive: users.isActive })
      .from(users)
      .where(eq(users.id, userId));

    if (!user || !user.isActive) return c.json({ error: "User not found or deactivated" }, 401);

    // Rotate: revoke old token, issue new pair
    await redis.del(refreshTokenKey(userId, tokenId));

    const tokenPayload = { sub: String(user.id), email: user.email, username: user.username, role: user.role };
    const newAccessToken = await signAccessToken(tokenPayload);
    const newTokenId = crypto.randomUUID();
    const newRefreshToken = await signRefreshToken({ ...tokenPayload, jti: newTokenId });

    await redis.set(refreshTokenKey(user.id, newTokenId), "1", "EX", REFRESH_TTL);

    return c.json({ data: { accessToken: newAccessToken, refreshToken: newRefreshToken } });
  },

  async verifyMe(c: Context) {
    const user = c.get("user");
    const [dbUser] = await db
      .select({ id: users.id, email: users.email, username: users.username, role: users.role, isActive: users.isActive, createdAt: users.createdAt })
      .from(users)
      .where(eq(users.id, Number(user.sub)));

    if (!dbUser) return c.json({ error: "User not found" }, 404);
    return c.json({ data: dbUser });
  },

  async logout(c: Context) {
    const body = await c.req.json<{ refreshToken: string }>().catch(() => ({ refreshToken: "" }));
    const { refreshToken } = body;

    if (refreshToken) {
      try {
        const payload = await verifyRefreshToken(refreshToken);
        const userId = Number(payload.sub);
        const tokenId = payload.jti as string;
        await redis.del(refreshTokenKey(userId, tokenId));
      } catch {
        // Token already invalid — that's fine
      }
    }

    return c.json({ message: "Logged out successfully" });
  },
};
