import type { Context } from "hono";
import { runScrapeJob } from "../../jobs/scheduler";

export const scrapeController = {
  async trigger(c: Context) {
    runScrapeJob().catch((err) => console.error("[Manual Scrape] Error:", err));
    return c.json({ message: "Scrape job triggered" });
  },
};
