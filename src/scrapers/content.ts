import * as cheerio from "cheerio";

// Site-specific selectors for known sources
const SITE_SELECTORS: Record<string, string[]> = {
  "bbc.co.uk": ["[data-component='text-block']", "article p", ".ssrcss-11r1m41-RichTextComponentWrapper p"],
  "bbc.com": ["[data-component='text-block']", "article p", ".ssrcss-11r1m41-RichTextComponentWrapper p"],
  "cnn.com": [".article__content p", ".zn-body__paragraph", "[data-zone-label='body'] p", ".l-container p"],
  "aljazeera.com": [".wysiwyg p", ".article-p-wrapper p", "main article p"],
  "reuters.com": ["[data-testid='paragraph-'] p", ".article-body__content p", "article p"],
  "nytimes.com": ["section[name='articleBody'] p", ".StoryBodyCompanionColumn p", "article p"],
  "forbes.com": [".article-body p", ".body-container p"],
  "cnbc.com": [".ArticleBody-articleBody p", ".group p"],
  "apnews.com": [".RichTextStoryBody p", "article p"],
  "theguardian.com": [".article-body-commercial-selector p", ".dcr-s2gzwb p", "article p"],
  "washingtonpost.com": [".article-body p", "[data-qa='article-body'] p"],
  "yahoo.com": [".caas-body p", ".article-body p"],
};

/**
 * Get site-specific selectors based on URL domain
 */
function getSiteSelectors(url: string): string[] {
  try {
    const hostname = new URL(url).hostname.replace(/^www\./, "");
    for (const [domain, selectors] of Object.entries(SITE_SELECTORS)) {
      if (hostname.includes(domain)) return selectors;
    }
  } catch {}
  return [];
}

/**
 * Extract paragraphs from matched elements
 */
function extractParagraphs($: cheerio.CheerioAPI, selector: string): string {
  const els = $(selector);
  if (els.length === 0) return "";

  const paragraphs = els
    .map((_, el) => $(el).text().trim())
    .get()
    .filter((t) => t.length > 30)
    .join("\n\n");

  return paragraphs;
}

/**
 * Scrape full article content from a URL.
 * Uses site-specific selectors first, then falls back to generic ones.
 */
export async function scrapeArticleContent(url: string): Promise<string | null> {
  try {
    const response = await fetch(url, {
      headers: {
        "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
        "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
        "Accept-Language": "en-US,en;q=0.9",
      },
      redirect: "follow",
      signal: AbortSignal.timeout(15000),
    });

    if (!response.ok) return null;

    const html = await response.text();
    const $ = cheerio.load(html);

    // Remove noise
    $("script, style, nav, header, footer, aside, figure, figcaption, .ad, .ads, .advertisement, .social-share, .related-articles, .comments, .newsletter, .sidebar, iframe, noscript, [role='complementary'], [role='navigation']").remove();

    // 1. Try site-specific selectors first
    const siteSelectors = getSiteSelectors(url);
    for (const selector of siteSelectors) {
      const text = extractParagraphs($, selector);
      if (text.length > 200) return text;
    }

    // 2. Try generic article selectors
    const genericSelectors = [
      "[itemprop='articleBody'] p",
      "[data-testid='article-body'] p",
      "article .article-body p",
      "article .story-body p",
      "article .post-content p",
      "article .entry-content p",
      ".article-content p",
      ".article-body p",
      ".story-body__inner p",
      ".post-body p",
      ".entry-content p",
      ".content-body p",
      ".article__body p",
      ".wysiwyg p",
    ];

    for (const selector of genericSelectors) {
      const text = extractParagraphs($, selector);
      if (text.length > 200) return text;
    }

    // 3. Try broader selectors
    for (const selector of ["article p", "main p", "[role='main'] p"]) {
      const text = extractParagraphs($, selector);
      if (text.length > 200) return text;
    }

    // 4. Last resort: all <p> tags with decent length
    const allParagraphs = $("body p")
      .map((_, p) => $(p).text().trim())
      .get()
      .filter((t) => t.length > 50)
      .join("\n\n");

    if (allParagraphs.length > 200) return allParagraphs;

    return null;
  } catch (error) {
    console.error(`[Scraper] Failed to scrape content from ${url}:`, error instanceof Error ? error.message : error);
    return null;
  }
}
