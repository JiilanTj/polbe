import { z } from "zod";
import type { Context } from "hono";

/**
 * Sanitasi HTML untuk mencegah XSS — escape karakter HTML khusus.
 * Tidak menggunakan library eksternal, cukup untuk API yang tidak render HTML langsung.
 */
export function escapeHtml(str: string): string {
  return str
    .replace(/&/g, "&amp;")
    .replace(/</g, "&lt;")
    .replace(/>/g, "&gt;")
    .replace(/"/g, "&quot;")
    .replace(/'/g, "&#x27;");
}

/**
 * Parse dan validasi request body pakai Zod schema.
 * Kembalikan data yang sudah divalidasi, atau Response error langsung.
 *
 * Usage:
 *   const body = await parseBody(c, mySchema);
 *   if (body instanceof Response) return body;
 */
export async function parseBody<T extends z.ZodTypeAny>(
  c: Context,
  schema: T,
): Promise<z.infer<T> | Response> {
  let raw: unknown;
  try {
    raw = await c.req.json();
  } catch {
    return c.json({ error: "Body tidak valid atau bukan JSON" }, 400) as Response;
  }

  const result = schema.safeParse(raw);
  if (!result.success) {
    const details = result.error.flatten().fieldErrors;
    return c.json({ error: "Validasi gagal", details }, 422) as Response;
  }

  return result.data;
}

/**
 * Parse integer dari path param / query string.
 * Kembalikan undefined kalau NaN.
 */
export function safeInt(val: unknown): number | undefined {
  const n = Number(val);
  if (!Number.isFinite(n) || isNaN(n)) return undefined;
  return Math.trunc(n);
}
