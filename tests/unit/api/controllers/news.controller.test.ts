import { mock, beforeEach, describe, it, expect } from "bun:test";
import { makeChain } from "../../../helpers/db-mock";

// ─── Module Mocks ─────────────────────────────────────────────────────────────

const mockSelect = mock(() => makeChain([]));
const mockUpdate = mock(() => makeChain(undefined));

mock.module("../../../../src/db", () => ({
  db: { select: mockSelect, update: mockUpdate },
}));

mock.module("../../../../src/db/schema", () => ({
  articles: { id: "id", title: "title", content: "content", url: "url", source: "source", category: "category", scrapedAt: "scrapedAt" },
}));

mock.module("drizzle-orm", () => ({
  eq: (..._a: unknown[]) => ({}),
  desc: (..._a: unknown[]) => ({}),
  like: (..._a: unknown[]) => ({}),
  sql: Object.assign((_t: TemplateStringsArray, ..._v: unknown[]) => ({}), { raw: () => ({}) }),
}));

const mockScrapeContent = mock<(_url: string) => Promise<string | null>>(async (_url) => null);

mock.module("../../../../src/scrapers/content", () => ({
  scrapeArticleContent: mockScrapeContent,
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { newsController } from "../../../../src/api/controllers/news.controller";

const j = (r: Response) => r.json() as Promise<any>;

// ─── Helpers ─────────────────────────────────────────────────────────────────

function makeApp() {
  const app = new Hono();
  app.get("/news", newsController.list);
  app.get("/news/:id", newsController.getById);
  return app;
}

const mockArticle = {
  id: 1,
  title: "Bitcoin hits $100k",
  description: "Major milestone for crypto.",
  content: "Full article content here that is long enough to pass the 300 char threshold. ".repeat(5),
  url: "https://example.com/btc",
  source: "CoinDesk",
  category: "crypto",
  publishedAt: new Date().toISOString(),
  scrapedAt: new Date().toISOString(),
  sentiment: "positive",
  sentimentScore: 0.9,
};

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("newsController.list", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
  });

  it("returns paginated articles with pagination metadata", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([mockArticle]))
      .mockReturnValueOnce(makeChain([{ count: 1 }]));

    const res = await app.request("/news");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(Array.isArray(body.data)).toBe(true);
    expect(body.pagination).toBeDefined();
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.total).toBe(1);
  });

  it("defaults page=1 and limit=20", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await app.request("/news");
    const body = await j(res);
    expect(body.pagination.page).toBe(1);
    expect(body.pagination.limit).toBe(20);
  });

  it("respects query params page and limit", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await app.request("/news?page=3&limit=5");
    const body = await j(res);
    expect(body.pagination.page).toBe(3);
    expect(body.pagination.limit).toBe(5);
  });

  it("caps limit at 100", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await app.request("/news?limit=500");
    const body = await j(res);
    expect(body.pagination.limit).toBe(100);
  });

  it("returns empty data array when no articles exist", async () => {
    mockSelect
      .mockReturnValueOnce(makeChain([]))
      .mockReturnValueOnce(makeChain([{ count: 0 }]));

    const res = await app.request("/news");
    const body = await j(res);
    expect(body.data).toEqual([]);
    expect(body.pagination.total).toBe(0);
    expect(body.pagination.totalPages).toBe(0);
  });
});

describe("newsController.getById", () => {
  let app: Hono;

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
    mockUpdate.mockReset();
    mockScrapeContent.mockReset();
    mockScrapeContent.mockResolvedValue(null);
    mockUpdate.mockReturnValue(makeChain(undefined));
  });

  it("returns 404 when article does not exist", async () => {
    mockSelect.mockReturnValueOnce(makeChain([]));
    const res = await app.request("/news/999");
    expect(res.status).toBe(404);
    const body = await j(res);
    expect(body.error).toMatch(/not found/i);
  });

  it("returns article when content is sufficient", async () => {
    mockSelect.mockReturnValueOnce(makeChain([mockArticle]));
    const res = await app.request("/news/1");
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.data.id).toBe(1);
    expect(body.data.title).toBe("Bitcoin hits $100k");
  });

  it("triggers content enrichment when article content is null", async () => {
    const noContentArticle = { ...mockArticle, content: null };
    mockSelect.mockReturnValueOnce(makeChain([noContentArticle]));
    const enrichedContent = "Full enriched content ".repeat(20);
    mockScrapeContent.mockResolvedValueOnce(enrichedContent);

    const res = await app.request("/news/1");
    expect(res.status).toBe(200);
    expect(mockScrapeContent).toHaveBeenCalledWith(mockArticle.url);
  });

  it("triggers enrichment when content contains truncation marker", async () => {
    const truncatedArticle = { ...mockArticle, content: "Partial content [+1234 chars]" };
    mockSelect.mockReturnValueOnce(makeChain([truncatedArticle]));
    const res = await app.request("/news/1");
    expect(mockScrapeContent).toHaveBeenCalled();
  });

  it("triggers enrichment when content is shorter than 300 chars", async () => {
    const shortArticle = { ...mockArticle, content: "Too short." };
    mockSelect.mockReturnValueOnce(makeChain([shortArticle]));
    const res = await app.request("/news/1");
    expect(mockScrapeContent).toHaveBeenCalled();
  });
});
