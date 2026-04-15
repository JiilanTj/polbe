import { describe, expect, it } from "bun:test";
import {
  signAccessToken,
  signRefreshToken,
  verifyAccessToken,
  verifyRefreshToken,
} from "../../../src/lib/jwt";

const basePayload = {
  sub: "42",
  email: "user@example.com",
  username: "tester",
  role: "user" as const,
};

describe("lib/jwt", () => {
  // ─── Access Tokens ───────────────────────────────────────

  describe("signAccessToken", () => {
    it("produces a 3-part JWT string", async () => {
      const token = await signAccessToken(basePayload);
      expect(typeof token).toBe("string");
      expect(token.split(".").length).toBe(3);
    });

    it("encodes the correct claims", async () => {
      const token = await signAccessToken(basePayload);
      const payload = await verifyAccessToken(token);
      expect(payload.sub).toBe("42");
      expect(payload.email).toBe("user@example.com");
      expect(payload.username).toBe("tester");
      expect(payload.role).toBe("user");
    });

    it("includes iat and exp claims", async () => {
      const before = Math.floor(Date.now() / 1000);
      const token = await signAccessToken(basePayload);
      const payload = await verifyAccessToken(token);
      expect(payload.iat).toBeGreaterThanOrEqual(before);
      expect(payload.exp).toBeGreaterThan(payload.iat!);
    });
  });

  describe("verifyAccessToken", () => {
    it("rejects a tampered token", async () => {
      const token = await signAccessToken(basePayload);
      const tampered = token.slice(0, -4) + "XXXX";
      await expect(verifyAccessToken(tampered)).rejects.toThrow();
    });

    it("rejects a refresh token when expected access token", async () => {
      const refresh = await signRefreshToken(basePayload);
      // signed with a different secret — must fail
      await expect(verifyAccessToken(refresh)).rejects.toThrow();
    });

    it("rejects a malformed string", async () => {
      await expect(verifyAccessToken("not.a.jwt")).rejects.toThrow();
    });
  });

  // ─── Refresh Tokens ──────────────────────────────────────

  describe("signRefreshToken", () => {
    it("embeds jti (token ID) in the payload", async () => {
      const jti = crypto.randomUUID();
      const token = await signRefreshToken({ ...basePayload, jti });
      const payload = await verifyRefreshToken(token);
      expect(payload.jti).toBe(jti);
    });

    it("produces a token distinct from access token for same payload", async () => {
      const access = await signAccessToken(basePayload);
      const refresh = await signRefreshToken(basePayload);
      // Different secrets → different signatures
      expect(access).not.toBe(refresh);
    });
  });

  describe("verifyRefreshToken", () => {
    it("verifies a valid refresh token", async () => {
      const jti = crypto.randomUUID();
      const token = await signRefreshToken({ ...basePayload, jti });
      const payload = await verifyRefreshToken(token);
      expect(payload.sub).toBe("42");
      expect(payload.email).toBe("user@example.com");
      expect(payload.jti).toBe(jti);
    });

    it("rejects a tampered refresh token", async () => {
      const token = await signRefreshToken(basePayload);
      const tampered = token.slice(0, -4) + "XXXX";
      await expect(verifyRefreshToken(tampered)).rejects.toThrow();
    });

    it("rejects an access token when expected refresh token", async () => {
      const access = await signAccessToken(basePayload);
      await expect(verifyRefreshToken(access)).rejects.toThrow();
    });
  });
});
