import type { Context, Next } from "hono";
import { redis } from "../../lib/redis";

interface RateLimitOptions {
  /** Max requests dalam window */
  max: number;
  /** Window durasi dalam detik */
  windowSeconds: number;
  /** Pesan error kustom */
  message?: string;
  /** Key prefix untuk Redis */
  prefix?: string;
}

/**
 * Rate limiter berbasis Redis menggunakan sliding window (INCR + EXPIRE).
 * Key: `rl:<prefix>:<clientIP>` atau `rl:<prefix>:<userId>` jika sudah auth.
 */
export function rateLimiter(opts: RateLimitOptions) {
  const { max, windowSeconds, message, prefix = "global" } = opts;

  return async (c: Context, next: Next) => {
    // Gunakan userId jika sudah login, fallback ke IP
    const user = c.get("user") as { sub?: string } | undefined;
    const identifier = user?.sub
      ? `user:${user.sub}`
      : (c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? "unknown");

    const key = `rl:${prefix}:${identifier}`;

    const current = await redis.incr(key);
    if (current === 1) {
      await redis.expire(key, windowSeconds);
    }

    // Set headers informatif
    c.header("X-RateLimit-Limit", String(max));
    c.header("X-RateLimit-Remaining", String(Math.max(0, max - current)));

    if (current > max) {
      const ttl = await redis.ttl(key);
      c.header("Retry-After", String(ttl));
      return c.json(
        { error: message ?? `Terlalu banyak request. Coba lagi dalam ${ttl} detik.` },
        429,
      );
    }

    await next();
  };
}

// ─── Preset rate limiters ───────────────────────────────────────────────────

/** Login / register: 10 req / menit */
export const authRateLimit = rateLimiter({
  max: 10,
  windowSeconds: 60,
  prefix: "auth",
  message: "Terlalu banyak percobaan login/register. Coba lagi dalam 1 menit.",
});

/** Upload file: 20 req / menit per user */
export const uploadRateLimit = rateLimiter({
  max: 20,
  windowSeconds: 60,
  prefix: "upload",
});

/** Vote poll: 30 req / menit per user */
export const voteRateLimit = rateLimiter({
  max: 30,
  windowSeconds: 60,
  prefix: "vote",
});

/** API umum: 120 req / menit */
export const defaultRateLimit = rateLimiter({
  max: 120,
  windowSeconds: 60,
  prefix: "api",
});

/** Mutasi admin sensitif: lebih ketat dari read-only admin routes */
export const adminMutationRateLimit = rateLimiter({
  max: 30,
  windowSeconds: 60,
  prefix: "admin_mutation",
  message: "Terlalu banyak aksi admin. Coba lagi dalam 1 menit.",
});
