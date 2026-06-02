// scripts/scrape.js
// Runs in GitHub Actions — full Chromium, no timeout limits

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const location = process.argv[2] || "New York, NY";

(async () => {
  console.log(`Scraping Dominos near: ${location}`);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent:
      "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  // Block images/fonts to speed things up
  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", (route) =>
    route.abort()
  );

  const searchQuery = `Dominos Pizza near ${location}`;
  const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

  console.log("Navigating to:", mapsUrl);
  await page.goto(mapsUrl, { waitUntil: "networkidle", timeout: 30000 });

  // Wait for results sidebar
  await page.waitForSelector('[role="feed"]', { timeout: 15000 });
  console.log("Results loaded, scrolling...");

  // Scroll to load more results
  const feed = await page.$('[role="feed"]');
  if (feed) {
    for (let i = 0; i < 5; i++) {
      await feed.evaluate((el) => el.scrollBy(0, 800));
      await page.waitForTimeout(1200);
    }
  }

  // Take a screenshot for debugging
  await page.screenshot({ path: "data/debug.png", fullPage: false });
  console.log("Screenshot saved to data/debug.png");

  // Extract listings
  const locations = await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll('[role="feed"] > div');

    items.forEach((item) => {
      const nameEl =
        item.querySelector(".fontHeadlineSmall") ||
        item.querySelector('[class*="fontHeadline"]');
      if (!nameEl) return;

      const name = nameEl.textContent?.trim();
      if (!name || !name.toLowerCase().includes("domino")) return;

      const ratingEl = item.querySelector('[role="img"][aria-label*="star"]');
      const rating = ratingEl
        ? ratingEl.getAttribute("aria-label")?.match(/[\d.]+/)?.[0]
        : null;

      const detailEls = item.querySelectorAll(
        ".W4Efsd span:not([class*='fontBody'])"
      );
      const details = Array.from(detailEls)
        .map((el) => el.textContent?.trim())
        .filter(Boolean);

      const linkEl = item.querySelector("a[href*='/maps/place/']");
      const link = linkEl?.href || null;

      results.push({
        name,
        rating: rating ? parseFloat(rating) : null,
        details,
        link,
      });
    });

    return results;
  });

  await browser.close();

  console.log(`Found ${locations.length} locations`);

  // Save results
  const output = {
    success: true,
    query: searchQuery,
    scrapedAt: new Date().toISOString(),
    count: locations.length,
    locations,
  };

  // Make sure data/ directory exists
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data/locations.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("Results saved to data/locations.json");
})();
