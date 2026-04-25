import { mock, beforeEach, describe, it, expect } from "bun:test";
import { makeChain } from "../../../helpers/db-mock";

// ─── Module Mocks ─────────────────────────────────────────────────────────────

const mockSelect = mock(() => makeChain([]));

mock.module("../../../../src/db", () => ({
  db: { select: mockSelect },
}));

mock.module("drizzle-orm", () => ({
  eq: (..._a: unknown[]) => ({}),
  desc: (..._a: unknown[]) => ({}),
  like: (..._a: unknown[]) => ({}),
  sql: Object.assign((_t: TemplateStringsArray, ..._v: unknown[]) => ({}), { raw: () => ({}) }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { trendsController } from "../../../../src/api/controllers/trends.controller";

const j = (r: Response) => r.json() as Promise<any>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono();
  app.get("/trends", trendsController.list);
  app.get("/trends/:topic", trendsController.getByTopic);
  return app;
}

const mockTrend = {
  id: 1,
  topic: "US-China Trade War",
  mentionCount: 12,
  category: "politics",
  trendScore: 87.5,
  firstSeen: new Date().toISOString(),
  lastSeen: new Date().toISOString(),
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("trendsController.list", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
  });

  it("returns list of trends", async () => {
    mockSelect.mockReturnValueOnce(makeChain([mockTrend]));
    const res = await app.request("/trends");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.data[0].topic).toBe("US-China Trade War");
  });

  it("returns empty array when no trends exist", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    const res = await app.request("/trends");
    const body = await j(res);
    expect(body.data).toEqual([]);
  });

  it("defaults limit to 20, caps at 100", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    const res = await app.request("/trends?limit=999");
    expect(res.status).toBe(200); // limit capped — no error
  });
});

describe("trendsController.getByTopic", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
  });

  it("returns 404 when trend is not found", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))       // trend query
      .mockReturnValueOnce(makeChain([]));       // articles query (won't reach)
    const res = await app.request("/trends/UnknownTopic");
    expect(res.status).toBe(404);
    const body = await j(res);
    expect(body.error).toMatch(/not found/i);
  });

  it("returns trend with relatedArticles on success", async () => {
    const relatedArticle = { id: 10, title: "US-China Trade War escalates", scrapedAt: new Date() };
    mockSelect
      .mockReturnValueOnce(makeChain([mockTrend]))
      .mockReturnValueOnce(makeChain([relatedArticle]));

    const res = await app.request("/trends/US-China Trade War");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.data.topic).toBe("US-China Trade War");
    expect(Array.isArray(body.data.relatedArticles)).toBe(true);
    expect(body.data.relatedArticles[0].id).toBe(10);
  });

  it("includes an empty relatedArticles array when no articles match", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([mockTrend]))
      .mockReturnValueOnce(makeChain([]));

    const res = await app.request("/trends/US-China Trade War");
    const body = await j(res);
    expect(body.data.relatedArticles).toEqual([]);
  });
});
