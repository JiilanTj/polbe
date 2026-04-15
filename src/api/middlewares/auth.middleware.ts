import type { Context, Next } from "hono";
import { verifyAccessToken, type UserRole } from "../../lib/jwt";

export async function authMiddleware(c: Context, next: Next) {
  const authorization = c.req.header("Authorization");
  if (!authorization?.startsWith("Bearer ")) {
    return c.json({ error: "Missing or invalid Authorization header" }, 401);
  }

  const token = authorization.slice(7);
  try {
    const payload = await verifyAccessToken(token);
    c.set("user", payload);
    await next();
  } catch {
    return c.json({ error: "Token expired or invalid" }, 401);
  }
}

export function requireRole(...roles: UserRole[]) {
  return async (c: Context, next: Next) => {
    const user = c.get("user");
    if (!user || !roles.includes(user.role)) {
      return c.json({ error: "Insufficient permissions" }, 403);
    }
    await next();
  };
}
