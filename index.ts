import { Hono } from "hono";
import { cors } from "hono/cors";
import { serveStatic } from "hono/bun";
import { swaggerUI } from "@hono/swagger-ui";
import { registerRoutes } from "./src/api";
import { wsHandler } from "./src/ws/handler";
import { startScheduler } from "./src/jobs/scheduler";
import { closeDb } from "./src/db";
import { config } from "./src/config";
import { ensureBucket } from "./src/lib/minio";

// ─── Hono App ────────────────────────────────────────────────
const app = new Hono();

app.use("*", cors({
  origin: (origin) => {
    // Jika CORS_ORIGIN = "*", izinkan semua origin tapi reflect origin-nya (diperlukan saat credentials: true)
    const allowed = config.cors.origin;
    if (allowed.length === 1 && allowed[0] === "*") return origin || "*";
    return allowed.includes(origin) ? origin : allowed[0];
  },
  allowHeaders: ["Content-Type", "Authorization"],
  allowMethods: ["GET", "POST", "PATCH", "PUT", "DELETE", "OPTIONS"],
  exposeHeaders: ["X-RateLimit-Limit", "X-RateLimit-Remaining", "Retry-After"],
  credentials: true,
}));

// Register all domain routes
registerRoutes(app);

// ─── Swagger Docs ────────────────────────────────────────────
app.get("/swagger.yml", async (c) => {
  const file = Bun.file("./swagger.yml");
  return new Response(await file.text(), {
    headers: { "Content-Type": "text/yaml" },
  });
});

app.get("/docs", swaggerUI({ url: "/swagger.yml" }));

// ─── Admin Panel ─────────────────────────────────────────────
app.get("/admin", async (c) => {
  const file = Bun.file("./public/index.html");
  return new Response(await file.text(), {
    headers: { "Content-Type": "text/html" },
  });
});

app.use("/public/*", serveStatic({ root: "./" }));

app.get("/", (c) => {
  return c.json({
    name: "Polymarket Backend",
    version: "1.0.0",
    admin: "/admin",
    docs: "/docs",
    endpoints: {
      auth: "/api/auth",
      news: "/api/news",
      trends: "/api/trends",
      questions: "/api/questions",
      polls: "/api/polls",
      packages: "/api/packages",
      topup: "/api/topup",
      withdrawal: "/api/withdrawal",
      me: "/api/me",
      admin: "/api/admin",
      leaderboard: "/api/leaderboard",
      upload: "POST /api/upload",
      scrape: "POST /api/scrape/trigger",
    },
    websocket: `ws://localhost:${config.server.port}/ws`,
  });
});

// ─── Bun Server with WebSocket ───────────────────────────────
const server = Bun.serve({
  port: config.server.port,
  fetch(req, server) {
    const url = new URL(req.url);

    // Upgrade WebSocket
    if (url.pathname === "/ws") {
      if (server.upgrade(req, { data: { subscriptions: new Set(["all"]) } })) {
        return;
      }
      return new Response("WebSocket upgrade failed", { status: 500 });
    }

    // Handle Hono routes
    return app.fetch(req);
  },
  websocket: wsHandler,
});

console.log(`🚀 Server running at http://localhost:${server.port}`);
console.log(`🔌 WebSocket at ws://localhost:${server.port}/ws`);

// ─── Start Scheduler ─────────────────────────────────────────
startScheduler();

// ─── Init MinIO Bucket ───────────────────────────────────────
ensureBucket().catch((err) => console.error("[MinIO] Gagal init bucket:", err.message));

// ─── Graceful Shutdown ───────────────────────────────────────
process.on("SIGINT", async () => {
  console.log("\n🛑 Shutting down...");
  await closeDb();
  process.exit(0);
});

process.on("SIGTERM", async () => {
  console.log("\n🛑 Shutting down...");
  await closeDb();
  process.exit(0);
});