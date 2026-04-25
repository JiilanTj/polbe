import { mock } from "bun:test";

// cleaner.ts imports db at module level (unused in its exported fns) — mock to avoid
// attempting a real Postgres connection during test loading.
mock.module("../../../src/db", () => ({ db: {}, closeDb: () => {} }));
mock.module("../../../src/db/schema", () => ({
  articles: {},
  trends: {},
  users: {},
  generatedQuestions: {},
  polls: {},
  livesTransactions: {},
  adminAuditLogs: {},
}));

import { describe, expect, it } from "bun:test";
import { deduplicateArticles, cleanText } from "../../../src/processors/cleaner";

// ─── deduplicateArticles ────────────────────────────────────────────────────

describe("deduplicateArticles", () => {
  it("returns all items when all URLs are unique", () => {
    const items = [
      { url: "https://example.com/a", title: "A" },
      { url: "https://example.com/b", title: "B" },
      { url: "https://example.com/c", title: "C" },
    ];
    expect(deduplicateArticles(items)).toHaveLength(3);
  });

  it("removes exact duplicate URLs", () => {
    const items = [
      { url: "https://example.com/a", title: "First" },
      { url: "https://example.com/a", title: "Duplicate" },
      { url: "https://example.com/b", title: "Second" },
    ];
    const result = deduplicateArticles(items);
    expect(result).toHaveLength(2);
    expect(result[0]!.title).toBe("First"); // keeps first occurrence
  });

  it("normalises URLs to lowercase before comparing", () => {
    const items = [
      { url: "https://Example.COM/Article", title: "Original" },
      { url: "https://example.com/article", title: "Lower duplicate" },
    ];
    expect(deduplicateArticles(items)).toHaveLength(1);
  });

  it("trims whitespace from URLs before comparing", () => {
    const items = [
      { url: "  https://example.com/a  ", title: "With spaces" },
      { url: "https://example.com/a", title: "Without spaces" },
    ];
    expect(deduplicateArticles(items)).toHaveLength(1);
  });

  it("returns an empty array for empty input", () => {
    expect(deduplicateArticles([])).toEqual([]);
  });

  it("preserves all fields of surviving items", () => {
    const items = [{ url: "https://x.com/1", title: "T", source: "S", category: "C" }];
    const result = deduplicateArticles(items);
    expect(result[0]).toEqual(items[0]);
  });
});

// ─── cleanText ──────────────────────────────────────────────────────────────

describe("cleanText", () => {
  it("returns null for null input", () => {
    expect(cleanText(null)).toBeNull();
  });

  it("returns null for undefined input", () => {
    expect(cleanText(undefined)).toBeNull();
  });

  it("returns null for empty string", () => {
    expect(cleanText("")).toBeNull();
  });

  it("trims leading and trailing whitespace", () => {
    expect(cleanText("  hello world  ")).toBe("hello world");
  });

  it("collapses multiple spaces into one", () => {
    expect(cleanText("hello   world   foo")).toBe("hello world foo");
  });

  it("collapses multiple newlines (3+) into double newline", () => {
    const input = "paragraph one\n\n\n\nparagraph two";
    const result = cleanText(input);
    expect(result).not.toContain("\n\n\n");
    expect(result).toContain("paragraph one");
    expect(result).toContain("paragraph two");
  });

  it("preserves regular text content", () => {
    const text = "Bitcoin price surges 20% after ETF approval.";
    expect(cleanText(text)).toBe(text);
  });

  it("handles text with mixed whitespace characters", () => {
    const result = cleanText("word1\t\t word2  \n word3");
    expect(result).toBe("word1 word2 word3");
  });
});
