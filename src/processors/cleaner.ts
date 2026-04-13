import { db } from "../db";
import { articles } from "../db/schema";
import { eq, desc, sql } from "drizzle-orm";

/**
 * Deduplicate articles by checking URL existence.
 * Returns only new articles that don't exist in DB.
 */
export function deduplicateArticles<T extends { url: string }>(items: T[]): T[] {
  const seen = new Set<string>();
  return items.filter((item) => {
    const normalized = item.url.toLowerCase().trim();
    if (seen.has(normalized)) return false;
    seen.add(normalized);
    return true;
  });
}

/**
 * Clean article text: trim whitespace, remove excessive newlines
 */
export function cleanText(text: string | null | undefined): string | null {
  if (!text) return null;
  return text
    .replace(/\s+/g, " ")
    .replace(/\n{3,}/g, "\n\n")
    .trim();
}
