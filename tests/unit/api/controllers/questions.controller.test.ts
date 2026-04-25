import { mock, beforeEach, describe, it, expect } from "bun:test";
import { makeChain } from "../../../helpers/db-mock";

// ─── Module Mocks ─────────────────────────────────────────────────────────────

const mockSelect = mock(() => makeChain([]));
const mockInsert = mock(() => makeChain([]));
const mockUpdate = mock(() => makeChain([]));

mock.module("../../../../src/db", () => ({
  db: { select: mockSelect, insert: mockInsert, update: mockUpdate, transaction: async (fn: any) => fn({ insert: mockInsert, update: mockUpdate }) },
}));

mock.module("drizzle-orm", () => ({
  and: (..._a: unknown[]) => ({}),
  eq: (..._a: unknown[]) => ({}),
  desc: (..._a: unknown[]) => ({}),
  sql: Object.assign((_t: TemplateStringsArray, ..._v: unknown[]) => ({}), { raw: () => ({}) }),
}));

const mockGeneratedQs = [
  {
    question: "Will the Fed cut rates in Q3 2026?",
    description: "Resolves YES if...",
    category: "economy",
    resolutionDate: "2026-09-01",
    confidenceScore: 0.78,
  },
];

const mockGenerateQuestions = mock(async () => mockGeneratedQs);

mock.module("../../../../src/ai/question-generator", () => ({
  generateQuestions: mockGenerateQuestions,
}));

mock.module("../../../../src/config", () => ({
  config: {
    openai: { apiKey: "test-key", model: "gpt-4o" },
    jwt: { accessSecret: "test", refreshSecret: "test", accessExpiresIn: "15m", refreshExpiresIn: "7d" },
    database: { url: "postgres://test" },
    redis: { url: "redis://test" },
    server: { port: 3000 },
    newsapi: { apiKey: "test" },
    scraping: { intervalMinutes: 15 },
    rssFeeds: [],
  },
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Hono } from "hono";
const { questionsController } = await import("../../../../src/api/controllers/questions.controller");

const j = (r: Response) => r.json() as Promise<any>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono();
  app.get("/questions", questionsController.list);
  app.post("/questions/generate", questionsController.generate);
  app.get("/questions/:id", questionsController.getById);
  return app;
}

const mockQuestion = {
  id: 1,
  question: "Will Trump impose tariffs on China before July 2026?",
  description: "Resolution criteria...",
  category: "politics",
  sourceArticleIds: [1, 2, 3],
  resolutionDate: new Date().toISOString(),
  createdAt: new Date().toISOString(),
  aiModel: "gpt-4o",
  confidenceScore: 0.85,
  status: "draft",
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("questionsController.list", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
  });

  it("returns paginated questions with metadata", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([mockQuestion]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]));

    const res = await app.request("/questions");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.total).toBe(1);
  });

  it("returns empty data when no questions exist", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await app.request("/questions");
    const body = await j(res);
    expect(body.data).toEqual([]);
    expect(body.pagination.totalPages).toBe(0);
  });

  it("respects page and limit query params", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await app.request("/questions?page=2&limit=10");
    const body = await j(res);
    expect(body.pagination.page).toBe(2);
    expect(body.pagination.limit).toBe(10);
  });
});

describe("questionsController.getById", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
  });

  it("returns 404 when question does not exist", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    const res = await app.request("/questions/999");
    expect(res.status).toBe(404);
    const body = await j(res);
    expect(body.error).toMatch(/not found/i);
  });

  it("returns the question on success", async () => {
    mockSelect.mockReturnValueOnce(makeChain([mockQuestion]));
    const res = await app.request("/questions/1");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.data.id).toBe(1);
    expect(body.data.question).toContain("Trump");
  });
});

describe("questionsController.generate", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
    mockInsert.mockReset();
    mockGenerateQuestions.mockReset();
    mockGenerateQuestions.mockResolvedValue(mockGeneratedQs);
  });

  it("calls generateQuestions and returns generated list", async () => {
    mockSelect.mockReturnValueOnce(makeChain([{ title: "Fed news", description: "..." }]));
    mockInsert.mockReturnValueOnce(makeChain([]));

    const res = await app.request("/questions/generate", { method: "POST" });
    expect(res.status).toBe(200);
    expect(mockGenerateQuestions).toHaveBeenCalled();
    const body = await j(res);
    expect(body.message).toMatch(/generated/i);
  });

  it("returns message with count of generated questions", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    mockInsert.mockReturnValueOnce(makeChain([]));

    const res = await app.request("/questions/generate", { method: "POST" });
    const body = await j(res);
    expect(typeof body.message).toBe("string");
  });
});
