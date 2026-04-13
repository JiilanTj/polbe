import { Hono } from "hono";
import { cors } from "hono/cors";
import { swaggerUI } from "@hono/swagger-ui";
import { registerRoutes } from "./src/api";
import { wsHandler } from "./src/ws/handler";
import { startScheduler } from "./src/jobs/scheduler";
import { closeDb } from "./src/db";
import { config } from "./src/config";

// ─── Hono App ────────────────────────────────────────────────
const app = new Hono();

app.use("*", cors());

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

app.get("/", (c) => {
  return c.json({
    name: "Polymarket Backend",
    version: "1.0.0",
    docs: "/docs",
    endpoints: {
      news: "/api/news",
      trends: "/api/trends",
      questions: "/api/questions",
      scrape: "POST /api/scrape/trigger",
      generate: "POST /api/questions/generate",
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