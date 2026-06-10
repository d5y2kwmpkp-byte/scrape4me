/**
 * FlowState — ESBD Test Scraper
 * Just fetches the awards page and dumps raw content
 * Run: node api/esbd_test.js
 * Purpose: see what data structure comes back before building full scraper
 */

const fs   = require("fs");
const path = require("path");

const URLS = [
  // Awards without solicitation
  "https://www.txsmartbuy.gov/esbdawards",
  // Solicitations filtered to construction
  "https://www.txsmartbuy.gov/esbd?keyword=construction&status=Awarded",
  // Direct awards search
  "https://www.txsmartbuy.gov/esbd?tab=awards&keyword=plumbing",
];

(async () => {
  console.log("ESBD Test Scraper — Checking what loads");
  console.log("─".repeat(50));

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });

  for (const url of URLS) {
    console.log(`\nFetching: ${url}`);
    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/124.0.0.0 Safari/537.36",
          "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
          "Accept-Language": "en-US,en;q=0.5",
        }
      });

      console.log(`  Status: ${res.status}`);
      console.log(`  Content-Type: ${res.headers.get("content-type")}`);

      const text = await res.text();
      console.log(`  Length: ${text.length} chars`);
      console.log(`  Preview: ${text.slice(0, 300).replace(/\s+/g, " ").trim()}`);

      // Save full response for inspection
      const filename = url.replace(/[^a-z0-9]/gi, "_").slice(0, 50) + ".html";
      fs.writeFileSync(path.join(process.cwd(), "data", filename), text);
      console.log(`  Saved to data/${filename}`);

    } catch (e) {
      console.log(`  Error: ${e.message}`);
    }
  }

  console.log("\nDone — check data/ folder for raw HTML files");
})();
