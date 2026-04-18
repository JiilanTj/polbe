import type { ServerWebSocket } from "bun";

interface WsData {
  subscriptions: Set<string>;
}

const clients = new Set<ServerWebSocket<WsData>>();

export const wsHandler = {
  open(ws: ServerWebSocket<WsData>) {
    ws.data = { subscriptions: new Set(["all"]) };
    clients.add(ws);
    console.log(`[WS] Client connected. Total: ${clients.size}`);
    ws.send(JSON.stringify({ event: "connected", data: { message: "Connected to Polymarket WS" } }));
  },

  message(ws: ServerWebSocket<WsData>, message: string | Buffer) {
    try {
      const msg = JSON.parse(typeof message === "string" ? message : message.toString());

      if (msg.event === "subscribe" && typeof msg.category === "string") {
        ws.data.subscriptions.add(msg.category);
        ws.send(JSON.stringify({ event: "subscribed", data: { category: msg.category } }));
      }

      if (msg.event === "unsubscribe" && typeof msg.category === "string") {
        ws.data.subscriptions.delete(msg.category);
        ws.send(JSON.stringify({ event: "unsubscribed", data: { category: msg.category } }));
      }

      // Daftarkan sebagai koneksi milik user tertentu (setelah login, kirim: { event: "auth", userId: 123 })
      if (msg.event === "auth" && typeof msg.userId === "number") {
        ws.data.subscriptions.add(`user:${msg.userId}`);
        ws.send(JSON.stringify({ event: "auth:ok", data: { userId: msg.userId } }));
      }
    } catch {
      // Ignore invalid messages
    }
  },

  close(ws: ServerWebSocket<WsData>) {
    clients.delete(ws);
    console.log(`[WS] Client disconnected. Total: ${clients.size}`);
  },
};

export function broadcastEvent(event: string, data: unknown, category?: string) {
  const payload = JSON.stringify({ event, data });

  for (const client of clients) {
    const subs = client.data?.subscriptions;
    if (subs?.has("all") || (category && subs?.has(category))) {
      client.send(payload);
    }
  }
}
