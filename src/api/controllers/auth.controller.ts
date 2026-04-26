import type { Context } from "hono";
import { db } from "../../db";
import { users } from "../../db/schema";
import { eq } from "drizzle-orm";
import { signAccessToken, signRefreshToken, verifyRefreshToken } from "../../lib/jwt";
import { redis } from "../../lib/redis";
import { parseBody } from "../../lib/validate";
import { registerSchema, loginSchema, forgotPasswordSchema, resetPasswordSchema } from "../../lib/schemas";
import { buildResetPasswordUrl, sendPasswordResetEmail } from "../../lib/email";

// Refresh token TTL in seconds (7 days)
const REFRESH_TTL = 60 * 60 * 24 * 7;
const COOKIE_NAME = "refresh_token";
const IS_PROD = process.env.NODE_ENV === "production";
// Password reset token TTL: 1 jam
const RESET_TTL = 60 * 60;
// Email verification token TTL: 24 jam
const VERIFY_TTL = 60 * 60 * 24;
// Auto-recovery interval: 6 jam dari sekarang
const RECOVERY_INTERVAL_MS = 6 * 60 * 60 * 1000;

function resetTokenKey(token: string) { return `reset:${token}`; }
function verifyTokenKey(token: string) { return `verify:${token}`; }

function refreshTokenKey(userId: number, tokenId: string) {
  return `refresh:${userId}:${tokenId}`;
}

function generateReferralCode(): string {
  // 8-char alphanumeric uppercase
  return Math.random().toString(36).substring(2, 6).toUpperCase() +
         Math.random().toString(36).substring(2, 6).toUpperCase();
}

export const authController = {
  async register(c: Context) {
    const body = await parseBody(c, registerSchema);
    if (body instanceof Response) return body;

    const { email, username, password, referralCode } = body;

    // Check duplicates
    const [existingEmail] = await db.select({ id: users.id }).from(users).where(eq(users.email, email.toLowerCase()));
    if (existingEmail) return c.json({ error: "Email sudah terdaftar" }, 409);

    const [existingUsername] = await db.select({ id: users.id }).from(users).where(eq(users.username, username));
    if (existingUsername) return c.json({ error: "Username sudah dipakai" }, 409);

    // Role selalu "user" — tidak bisa di-set dari luar
    const assignedRole = "user" as const;

    // Resolve referral code → referrer user ID
    let referredById: number | null = null;
    if (referralCode) {
      const [referrer] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.referralCode, referralCode.toUpperCase()));
      if (referrer) referredById = referrer.id;
    }

    const passwordHash = await Bun.password.hash(password, { algorithm: "bcrypt", cost: 12 });

    // Generate unique referral code (retry on rare collision)
    let newReferralCode = generateReferralCode();
    let retries = 0;
    while (retries < 5) {
      const [collision] = await db
        .select({ id: users.id })
        .from(users)
        .where(eq(users.referralCode, newReferralCode));
      if (!collision) break;
      newReferralCode = generateReferralCode();
      retries++;
    }

    const recoveryAt = new Date(Date.now() + RECOVERY_INTERVAL_MS);

    const [user] = await db
      .insert(users)
      .values({
        email: email.toLowerCase(),
        username,
        passwordHash,
        role: assignedRole,
        livesBalance: "5",         // 5 nyawa gratis untuk akun baru
        livesRecoveryAt: recoveryAt,
        referralCode: newReferralCode,
        referredBy: referredById ?? undefined,
        emailVerifiedAt: new Date(),   // auto-verified
      })
      .returning({
        id: users.id,
        email: users.email,
        username: users.username,
        role: users.role,
        livesBalance: users.livesBalance,
        referralCode: users.referralCode,
        createdAt: users.createdAt,
      });

    return c.json({ message: "Registrasi berhasil", data: user }, 201);
  },

  async login(c: Context) {
    const body = await parseBody(c, loginSchema);
    if (body instanceof Response) return body;

    const { email, password } = body;

    const [user] = await db.select().from(users).where(eq(users.email, email.toLowerCase()));

    if (!user) return c.json({ error: "Email atau password salah" }, 401);
    if (!user.isActive) return c.json({ error: "Akun telah dinonaktifkan" }, 403);

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

    // Set refresh token sebagai HttpOnly cookie (aman dari XSS)
    c.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${refreshToken}; HttpOnly; Path=/api/auth; Max-Age=${REFRESH_TTL}; SameSite=Strict${IS_PROD ? "; Secure" : ""}`,
    );

    return c.json({
      data: {
        accessToken,
        user: { id: user.id, email: user.email, username: user.username, role: user.role },
      },
    });
  },

  async refresh(c: Context) {
    // Baca refresh token dari HttpOnly cookie (atau fallback body untuk kompatibilitas mobile)
    const cookieHeader = c.req.header("cookie") ?? "";
    const cookieToken = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);

    const body = await c.req.json<{ refreshToken?: string }>().catch(() => ({ refreshToken: undefined }));
    const refreshToken = cookieToken ?? body.refreshToken;

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

    // Rotate cookie
    c.header(
      "Set-Cookie",
      `${COOKIE_NAME}=${newRefreshToken}; HttpOnly; Path=/api/auth; Max-Age=${REFRESH_TTL}; SameSite=Strict${IS_PROD ? "; Secure" : ""}`,
    );

    return c.json({ data: { accessToken: newAccessToken } });
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
    // Baca dari cookie atau body
    const cookieHeader = c.req.header("cookie") ?? "";
    const cookieToken = cookieHeader
      .split(";")
      .map((s) => s.trim())
      .find((s) => s.startsWith(`${COOKIE_NAME}=`))?.slice(COOKIE_NAME.length + 1);

    const body = await c.req.json<{ refreshToken?: string }>().catch(() => ({ refreshToken: undefined }));
    const refreshToken = cookieToken ?? body.refreshToken;

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

    // Clear cookie
    c.header("Set-Cookie", `${COOKIE_NAME}=; HttpOnly; Path=/api/auth; Max-Age=0; SameSite=Strict${IS_PROD ? "; Secure" : ""}`);

    return c.json({ message: "Logged out successfully" });
  },

  // POST /api/auth/verify-email — verifikasi email via token
  async verifyEmail(c: Context) {
    const { token } = await c.req.json<{ token: string }>().catch(() => ({ token: "" }));
    if (!token) return c.json({ error: "Token wajib diisi" }, 400);

    const userId = await redis.get(verifyTokenKey(token));
    if (!userId) return c.json({ error: "Token tidak valid atau sudah kadaluarsa" }, 400);

    await db
      .update(users)
      .set({ emailVerifiedAt: new Date() })
      .where(eq(users.id, Number(userId)));

    await redis.del(verifyTokenKey(token));

    return c.json({ message: "Email berhasil diverifikasi" });
  },

  // POST /api/auth/forgot-password — minta reset password
  async forgotPassword(c: Context) {
    const body = await parseBody(c, forgotPasswordSchema);
    if (body instanceof Response) return body;

    const { email } = body;

    const [user] = await db
      .select({ id: users.id, email: users.email, username: users.username })
      .from(users)
      .where(eq(users.email, email.toLowerCase()));

    // Selalu return 200 agar tidak leak info user mana yang ada
    if (!user) {
      return c.json({ message: "Jika email terdaftar, instruksi reset password akan dikirim" });
    }

    const resetToken = crypto.randomUUID();
    await redis.set(resetTokenKey(resetToken), String(user.id), "EX", RESET_TTL);

    const emailResult = await sendPasswordResetEmail({
      to: user.email,
      username: user.username,
      token: resetToken,
    });

    if (emailResult.sent) {
      console.log(`[ForgotPassword] Reset email sent to ${email} (user #${user.id})`);
    } else {
      console.warn(
        `[ForgotPassword] Email not sent for ${email} (user #${user.id}): ${emailResult.reason ?? emailResult.error ?? "unknown reason"}`,
      );
      console.log(`[ForgotPassword] Reset URL: ${emailResult.resetUrl ?? buildResetPasswordUrl(resetToken)}`);
    }

    return c.json({ message: "Jika email terdaftar, instruksi reset password akan dikirim" });
  },

  // POST /api/auth/reset-password — reset password dengan token
  async resetPassword(c: Context) {
    const body = await parseBody(c, resetPasswordSchema);
    if (body instanceof Response) return body;

    const { token, newPassword } = body;

    const userId = await redis.get(resetTokenKey(token));
    if (!userId) return c.json({ error: "Token tidak valid atau sudah kadaluarsa" }, 400);

    const passwordHash = await Bun.password.hash(newPassword, { algorithm: "bcrypt", cost: 12 });

    await db
      .update(users)
      .set({ passwordHash, updatedAt: new Date() })
      .where(eq(users.id, Number(userId)));

    await redis.del(resetTokenKey(token));

    return c.json({ message: "Password berhasil direset. Silakan login dengan password baru" });
  },
};
