import { mock, describe, it, expect } from "bun:test";

// ─── Module Mocks ─────────────────────────────────────────────────────────────

const mockRunScrapeJob = mock(async () => {});

mock.module("../../../../src/jobs/scheduler", () => ({
  runScrapeJob: mockRunScrapeJob,
  startScheduler: mock(() => {}),
}));

// ─── Imports ──────────────────────────────────────────────────────────────────

import { Hono } from "hono";
import { scrapeController } from "../../../../src/api/controllers/scrape.controller";

const j = (r: Response) => r.json() as Promise<any>;

// ─── Tests ───────────────────────────────────────────────────────────────────

describe("scrapeController.trigger", () => {
  function makeApp() {
    const app = new Hono();
    app.post("/scrape/trigger", scrapeController.trigger);
    return app;
  }

  it("returns 200 with a trigger message", async () => {
    const res = await makeApp().request("/scrape/trigger", { method: "POST" });
    expect(res.status).toBe(200);
    const body = await j(res);
    expect(body.message).toMatch(/triggered/i);
  });

  it("fires the scrape job in the background (non-blocking)", async () => {
    mockRunScrapeJob.mockReset();
    mockRunScrapeJob.mockResolvedValue(undefined);

    const start = Date.now();
    const res = await makeApp().request("/scrape/trigger", { method: "POST" });
    const elapsed = Date.now() - start;

    // Response must be immediate — not waiting for the scrape job to finish
    expect(res.status).toBe(200);
    expect(elapsed).toBeLessThan(500); // well under any real scrape duration
    expect(mockRunScrapeJob).toHaveBeenCalled();
  });
});
