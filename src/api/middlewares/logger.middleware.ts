import type { Context, Next } from "hono";

export async function loggerMiddleware(c: Context, next: Next) {
  const start = Date.now();
  const method = c.req.method;
  const path = c.req.path;

  await next();

  const ms = Date.now() - start;
  const status = c.res.status;
  console.log(`[${new Date().toISOString()}] ${method} ${path} ${status} ${ms}ms`);
}
