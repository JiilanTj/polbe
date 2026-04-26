import type { Context } from "hono";
import { db } from "../../db";
import { adminAuditLogs, articles, generatedQuestions, polls } from "../../db/schema";
import { and, desc, eq, sql } from "drizzle-orm";
import { generateQuestions, translateSingleQuestionToIndonesian } from "../../ai/question-generator";
import { config } from "../../config";
import type { TokenPayload } from "../../lib/jwt";
import { escapeHtml } from "../../lib/validate";
import { broadcastEvent } from "../../ws/handler";

const VALID_MARKET_TYPES = ["binary", "categorical", "scalar"] as const;
const VALID_STATUSES = ["draft", "pending", "active", "resolved", "closed"] as const;

type MarketType = (typeof VALID_MARKET_TYPES)[number];
type QuestionStatus = (typeof VALID_STATUSES)[number];

function requestIp(c: Context) {
  return c.req.header("x-forwarded-for") ?? c.req.header("x-real-ip") ?? null;
}

function toSlug(text: string): string {
  return (
    text
      .toLowerCase()
      .replace(/[^a-z0-9\s-]/g, "")
      .trim()
      .replace(/\s+/g, "-")
      .slice(0, 200) +
    "-" +
    Date.now()
  );
}

function sameText(a: string | null | undefined, b: string | null | undefined): boolean {
  if (!a || !b) return false;
  return a.trim().toLowerCase() === b.trim().toLowerCase();
}

function defaultIndonesianOutcomes(outcomes: string[]): string[] {
  return outcomes.map((item) => {
    const lower = item.trim().toLowerCase();
    if (lower === "yes") return "Ya";
    if (lower === "no") return "Tidak";
    return item;
  });
}

export const questionsController = {
  async list(c: Context) {
    const page = Number(c.req.query("page") || "1");
    const limit = Math.min(Number(c.req.query("limit") || "20"), 100);
    const status = c.req.query("status");
    const category = c.req.query("category");
    const marketType = c.req.query("marketType");
    const offset = (page - 1) * limit;
    const conditions: any[] = [];
    if (status) conditions.push(eq(generatedQuestions.status, status as QuestionStatus));
    if (category) conditions.push(eq(generatedQuestions.category, category));
    if (marketType) conditions.push(eq(generatedQuestions.marketType, marketType as MarketType));

    let query = db
      .select()
      .from(generatedQuestions)
      .where(conditions.length > 0 ? and(...conditions) : undefined)
      .orderBy(desc(generatedQuestions.createdAt))
      .limit(limit)
      .offset(offset);

    const result = await query;
    const [countResult] = await db
      .select({ count: sql<number>`count(*)` })
      .from(generatedQuestions)
      .where(conditions.length > 0 ? and(...conditions) : undefined);
    const total = Number(countResult?.count ?? 0);

    return c.json({
      data: result,
      pagination: { page, limit, total, totalPages: Math.ceil(total / limit) },
    });
  },

  async getById(c: Context) {
    const id = Number(c.req.param("id"));
    const [question] = await db.select().from(generatedQuestions).where(eq(generatedQuestions.id, id));

    if (!question) return c.json({ error: "Question not found" }, 404);
    return c.json({ data: question });
  },

  async create(c: Context) {
    const me = c.get("user") as TokenPayload | undefined;
    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Request body tidak valid (harus JSON)" }, 400);

    const {
      question,
      questionId,
      description,
      descriptionId,
      category,
      tags,
      imageUrl,
      marketType = "binary",
      outcomes,
      initialLiquidity,
      minTradeSize,
      startDate,
      resolutionDate,
      resolutionSource,
      resolutionCriteria,
      resolutionCriteriaId,
      sourceArticleIds,
      status = "draft",
    } = body as Record<string, any>;

    // ─── Validation ──────────────────────────────────────────────
    if (!question?.trim()) {
      return c.json({ error: "Field 'question' wajib diisi" }, 422);
    }
    if (!resolutionDate) {
      return c.json({ error: "Field 'resolutionDate' wajib diisi (ISO 8601)" }, 422);
    }
    if (!VALID_MARKET_TYPES.includes(marketType)) {
      return c.json({ error: `marketType harus salah satu: ${VALID_MARKET_TYPES.join(", ")}` }, 422);
    }
    if (!VALID_STATUSES.includes(status)) {
      return c.json({ error: `status harus salah satu: ${VALID_STATUSES.join(", ")}` }, 422);
    }
    if (startDate && resolutionDate && new Date(startDate) >= new Date(resolutionDate)) {
      return c.json({ error: "startDate harus sebelum resolutionDate" }, 422);
    }

    // ─── Outcomes default ────────────────────────────────────────
    const resolvedOutcomes: string[] | null =
      outcomes ?? (marketType === "binary" ? ["Yes", "No"] : null);

    if (marketType !== "scalar" && (!resolvedOutcomes || resolvedOutcomes.length < 2)) {
      return c.json({ error: "Minimal 2 outcomes diperlukan untuk market binary/categorical" }, 422);
    }

    // ─── Liquidity guard ─────────────────────────────────────────
    if (initialLiquidity !== undefined && Number(initialLiquidity) < 0) {
      return c.json({ error: "initialLiquidity tidak boleh negatif" }, 422);
    }
    if (minTradeSize !== undefined && Number(minTradeSize) <= 0) {
      return c.json({ error: "minTradeSize harus lebih besar dari 0" }, 422);
    }

    const slug = toSlug(question.trim());

    const [created] = await db
      .insert(generatedQuestions)
      .values({
        question: question.trim(),
        questionId: questionId?.trim() ?? question.trim(),
        slug,
        description: description ?? null,
        descriptionId: descriptionId ?? description ?? null,
        category: category ?? null,
        tags: Array.isArray(tags) ? tags : null,
        imageUrl: imageUrl ?? null,
        marketType: marketType as MarketType,
        outcomes: resolvedOutcomes,
        initialLiquidity: initialLiquidity != null ? String(initialLiquidity) : null,
        minTradeSize: minTradeSize != null ? String(minTradeSize) : null,
        startDate: startDate ? new Date(startDate) : null,
        resolutionDate: new Date(resolutionDate),
        resolutionSource: resolutionSource ?? null,
        resolutionCriteria: resolutionCriteria ?? null,
        resolutionCriteriaId: resolutionCriteriaId ?? resolutionCriteria ?? null,
        sourceArticleIds: Array.isArray(sourceArticleIds) ? sourceArticleIds : null,
        status: status as QuestionStatus,
      })
      .returning();

    if (created && me) {
      await db.insert(adminAuditLogs).values({
        adminId: Number(me.sub),
        action: "create_generated_question",
        targetResourceId: created.id,
        targetResourceType: "generated_question",
        metadata: { question: created.question, status: created.status, marketType: created.marketType },
        ipAddress: requestIp(c),
      });
    }

    return c.json({ data: created }, 201);
  },

  async updateStatus(c: Context) {
    const me = c.get("user") as TokenPayload | undefined;
    const id = Number(c.req.param("id"));
    if (!id || isNaN(id)) return c.json({ error: "ID tidak valid" }, 400);

    const body = await c.req.json().catch(() => null);
    if (!body) return c.json({ error: "Request body tidak valid (harus JSON)" }, 400);

    const { status, note } = body as { status?: string; note?: string };

    if (!status) return c.json({ error: "Field 'status' wajib diisi" }, 422);
    if (!VALID_STATUSES.includes(status as QuestionStatus)) {
      return c.json({ error: `Status tidak valid. Pilihan: ${VALID_STATUSES.join(", ")}` }, 422);
    }

    // Pastikan question ada
    const [existing] = await db
      .select({ id: generatedQuestions.id, status: generatedQuestions.status })
      .from(generatedQuestions)
      .where(eq(generatedQuestions.id, id));

    if (!existing) return c.json({ error: "Question tidak ditemukan" }, 404);

    // Guard: resolved/closed tidak bisa di-revert ke draft/pending
    const TERMINAL_STATUSES: QuestionStatus[] = ["resolved", "closed"];
    if (TERMINAL_STATUSES.includes(existing.status as QuestionStatus)) {
      return c.json({
        error: `Question dengan status '${existing.status}' tidak bisa diubah lagi`,
      }, 409);
    }

    const [updated] = await db
      .update(generatedQuestions)
      .set({
        status: status as QuestionStatus,
        updatedAt: new Date(),
        ...(status === "active" && !existing.status.includes("active")
          ? { startDate: new Date() }
          : {}),
      })
      .where(eq(generatedQuestions.id, id))
      .returning();

    if (updated && me) {
      await db.insert(adminAuditLogs).values({
        adminId: Number(me.sub),
        action: "change_generated_question_status",
        targetResourceId: id,
        targetResourceType: "generated_question",
        metadata: { from: existing.status, to: status, note: note ?? null },
        ipAddress: requestIp(c),
      });
    }

    return c.json({
      message: `Status question #${id} diubah ke '${status}'${note ? ` — ${note}` : ""}`,
      data: updated,
    });
  },

  async makePoll(c: Context) {
    const me = c.get("user") as TokenPayload;
    const id = Number(c.req.param("id"));
    if (!id || isNaN(id)) return c.json({ error: "ID tidak valid" }, 400);

    const [question] = await db.select().from(generatedQuestions).where(eq(generatedQuestions.id, id));
    if (!question) return c.json({ error: "Question tidak ditemukan" }, 404);

    const outcomes = question.outcomes ?? (question.marketType === "binary" ? ["Yes", "No"] : null);
    if (!outcomes || outcomes.length < 2) {
      return c.json({ error: "Question harus punya minimal 2 outcomes untuk dijadikan poll" }, 422);
    }

    let questionId = question.questionId ?? null;
    let descriptionId = question.descriptionId ?? null;
    let resolutionCriteriaId = question.resolutionCriteriaId ?? null;
    let optionsId = question.marketType === "binary"
      ? ["Ya", "Tidak"]
      : defaultIndonesianOutcomes(outcomes);

    const needsIndonesianBackfill =
      !questionId ||
      sameText(questionId, question.question) ||
      (question.description && (!descriptionId || sameText(descriptionId, question.description))) ||
      (question.resolutionCriteria && (!resolutionCriteriaId || sameText(resolutionCriteriaId, question.resolutionCriteria))) ||
      (question.marketType !== "binary");

    if (needsIndonesianBackfill) {
      const translated = await translateSingleQuestionToIndonesian({
        question: question.question,
        description: question.description,
        resolutionCriteria: question.resolutionCriteria,
        outcomes,
      });
      questionId = translated.questionId || questionId || question.question;
      descriptionId = translated.descriptionId || descriptionId || question.description || null;
      resolutionCriteriaId =
        translated.resolutionCriteriaId || resolutionCriteriaId || question.resolutionCriteria || null;
      if (translated.outcomesId.length === outcomes.length) {
        optionsId = translated.outcomesId;
      }
    }

    const [existingPoll] = await db
      .select({ id: polls.id })
      .from(polls)
      .where(eq(polls.title, question.question))
      .limit(1);
    if (existingPoll) {
      return c.json({ error: `Question ini sudah pernah dibuat menjadi poll #${existingPoll.id}` }, 409);
    }

    const [poll] = await db.transaction(async (tx) => {
      await tx
        .update(generatedQuestions)
        .set({
          questionId: questionId ?? question.question,
          descriptionId: descriptionId ?? question.description ?? null,
          resolutionCriteriaId: resolutionCriteriaId ?? question.resolutionCriteria ?? null,
          status: "active",
          startDate: question.startDate ?? new Date(),
          updatedAt: new Date(),
        })
        .where(eq(generatedQuestions.id, id));

      const [createdPoll] = await tx
        .insert(polls)
        .values({
          title: escapeHtml(question.question.trim()),
          titleId: escapeHtml((questionId ?? question.question).trim()),
          description: question.description ? escapeHtml(question.description) : null,
          descriptionId: descriptionId ? escapeHtml(descriptionId) : (question.description ? escapeHtml(question.description) : null),
          category: question.category ?? null,
          options: outcomes.map((outcome) => escapeHtml(outcome)),
          optionsId: optionsId.map((outcome) => escapeHtml(outcome)),
          imageUrl: question.imageUrl ?? null,
          status: "active",
          creatorId: Number(me.sub),
          aiGenerated: true,
          sourceArticleIds: Array.isArray(question.sourceArticleIds) ? question.sourceArticleIds : null,
          startAt: question.startDate ?? new Date(),
          endAt: question.resolutionDate ?? null,
          livesPerVote: 1,
          platformFeePercent: "30",
        })
        .returning();

      return [createdPoll];
    });
    if (!poll) return c.json({ error: "Gagal membuat poll" }, 500);

    await db.insert(adminAuditLogs).values({
      adminId: Number(me.sub),
      action: "make_poll_from_question",
      targetResourceId: poll.id,
      targetResourceType: "poll",
      metadata: { questionId: id, question: question.question, status: "active" },
      ipAddress: requestIp(c),
    });

    broadcastEvent("poll:created", { pollId: poll.id, questionId: id, status: "active" }, "polls");

    return c.json({
      message: `Question #${id} berhasil dibuat menjadi poll aktif #${poll.id}`,
      data: poll,
    }, 201);
  },

  async generate(c: Context) {
    const recentArticles = await db
      .select({ title: articles.title, description: articles.description })
      .from(articles)
      .orderBy(desc(articles.scrapedAt))
      .limit(30);

    const titles = recentArticles.map((a) => a.title);
    const descriptions = recentArticles.map((a) => a.description || "");

    const questions = await generateQuestions(titles, descriptions);

    for (const q of questions) {
      await db.insert(generatedQuestions).values({
        question: q.question,
        questionId: q.questionId ?? q.question,
        slug: toSlug(q.question),
        description: q.description,
        descriptionId: q.descriptionId ?? q.description,
        category: q.category,
        resolutionDate: new Date(q.resolutionDate),
        aiModel: config.openai.model,
        confidenceScore: String(q.confidenceScore),
        resolutionCriteria: q.resolutionCriteria,
        resolutionCriteriaId: q.resolutionCriteriaId ?? q.resolutionCriteria,
        status: "draft",
        marketType: "binary",
        outcomes: ["Yes", "No"],
      });
    }

    return c.json({ message: `Generated ${questions.length} questions`, data: questions });
  },
};
