import type { ServerWebSocket } from "bun";
import { verifyAccessToken } from "../lib/jwt";

interface WsData {
  subscriptions: Set<string>;
  pingInterval?: ReturnType<typeof setInterval>;
  userId?: number;
  role?: string;
}

const clients = new Set<ServerWebSocket<WsData>>();
const PRIVATE_CHANNEL_PREFIX = "user:";
const ADMIN_CHANNEL = "admin";

// Interval ping ke semua client setiap 30 detik supaya koneksi idle tidak terputus
const PING_INTERVAL_MS = 30_000;

function isPrivateCategory(category?: string) {
  return category?.startsWith(PRIVATE_CHANNEL_PREFIX) || category === ADMIN_CHANNEL || false;
}

function isAdminRole(role?: string) {
  return role === "admin" || role === "platform";
}

function clearPrivateSubscriptions(subscriptions: Set<string>) {
  for (const category of subscriptions) {
    if (isPrivateCategory(category)) subscriptions.delete(category);
  }
}

export const wsHandler = {
  open(ws: ServerWebSocket<WsData>) {
    ws.data = { subscriptions: new Set(["all"]) };
    clients.add(ws);
    console.log(`[WS] Client connected. Total: ${clients.size}`);
    ws.send(JSON.stringify({ event: "connected", data: { message: "Connected to Polymarket WS" } }));

    // Mulai heartbeat ping
    ws.data.pingInterval = setInterval(() => {
      try {
        ws.send(JSON.stringify({ event: "ping" }));
      } catch {
        clearInterval(ws.data.pingInterval);
        clients.delete(ws);
      }
    }, PING_INTERVAL_MS);
  },

  async message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    try {
      const msg = JSON.parse(typeof message === "string" ? message : message.toString());

      if (msg.event === "subscribe" && typeof msg.category === "string") {
        if (msg.category.startsWith(PRIVATE_CHANNEL_PREFIX)) {
          ws.send(JSON.stringify({
            event: "subscribe:error",
            data: {
              category: msg.category,
              error: "Channel user hanya aktif lewat auth token yang valid",
            },
          }));
          return;
        }

        if (msg.category === ADMIN_CHANNEL && !isAdminRole(ws.data.role)) {
          ws.send(JSON.stringify({
            event: "subscribe:error",
            data: {
              category: msg.category,
              error: "Channel admin hanya aktif untuk token admin/platform yang valid",
            },
          }));
          return;
        }

        ws.data.subscriptions.add(msg.category);
        ws.send(JSON.stringify({ event: "subscribed", data: { category: msg.category } }));
      }

      if (msg.event === "unsubscribe" && typeof msg.category === "string") {
        ws.data.subscriptions.delete(msg.category);
        ws.send(JSON.stringify({ event: "unsubscribed", data: { category: msg.category } }));
      }

      // Daftarkan sebagai koneksi milik user tertentu — wajib sertakan access token
      // { event: "auth", token: "eyJ..." }
      if (msg.event === "auth" && typeof msg.token === "string") {
        try {
          const payload = await verifyAccessToken(msg.token);
          const userId = Number(payload.sub);
          ws.data.userId = userId;
          ws.data.role = payload.role;
          clearPrivateSubscriptions(ws.data.subscriptions);
          ws.data.subscriptions.add(`user:${userId}`);
          if (isAdminRole(payload.role)) {
            ws.data.subscriptions.add(ADMIN_CHANNEL);
          }
          ws.send(JSON.stringify({ event: "auth:ok", data: { userId, role: payload.role } }));
        } catch {
          ws.data.userId = undefined;
          ws.data.role = undefined;
          clearPrivateSubscriptions(ws.data.subscriptions);
          ws.send(JSON.stringify({ event: "auth:error", data: { error: "Token tidak valid atau kadaluarsa" } }));
        }
      }

      // Balas pong dari client (client bisa juga kirim pong sebagai keepalive)
      if (msg.event === "pong") {
        // Heartbeat confirmed — tidak perlu tindakan apapun
      }
    } catch {
      // Ignore invalid messages
    }
  },

  close(ws: ServerWebSocket<WsData>) {
    clearInterval(ws.data.pingInterval);
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  },
};

export function broadcastEvent(event: string, data: unknown, category?: string) {
  const payload = JSON.stringify({ event, data });
  const privateEvent = isPrivateCategory(category);

  for (const client of clients) {
    const subs = client.data?.subscriptions;
    if (privateEvent) {
      if (category && subs?.has(category)) client.send(payload);
      continue;
    }

    if (subs?.has("all") || (category && subs?.has(category))) {
      client.send(payload);
    }
  }
}
