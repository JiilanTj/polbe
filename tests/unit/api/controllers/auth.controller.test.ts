import { mock, beforeAll, beforeEach, describe, it, expect, spyOn } from "bun:test";
import { makeChain } from "../../../helpers/db-mock";

// ─── Module Mocks ─────────────────────────────────────────────────────────────
// NOTE: We intentionally do NOT mock src/lib/jwt here so the real JWT logic
// runs and does not contaminate other test files (auth.middleware.test.ts).

const mockSelect = mock(() => makeChain([]));
const mockInsert = mock(() => makeChain([]));
const mockUpdate = mock(() => makeChain(undefined));

mock.module("../../../../src/db", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate },
}));

mock.module("drizzle-orm", () => ({
  eq: (..._args: unknown[]) => ({}),
  desc: (..._args: unknown[]) => ({}),
  like: (..._args: unknown[]) => ({}),
  sql: Object.assign((_t: TemplateStringsArray, ..._v: unknown[]) => ({}), {
    raw: (..._args: unknown[]) => ({}),
  }),
}));

const mockRedisGet = mock(async () => null as string | null);
const mockRedisSet = mock(async () => "OK");
const mockRedisDel = mock(async () => 1);

mock.module("../../../../src/lib/redis", () => ({
  redis: { get: mockRedisGet, set: mockRedisSet, del: mockRedisDel },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import type { BlankEnv, BlankSchema } from "hono/types";
import { authController } from "../../../../src/api/controllers/auth.controller";
import { signRefreshToken, type TokenPayload } from "../../../../src/lib/jwt";

// ─── Types ────────────────────────────────────────────────────────────────────

type AppVars = { Variables: { user: TokenPayload } };
type App = Hono<AppVars, BlankSchema, "/">;

/** Cast Response.json() to any — acceptable in test files */
const j = (r: Response) => r.json() as Promise<any>;

// ─── Shared state ─────────────────────────────────────────────────────────────

let validRefreshToken: string;
const TEST_JTI = "unit-test-jti-abc123";
const TEST_USER_ID = 1;

beforeAll(async () => {
  validRefreshToken = await signRefreshToken({
    sub: String(TEST_USER_ID),
    email: "u@x.com",
    username: "user1",
    role: "user",
    jti: TEST_JTI,
  });
});

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp(): App {
  const app = new Hono<AppVars>();
  app.post("/register", authController.register);
  app.post("/login", authController.login);
  app.post("/refresh", authController.refresh);
  app.get("/verify-me", (c) => {
    c.set("user", { sub: String(TEST_USER_ID), email: "u@x.com", username: "user1", role: "user" });
    return authController.verifyMe(c);
  });
  app.post("/logout", (c) => {
    c.set("user", { sub: String(TEST_USER_ID), email: "u@x.com", username: "user1", role: "user" });
    return authController.logout(c);
  });
  return app;
}

function jsonRequest(body: unknown, method = "POST") {
  return {
    method,
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

const mockUser = {
  id: TEST_USER_ID,
  email: "user@example.com",
  username: "testuser",
  passwordHash: "$2b$12$hash",
  role: "user",
  isActive: true,
  createdAt: new Date().toISOString(),
};

// ─── authController.register ──────────────────────────────────────────────────

describe("authController.register", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
    mockInsert.mockReset();
    mockSelect.mockReturnValue(makeChain([]));
    mockInsert.mockReturnValue(
      makeChain([{ id: 1, email: "user@example.com", username: "testuser", role: "user", createdAt: new Date() }]),
    );
  });

  it("returns 400 when email is missing", async () => {
    const res = await app.request("/register", jsonRequest({ username: "u", password: "pass1234" }));
    expect(res.status).toBe(422);
    expect((await j(res)).error).toBeDefined();
  });

  it("returns 400 when password is missing", async () => {
    const res = await app.request("/register", jsonRequest({ email: "a@b.com", username: "u" }));
    expect(res.status).toBe(422);
  });

  it("returns 400 for invalid email format", async () => {
    const res = await app.request("/register", jsonRequest({ email: "not-an-email", username: "u", password: "pass1234" }));
    expect(res.status).toBe(422);
    expect((await j(res)).details?.email?.join(" ")).toMatch(/email/i);
  });

  it("returns 400 when password is shorter than 8 characters", async () => {
    const res = await app.request("/register", jsonRequest({ email: "a@b.com", username: "u", password: "short" }));
    expect(res.status).toBe(422);
    expect((await j(res)).details?.password?.join(" ")).toMatch(/8/);
  });

  it("returns 409 when email is already registered", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([{ id: 99 }]))
      .mockReturnValueOnce(makeChain([]));

    const res = await app.request("/register", jsonRequest({ email: "dup@b.com", username: "unique", password: "pass1234" }));
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/email/i);
  });

  it("returns 409 when username is already taken", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ id: 99 }]));

    const res = await app.request("/register", jsonRequest({ email: "new@b.com", username: "taken", password: "pass1234" }));
    expect(res.status).toBe(409);
    expect((await j(res)).error).toMatch(/username/i);
  });

  it("returns 201 and user data on success", async () => {
    const hashSpy = spyOn(Bun.password, "hash").mockResolvedValue("$2b$12$hashed");

    const res = await app.request("/register", jsonRequest({ email: "new@b.com", username: "newuser", password: "pass1234" }));
    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body.message).toMatch(/berhasil|success/i);
    expect(body.data).toBeDefined();

    hashSpy.mockRestore();
  });

  it("prevents self-escalation to admin role", async () => {
    const hashSpy = spyOn(Bun.password, "hash").mockResolvedValue("$2b$12$hashed");
    mockInsert.mockReturnValue(
      makeChain([{ id: 1, email: "a@b.com", username: "u", role: "user", createdAt: new Date() }]),
    );

    const res = await app.request(
      "/register",
      jsonRequest({ email: "a@b.com", username: "u", password: "password123", role: "admin" }),
    );
    const body = await j(res);
    expect(body.data?.role).not.toBe("admin");

    hashSpy.mockRestore();
  });
});

// ─── authController.login ────────────────────────────────────────────────────

describe("authController.login", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
    mockRedisSet.mockReset();
    mockRedisSet.mockResolvedValue("OK");
  });

  it("returns 400 when email is missing", async () => {
    const res = await app.request("/login", jsonRequest({ password: "pass" }));
    expect(res.status).toBe(422);
  });

  it("returns 400 when password is missing", async () => {
    const res = await app.request("/login", jsonRequest({ email: "a@b.com" }));
    expect(res.status).toBe(422);
  });

  it("returns 401 when user is not found", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    const res = await app.request("/login", jsonRequest({ email: "ghost@b.com", password: "pass1234" }));
    expect(res.status).toBe(401);
  });

  it("returns 403 when user account is deactivated", async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ ...mockUser, isActive: false }]));
    const res = await app.request("/login", jsonRequest({ email: "user@example.com", password: "pass1234" }));
    expect(res.status).toBe(403);
  });

  it("returns 401 for wrong password", async () => {
    mockSelect.mockReturnValueOnce(makeChain([mockUser]));
    const verifySpy = spyOn(Bun.password, "verify").mockResolvedValue(false);

    const res = await app.request("/login", jsonRequest({ email: "user@example.com", password: "wrong" }));
    expect(res.status).toBe(401);

    verifySpy.mockRestore();
  });

  it("returns 200 with access + refresh tokens and user info on success", async () => {
    mockSelect.mockReturnValueOnce(makeChain([mockUser]));
    const verifySpy = spyOn(Bun.password, "verify").mockResolvedValue(true);

    const res = await app.request("/login", jsonRequest({ email: "user@example.com", password: "correct" }));
    expect(res.status).toBe(200);

    const body = await j(res);
    expect(typeof body.data.accessToken).toBe("string");
    expect(body.data.refreshToken).toBeUndefined();
    expect(res.headers.get("set-cookie")).toContain("refresh_token=");
    expect(body.data.user.id).toBe(TEST_USER_ID);
    expect(body.data.user.email).toBe("user@example.com");

    verifySpy.mockRestore();
  });
});

// ─── authController.refresh ───────────────────────────────────────────────────

describe("authController.refresh", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
    mockRedisGet.mockReset();
    mockRedisDel.mockReset();
    mockRedisSet.mockReset();
    mockSelect.mockReset();
    mockRedisGet.mockResolvedValue("1");
    mockRedisSet.mockResolvedValue("OK");
    mockSelect.mockReturnValue(
      makeChain([{ id: TEST_USER_ID, email: "u@x.com", username: "user1", role: "user", isActive: true }]),
    );
  });

  it("returns 400 when refreshToken is missing in body", async () => {
    const res = await app.request("/refresh", jsonRequest({}));
    expect(res.status).toBe(400);
  });

  it("returns 401 for a syntactically invalid token", async () => {
    const res = await app.request("/refresh", jsonRequest({ refreshToken: "not.a.valid.jwt" }));
    expect(res.status).toBe(401);
  });

  it("returns 401 when token is not found in Redis (revoked)", async () => {
    mockRedisGet.mockResolvedValueOnce(null);
    const res = await app.request("/refresh", jsonRequest({ refreshToken: validRefreshToken }));
    expect(res.status).toBe(401);
    expect((await j(res)).error).toMatch(/revoked/i);
  });

  it("returns 401 when associated user is deactivated", async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ id: TEST_USER_ID, isActive: false }]));
    const res = await app.request("/refresh", jsonRequest({ refreshToken: validRefreshToken }));
    expect(res.status).toBe(401);
  });

  it("returns 200 with a new token pair and rotates the refresh token in Redis", async () => {
    const res = await app.request("/refresh", jsonRequest({ refreshToken: validRefreshToken }));
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(typeof body.data.accessToken).toBe("string");
    expect(body.data.refreshToken).toBeUndefined();
    expect(res.headers.get("set-cookie")).toContain("refresh_token=");
    expect(mockRedisDel).toHaveBeenCalled();
    expect(mockRedisSet).toHaveBeenCalled();
  });
});

// ─── authController.verifyMe ─────────────────────────────────────────────────

describe("authController.verifyMe", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
  });

  it("returns 404 when user no longer exists in DB", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    const res = await app.request("/verify-me");
    expect(res.status).toBe(404);
  });

  it("returns 200 with fresh user data from DB", async () => {
    mockSelect.mockReturnValueOnce(
      makeChain([{ id: TEST_USER_ID, email: "u@x.com", username: "user1", role: "user", isActive: true, createdAt: new Date() }]),
    );
    const res = await app.request("/verify-me");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.data.id).toBe(TEST_USER_ID);
    expect(body.data.email).toBe("u@x.com");
  });
});

// ─── authController.logout ───────────────────────────────────────────────────

describe("authController.logout", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
    mockRedisDel.mockReset();
  });

  it("returns 200 even when no refreshToken is provided in body", async () => {
    const res = await app.request("/logout", jsonRequest({}));
    expect(res.status).toBe(200);
    expect((await j(res)).message).toMatch(/logged out/i);
  });

  it("revokes the refresh token from Redis when a valid token is provided", async () => {
    mockRedisDel.mockResolvedValueOnce(1);
    const res = await app.request("/logout", jsonRequest({ refreshToken: validRefreshToken }));
    expect(res.status).toBe(200);
    expect(mockRedisDel).toHaveBeenCalled();
  });

  it("returns 200 gracefully when an invalid/expired refresh token is given", async () => {
    const res = await app.request("/logout", jsonRequest({ refreshToken: "this.is.invalid" }));
    expect(res.status).toBe(200);
  });
});
