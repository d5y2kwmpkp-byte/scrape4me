const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const location = process.argv[2] || "New York, NY";

(async () => {
  console.log("Scraping Dominos near: " + location);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", (route) => route.abort());

  const searchQuery = "Dominos Pizza near " + location;
  const mapsUrl = "https://www.google.com/maps/search/" + encodeURIComponent(searchQuery);

  console.log("Navigating to: " + mapsUrl);
  await page.goto(mapsUrl, { waitUntil: "networkidle", timeout: 30000 });

  await page.waitForSelector('[role="feed"]', { timeout: 15000 });
  console.log("Results loaded, scrolling...");

  const feed = await page.$('[role="feed"]');
  if (feed) {
    for (let i = 0; i < 5; i++) {
      await feed.evaluate((el) => el.scrollBy(0, 800));
      await page.waitForTimeout(1200);
    }
  }

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  await page.screenshot({ path: "data/debug.png" });
  console.log("Screenshot saved");

  const locations = await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll('[role="feed"] > div');
    items.forEach((item) => {
      const nameEl = item.querySelector(".fontHeadlineSmall");
      if (!nameEl) return;
      const name = nameEl.textContent.trim();
      if (!name.toLowerCase().includes("domino")) return;
      const linkEl = item.querySelector("a[href*='/maps/place/']");
      results.push({
        name,
        link: linkEl ? linkEl.href : null,
      });
    });
    return results;
  });

  await browser.close();
  console.log("Found " + locations.length + " locations");

  const output = {
    success: true,
    query: searchQuery,
    scrapedAt: new Date().toISOString(),
    count: locations.length,
    locations,
  };

  fs.writeFileSync(
    path.join(process.cwd(), "data/locations.json"),
    JSON.stringify(output, null, 2)
  );

  console.log("Done");
})();
