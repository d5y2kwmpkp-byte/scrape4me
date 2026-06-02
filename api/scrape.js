const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const location = process.argv[2] || "New York, NY";
const businessType = process.argv[3] || "Dominos Pizza";

(async () => {
  console.log("Searching for: " + businessType + " near " + location);

  const browser = await chromium.launch({ headless: true });
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
  });

  const page = await context.newPage();

  await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", (route) => route.abort());

  const searchQuery = businessType + " near " + location;
  const mapsUrl = "https://www.google.com/maps/search/" + encodeURIComponent(searchQuery);

  console.log("Navigating to: " + mapsUrl);
  await page.goto(mapsUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
  await page.waitForTimeout(3000);
  await page.waitForSelector('[role="feed"]', { timeout: 15000 });
  console.log("Results loaded, scrolling...");

  const feed = await page.$('[role="feed"]');
  if (feed) {
    for (let i = 0; i < 8; i++) {
      await feed.evaluate((el) => el.scrollBy(0, 800));
      await page.waitForTimeout(1200);
    }
  }

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  await page.screenshot({ path: "data/debug.png" });

  const locations = await page.evaluate(() => {
    const results = [];
    const items = document.querySelectorAll('[role="feed"] > div');

    items.forEach((item) => {
      const nameEl = item.querySelector(".fontHeadlineSmall");
      if (!nameEl) return;
      const name = nameEl.textContent.trim();
      if (!name) return;

      // Rating
      const ratingEl = item.querySelector('[role="img"][aria-label*="star"]');
      const rating = ratingEl
        ? ratingEl.getAttribute("aria-label")?.match(/[\d.]+/)?.[0]
        : null;

      // All detail spans
      const spans = Array.from(item.querySelectorAll(".W4Efsd span"))
        .map((el) => el.textContent.trim())
        .filter((t) => t && t !== "·" && t.length > 1);

      // Address — looks like "123 Main St"
      const address = spans.find((s) => /\d/.test(s) && s.includes(" ")) || null;

      // Phone — looks like "(212) 555-1234"
      const phone = spans.find((s) => /\(?\d{3}\)?[\s\-]\d{3}[\s\-]\d{4}/.test(s)) || null;

      // Website link
      const linkEl = item.querySelector("a[href*='/maps/place/']");
      const websiteEl = item.querySelector("a[href*='http']:not([href*='google'])");

      results.push({
        name,
        rating: rating ? parseFloat(rating) : null,
        address,
        phone,
        website: websiteEl ? websiteEl.href : null,
        mapsLink: linkEl ? linkEl.href : null,
      });
    });

    return results;
  });

  await browser.close();
  console.log("Found " + locations.length + " results");

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
