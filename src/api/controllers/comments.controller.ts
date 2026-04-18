import type { Context } from "hono";
import { db } from "../../db";
import { pollComments, users, polls } from "../../db/schema";
import { eq, and, desc, isNull, sql } from "drizzle-orm";
import type { TokenPayload } from "../../lib/jwt";
import { parseBody, safeInt } from "../../lib/validate";
import { commentCreateSchema } from "../../lib/schemas";

export const commentsController = {
  // GET /api/polls/:id/comments — daftar komentar (publik)
  async list(c: Context) {
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "30"), 100);
    const offset = (page - 1) * limit;

    const rows = await db
      .select({
        id: pollComments.id,
        body: pollComments.body,
        createdAt: pollComments.createdAt,
        updatedAt: pollComments.updatedAt,
        userId: pollComments.userId,
        username: users.username,
        avatarUrl: users.avatarUrl,
      })
      .from(pollComments)
      .innerJoin(users, eq(pollComments.userId, users.id))
      .where(and(eq(pollComments.pollId, pollId), isNull(pollComments.deletedAt)))
      .orderBy(desc(pollComments.createdAt))
      .limit(limit)
      .offset(offset);

    const [countRow] = await db
      .select({ count: sql<number>`count(*)` })
      .from(pollComments)
      .where(and(eq(pollComments.pollId, pollId), isNull(pollComments.deletedAt)));

    return c.json({
      data: rows,
      pagination: {
        page, limit,
        total: Number(countRow?.count ?? 0),
        totalPages: Math.ceil(Number(countRow?.count ?? 0) / limit),
      },
    });
  },

  // POST /api/polls/:id/comments — tambah komentar (auth)
  async create(c: Context) {
    const me = c.get("user") as TokenPayload;
    const pollId = safeInt(c.req.param("id"));
    if (!pollId) return c.json({ error: "ID poll tidak valid" }, 400);

    const body = await parseBody(c, commentCreateSchema);
    if (body instanceof Response) return body;

    const [poll] = await db.select({ id: polls.id }).from(polls).where(eq(polls.id, pollId));
    if (!poll) return c.json({ error: "Poll tidak ditemukan" }, 404);

    const [comment] = await db.insert(pollComments)
      .values({ pollId, userId: Number(me.sub), body: body.body.trim() })
      .returning();

    // Ambil username untuk response
    const [user] = await db
      .select({ username: users.username, avatarUrl: users.avatarUrl })
      .from(users)
      .where(eq(users.id, Number(me.sub)));

    return c.json({
      message: "Komentar berhasil ditambahkan",
      data: { ...comment, username: user?.username, avatarUrl: user?.avatarUrl },
    }, 201);
  },

  // DELETE /api/polls/:id/comments/:commentId — hapus komentar sendiri (atau admin)
  async deleteComment(c: Context) {
    const me = c.get("user") as TokenPayload;
    const commentId = safeInt(c.req.param("commentId"));
    if (!commentId) return c.json({ error: "ID komentar tidak valid" }, 400);

    const [comment] = await db.select().from(pollComments).where(eq(pollComments.id, commentId));
    if (!comment || comment.deletedAt) return c.json({ error: "Komentar tidak ditemukan" }, 404);

    if (comment.userId !== Number(me.sub) && me.role !== "admin") {
      return c.json({ error: "Bukan komentar kamu" }, 403);
    }

    await db.update(pollComments)
      .set({ deletedAt: new Date() })
      .where(eq(pollComments.id, commentId));

    return c.json({ message: "Komentar berhasil dihapus" });
  },
};
