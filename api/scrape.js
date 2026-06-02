// api/scrape.js — Vercel Serverless Function
// Uses @sparticuz/chromium + playwright-core for serverless Playwright

import chromium from "@sparticuz/chromium";
import { chromium as playwrightChromium } from "playwright-core";

export const config = {
  maxDuration: 60, // seconds — requires Vercel Pro for >10s
};

export default async function handler(req, res) {
  res.setHeader("Access-Control-Allow-Origin", "*");
  res.setHeader("Access-Control-Allow-Methods", "GET");

  const { location = "New York, NY", radius = "5" } = req.query;

  let browser = null;

  try {
    // Launch serverless Chromium
    browser = await playwrightChromium.launch({
      args: chromium.args,
      executablePath: await chromium.executablePath(),
      headless: chromium.headless,
    });

    const context = await browser.newContext({
      userAgent:
        "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/120.0.0.0 Safari/537.36",
      viewport: { width: 1280, height: 800 },
    });

    const page = await context.newPage();

    // Block images/fonts to speed up load
    await page.route("**/*.{png,jpg,jpeg,gif,svg,woff,woff2,ttf}", (route) =>
      route.abort()
    );

    const searchQuery = `Dominos Pizza near ${location}`;
    const mapsUrl = `https://www.google.com/maps/search/${encodeURIComponent(searchQuery)}`;

    console.log("Navigating to:", mapsUrl);
    await page.goto(mapsUrl, { waitUntil: "networkidle", timeout: 30000 });

    // Wait for results sidebar
    await page.waitForSelector('[role="feed"]', { timeout: 15000 });

    // Scroll to load more results
    const feed = await page.$('[role="feed"]');
    if (feed) {
      for (let i = 0; i < 3; i++) {
        await feed.evaluate((el) => el.scrollBy(0, 800));
        await page.waitForTimeout(1000);
      }
    }

    // Extract listings
    const locations = await page.evaluate(() => {
      const results = [];
      const items = document.querySelectorAll('[role="feed"] > div');

      items.forEach((item) => {
        // Name
        const nameEl =
          item.querySelector(".fontHeadlineSmall") ||
          item.querySelector('[class*="fontHeadline"]');
        if (!nameEl) return;

        const name = nameEl.textContent?.trim();
        if (!name || !name.toLowerCase().includes("domino")) return;

        // Rating
        const ratingEl = item.querySelector('[role="img"][aria-label*="star"]');
        const rating = ratingEl
          ? ratingEl.getAttribute("aria-label")?.match(/[\d.]+/)?.[0]
          : null;

        // Address / details
        const detailEls = item.querySelectorAll(
          ".W4Efsd span:not([class*='fontBody'])"
        );
        const details = Array.from(detailEls)
          .map((el) => el.textContent?.trim())
          .filter(Boolean);

        // Hours
        const hoursEl = item.querySelector("[data-tooltip*='Hours']") ||
          item.querySelector("[aria-label*='Hours']");
        const hours = hoursEl?.textContent?.trim() || null;

        // Link
        const linkEl = item.querySelector("a[href*='/maps/place/']");
        const link = linkEl?.href || null;

        results.push({
          name,
          rating: rating ? parseFloat(rating) : null,
          details,
          hours,
          link,
        });
      });

      return results;
    });

    await browser.close();

    return res.status(200).json({
      success: true,
      query: searchQuery,
      count: locations.length,
      locations,
    });
  } catch (err) {
    if (browser) await browser.close();
    console.error("Scrape error:", err);
    return res.status(500).json({
      success: false,
      error: err.message,
      locations: [],
    });
  }
}
