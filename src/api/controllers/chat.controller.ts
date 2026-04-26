import type { Context } from "hono";
import { and, asc, desc, eq, sql } from "drizzle-orm";
import { db } from "../../db";
import { chatMessages, chatThreads, users } from "../../db/schema";
import type { TokenPayload } from "../../lib/jwt";
import { getPublicUrl } from "../../lib/minio";
import { parseBody, escapeHtml, safeInt } from "../../lib/validate";
import { chatMessageSchema } from "../../lib/schemas";
import { broadcastEvent } from "../../ws/handler";

const MESSAGE_LIMIT = 100;

async function getOrCreateThread(userId: number) {
  const [existing] = await db.select().from(chatThreads).where(eq(chatThreads.userId, userId));
  if (existing) return existing;

  const [created] = await db
    .insert(chatThreads)
    .values({ userId })
    .returning();

  if (!created) throw new Error("Gagal membuat thread chat");
  return created;
}

function messagePreview(body: string, mediaUrl?: string | null) {
  const preview = body.trim() || (mediaUrl ? "Foto" : "");
  return preview.length > 160 ? `${preview.slice(0, 157)}...` : preview;
}

function serializeMessage<T extends { mediaUrl?: string | null }>(message: T) {
  return {
    ...message,
    mediaUrl: getPublicUrl(message.mediaUrl),
  };
}

function isAdminRole(role: string) {
  return role === "admin" || role === "platform";
}

async function markRead(threadId: number, role: "user" | "admin") {
  if (role === "user") {
    await db
      .update(chatThreads)
      .set({ userUnreadCount: 0, updatedAt: new Date() })
      .where(eq(chatThreads.id, threadId));
    await db
      .update(chatMessages)
      .set({ readAt: new Date() })
      .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.senderRole, "admin")));
    return;
  }

  await db
    .update(chatThreads)
    .set({ adminUnreadCount: 0, updatedAt: new Date() })
    .where(eq(chatThreads.id, threadId));
  await db
    .update(chatMessages)
    .set({ readAt: new Date() })
    .where(and(eq(chatMessages.threadId, threadId), eq(chatMessages.senderRole, "user")));
}

async function listMessages(threadId: number) {
  return db
    .select({
      id: chatMessages.id,
      threadId: chatMessages.threadId,
      senderId: chatMessages.senderId,
      senderRole: chatMessages.senderRole,
      body: chatMessages.body,
      mediaUrl: chatMessages.mediaUrl,
      mediaType: chatMessages.mediaType,
      readAt: chatMessages.readAt,
      createdAt: chatMessages.createdAt,
      senderUsername: users.username,
    })
    .from(chatMessages)
    .innerJoin(users, eq(users.id, chatMessages.senderId))
    .where(eq(chatMessages.threadId, threadId))
    .orderBy(asc(chatMessages.createdAt))
    .limit(MESSAGE_LIMIT);
}

async function insertMessage(params: {
  threadId: number;
  threadUserId: number;
  senderId: number;
  senderRole: string;
  body: string;
  mediaUrl?: string;
  mediaType?: "image";
}) {
  const cleanBody = escapeHtml(params.body.trim());
  const now = new Date();

  const [message] = await db
    .insert(chatMessages)
    .values({
      threadId: params.threadId,
      senderId: params.senderId,
      senderRole: params.senderRole,
      body: cleanBody,
      mediaUrl: params.mediaUrl,
      mediaType: params.mediaUrl ? (params.mediaType ?? "image") : null,
    })
    .returning();
  if (!message) throw new Error("Gagal membuat pesan chat");

  await db
    .update(chatThreads)
    .set({
      lastMessagePreview: messagePreview(cleanBody, params.mediaUrl),
      lastMessageAt: now,
      userUnreadCount: params.senderRole === "user" ? sql`${chatThreads.userUnreadCount}` : sql`${chatThreads.userUnreadCount} + 1`,
      adminUnreadCount: params.senderRole === "user" ? sql`${chatThreads.adminUnreadCount} + 1` : sql`${chatThreads.adminUnreadCount}`,
      updatedAt: now,
    })
    .where(eq(chatThreads.id, params.threadId));

  const payload = {
    ...serializeMessage(message),
    threadUserId: params.threadUserId,
  };

  broadcastEvent("chat:new", payload, `user:${params.threadUserId}`);
  broadcastEvent("chat:new", payload, "admin");

  return message;
}

export const chatController = {
  // GET /api/chat/thread — thread + messages milik user login
  async myThread(c: Context) {
    const me = c.get("user") as TokenPayload;
    const userId = Number(me.sub);
    const thread = await getOrCreateThread(userId);
    await markRead(thread.id, "user");
    const messages = await listMessages(thread.id);
    return c.json({ data: { thread, messages: messages.map(serializeMessage) } });
  },

  // POST /api/chat/messages — user kirim pesan ke admin
  async sendUserMessage(c: Context) {
    const me = c.get("user") as TokenPayload;
    const body = await parseBody(c, chatMessageSchema);
    if (body instanceof Response) return body;

    const userId = Number(me.sub);
    const thread = await getOrCreateThread(userId);
    const message = await insertMessage({
      threadId: thread.id,
      threadUserId: userId,
      senderId: userId,
      senderRole: "user",
      body: body.body,
      mediaUrl: body.mediaUrl,
      mediaType: body.mediaType,
    });

    return c.json({ data: serializeMessage(message) }, 201);
  },

  // GET /api/chat/admin/threads — inbox semua user untuk admin
  async adminThreads(c: Context) {
    const rows = await db
      .select({
        id: chatThreads.id,
        userId: chatThreads.userId,
        username: users.username,
        email: users.email,
        lastMessagePreview: chatThreads.lastMessagePreview,
        lastMessageAt: chatThreads.lastMessageAt,
        adminUnreadCount: chatThreads.adminUnreadCount,
        userUnreadCount: chatThreads.userUnreadCount,
        createdAt: chatThreads.createdAt,
        updatedAt: chatThreads.updatedAt,
      })
      .from(chatThreads)
      .innerJoin(users, eq(users.id, chatThreads.userId))
      .orderBy(desc(chatThreads.lastMessageAt), desc(chatThreads.updatedAt))
      .limit(100);

    return c.json({ data: rows });
  },

  // GET /api/chat/admin/threads/:userId — messages thread user tertentu
  async adminMessages(c: Context) {
    const userId = safeInt(c.req.param("userId"));
    if (!userId) return c.json({ error: "ID user tidak valid" }, 400);

    const thread = await getOrCreateThread(userId);
    await markRead(thread.id, "admin");
    const messages = await listMessages(thread.id);
    return c.json({ data: { thread, messages: messages.map(serializeMessage) } });
  },

  // POST /api/chat/admin/threads/:userId/messages — admin manapun membalas user
  async sendAdminMessage(c: Context) {
    const me = c.get("user") as TokenPayload;
    if (!isAdminRole(me.role)) return c.json({ error: "Insufficient permissions" }, 403);

    const userId = safeInt(c.req.param("userId"));
    if (!userId) return c.json({ error: "ID user tidak valid" }, 400);

    const body = await parseBody(c, chatMessageSchema);
    if (body instanceof Response) return body;

    const [user] = await db.select({ id: users.id }).from(users).where(eq(users.id, userId));
    if (!user) return c.json({ error: "User tidak ditemukan" }, 404);

    const thread = await getOrCreateThread(userId);
    const message = await insertMessage({
      threadId: thread.id,
      threadUserId: userId,
      senderId: Number(me.sub),
      senderRole: me.role,
      body: body.body,
      mediaUrl: body.mediaUrl,
      mediaType: body.mediaType,
    });

    return c.json({ data: serializeMessage(message) }, 201);
  },
};
