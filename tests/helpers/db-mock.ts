/**
 * Creates a Proxy that mimics Drizzle ORM's chainable query builder.
 * Any method call (from(), where(), orderBy(), limit(), etc.) returns the same
 * chainable object. The chain itself is awaitable and resolves to `result`.
 */
export function makeChain(result: unknown = []) {
  const p = Promise.resolve(result);
  const chain: Record<string | symbol, unknown> = new Proxy(
    {},
    {
      get(_t, prop: string | symbol) {
        if (prop === "then") return p.then.bind(p);
        if (prop === "catch") return p.catch.bind(p);
        if (prop === "finally") return p.finally.bind(p);
        return () => chain;
      },
    },
  );
  return chain;
}

/**
 * Returns a mock db object where every method returns a configurable chain.
 * Use `(db.select as any).mockReturnValueOnce(makeChain(data))` per test.
 */
export function createMockDb() {
  const { mock } = require("bun:test") as typeof import("bun:test");
  return {
    select: mock(() => makeChain([])),
    insert: mock(() => makeChain([])),
    update: mock(() => makeChain(undefined)),
    delete: mock(() => makeChain(undefined)),
  };
}

export function createMockRedis() {
  const { mock } = require("bun:test") as typeof import("bun:test");
  return {
    get: mock(() => Promise.resolve(null)),
    set: mock(() => Promise.resolve("OK")),
    del: mock(() => Promise.resolve(1)),
    on: mock(() => {}),
  };
}
