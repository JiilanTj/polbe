import { mock, beforeEach, describe, it, expect } from "bun:test";
import { makeChain } from "../../../helpers/db-mock";

// ─── Module Mocks ─────────────────────────────────────────────────────────────
const mockSelect = mock(() => makeChain([]));
const mockInsert = mock(() => makeChain([]));
const mockUpdate = mock(() => makeChain([]));
const mockTransaction = mock(async (callback: any) => {
  const tx = {
    select: mockSelect,
    insert: mockInsert,
    update: mockUpdate,
  };
  return callback(tx);
});

mock.module("../../../../src/db", () => ({
  db: { 
    select: mockSelect, 
    insert: mockInsert, 
    update: mockUpdate,
    transaction: mockTransaction
  },
}));

mock.module("drizzle-orm", () => ({
  eq: (..._args: unknown[]) => ({}),
  desc: (..._args: unknown[]) => ({}),
  and: (..._args: unknown[]) => ({}),
  sql: Object.assign((_t: TemplateStringsArray, ..._v: unknown[]) => ({}), {
    raw: (..._args: unknown[]) => ({}),
  }),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────
import { Hono } from "hono";
import { meController } from "../../../../src/api/controllers/me.controller";
import { pollsController } from "../../../../src/api/controllers/polls.controller";
import type { TokenPayload } from "../../../../src/lib/jwt";

// ─── Types ────────────────────────────────────────────────────────────────────
type AppVars = { Variables: { user: TokenPayload } };
const j = (r: Response) => r.json() as Promise<any>;

// ─── Helpers ─────────────────────────────────────────────────────────────────
function makeApp() {
  const app = new Hono<AppVars>();
  
  // Routes for testing
  app.post("/subscribe", (c) => {
    c.set("user", { sub: "1", email: "u@x.com", username: "user1", role: "user" });
    return meController.subscribeContributor(c);
  });
  
  app.post("/polls", (c) => {
    c.set("user", { sub: "1", email: "u@x.com", username: "user1", role: "user" });
    return pollsController.create(c);
  });
  
  return app;
}

function jsonRequest(body: unknown) {
  return {
    method: "POST",
    headers: { "Content-Type": "application/json" },
    body: JSON.stringify(body),
  };
}

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("Contributor Flow Integration Test", () => {
  let app: ReturnType<typeof makeApp>;
  const FUTURE_DATE = new Date(Date.now() + 30 * 24 * 60 * 60 * 1000);
  const PAST_DATE = new Date(Date.now() - 24 * 60 * 60 * 1000);

  beforeEach(() => {
    app = makeApp();
    mockSelect.mockReset();
    mockInsert.mockReset();
    mockUpdate.mockReset();
    mockTransaction.mockClear();
  });

  it("STEP 1: User (non-contributor) fails to create a poll", async () => {
    // Mock user has no contributorUntil
    mockSelect.mockReturnValueOnce(makeChain([{ contributorUntil: null }]));

    const res = await app.request("/polls", jsonRequest({
      title: "Test Poll",
      options: ["A", "B"],
      category: "News"
    }));

    expect(res.status).toBe(403);
    const body = await j(res);
    expect(body.code).toBe("NOT_A_CONTRIBUTOR");
    expect(body.error).toContain("Hanya Contributor");
  });

  it("STEP 2: User subscribes to become a contributor", async () => {
    // Mock current state: user has 20 lives, not a contributor
    mockSelect.mockReturnValueOnce(makeChain([{ livesBalance: "20", contributorUntil: null }]));
    
    // Mock returning from update
    mockUpdate.mockReturnValueOnce(makeChain([{ id: 1 }]));
    mockInsert.mockReturnValueOnce(makeChain([{ id: 1 }]));

    const res = await app.request("/subscribe", jsonRequest({}));

    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.message).toContain("Berhasil upgrade");
    expect(body.data.balanceAfter).toBe(10);
    expect(new Date(body.data.contributorUntil).getTime()).toBeGreaterThan(Date.now());
  });

  it("STEP 3: User (contributor) successfully creates a poll", async () => {
    // Mock user has active contributorUntil
    mockSelect.mockReturnValueOnce(makeChain([{ contributorUntil: FUTURE_DATE }]));
    
    // Mock poll creation return
    mockInsert.mockReturnValueOnce(makeChain([{ id: 123, title: "Success Poll" }]));

    const res = await app.request("/polls", jsonRequest({
      title: "Success Poll",
      options: ["Yes", "No"],
      category: "Politics"
    }));

    expect(res.status).toBe(201);
    const body = await j(res);
    expect(body.data.title).toBe("Success Poll");
  });

  it("STEP 4: User (expired contributor) fails to create a poll", async () => {
    // Mock user has expired contributorUntil
    mockSelect.mockReturnValueOnce(makeChain([{ contributorUntil: PAST_DATE }]));

    const res = await app.request("/polls", jsonRequest({
      title: "Expired Poll",
      options: ["A", "B"],
      category: "News"
    }));

    expect(res.status).toBe(403);
    const body = await j(res);
    expect(body.code).toBe("NOT_A_CONTRIBUTOR");
  });

  it("STEP 5: User with insufficient lives fails to subscribe", async () => {
    // Mock user has only 5 lives
    mockSelect.mockReturnValueOnce(makeChain([{ livesBalance: "5", contributorUntil: null }]));

    const res = await app.request("/subscribe", jsonRequest({}));

    expect(res.status).toBe(400);
    const body = await j(res);
    expect(body.error).toContain("Nyawa tidak cukup");
  });
});
