import { describe, expect, it, beforeEach } from "bun:test";
import { Hono } from "hono";
import { signAccessToken, type TokenPayload } from "../../../../src/lib/jwt";
import { authMiddleware, requireRole } from "../../../../src/api/middlewares/auth.middleware";

type AppVars = { Variables: { user: TokenPayload } };
type App = Hono<AppVars>;

const j = (r: Response) => r.json() as Promise<any>;

// Helper: build app with auth-protected route
function makeApp() {
  const app = new Hono<AppVars>();
  app.get("/protected", authMiddleware, (c) =>
    c.json({ user: c.get("user") }),
  );
  app.get(
    "/admin-only",
    authMiddleware,
    requireRole("admin"),
    (c) => c.json({ ok: true }),
  );
  app.get(
    "/multi-role",
    authMiddleware,
    requireRole("admin", "platform"),
    (c) => c.json({ ok: true }),
  );
  return app;
}

const userPayload = {
  sub: "1",
  email: "user@example.com",
  username: "someone",
  role: "user" as const,
};

const adminPayload = {
  sub: "2",
  email: "admin@example.com",
  username: "bigboss",
  role: "admin" as const,
};

describe("authMiddleware", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
  });

  it("returns 401 when Authorization header is missing", async () => {
    const res = await app.request("/protected");
    expect(res.status).toBe(401);
    const body = await j(res);
    expect(body.error).toBeDefined();
  });

  it("returns 401 when Authorization header is not Bearer scheme", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Basic dXNlcjpwYXNz" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a garbage token value", async () => {
    const res = await app.request("/protected", {
      headers: { Authorization: "Bearer this.is.garbage" },
    });
    expect(res.status).toBe(401);
  });

  it("returns 401 for a tampered valid token", async () => {
    const token = await signAccessToken(userPayload);
    const tampered = token.slice(0, -4) + "XXXX";
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${tampered}` },
    });
    expect(res.status).toBe(401);
  });

  it("calls next and sets user in context for a valid token", async () => {
    const token = await signAccessToken(userPayload);
    const res = await app.request("/protected", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.user.sub).toBe("1");
    expect(body.user.email).toBe("user@example.com");
    expect(body.user.role).toBe("user");
  });
});

describe("requireRole", () => {
  let app: App;

  beforeEach(() => {
    app = makeApp();
  });

  it("returns 403 when authenticated user lacks required role", async () => {
    const token = await signAccessToken(userPayload); // role: user
    const res = await app.request("/admin-only", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
    const body = await j(res);
    expect(body.error).toContain("permission");
  });

  it("allows access when user has the required role", async () => {
    const token = await signAccessToken(adminPayload); // role: admin
    const res = await app.request("/admin-only", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(200);
  });

  it("allows access when user matches any of multiple roles", async () => {
    const platformToken = await signAccessToken({
      ...userPayload,
      role: "platform",
    });
    const res = await app.request("/multi-role", {
      headers: { Authorization: `Bearer ${platformToken}` },
    });
    expect(res.status).toBe(200);
  });

  it("denies access when user matches none of the allowed roles", async () => {
    const token = await signAccessToken(userPayload); // role: user — not in [admin, platform]
    const res = await app.request("/multi-role", {
      headers: { Authorization: `Bearer ${token}` },
    });
    expect(res.status).toBe(403);
  });
});
