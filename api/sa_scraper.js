/**
 * FlowState — SA Permit Scraper v12
 * Step 1: Saves raw HTML of each detail page to data/permits/
 * Step 2: Run extract.js to pull fields from saved HTML files
 * 
 * No Supabase writes here — just raw HTML collection
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SEARCH_URL = "https://aca-prod.accela.com/COSA/Cap/GlobalSearchResults.aspx?isNewQuery=yes&QueryText=Plumbing";
const OUTPUT_DIR = path.join(process.cwd(), "data", "permits");

// Ensure output directory exists
fs.mkdirSync(OUTPUT_DIR, { recursive: true });

(async () => {
  console.log("FlowState SA Permit Scraper v12 — HTML Collector");
  console.log(`Saving HTML to: ${OUTPUT_DIR}`);
  console.log("─".repeat(50));

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-blink-features=AutomationControlled",
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Chicago",
  });

  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  const permitList = [];
  let savedCount = 0;
  let skippedCount = 0;

  try {
    // ── PASS 1: Collect all permit numbers ──────────────────────────────────
    console.log("\nPass 1: Collecting permit numbers...");
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);

    try {
      const tab = await page.$("a:has-text('Records'), span:has-text('Records')");
      if (tab) {
        await tab.click();
        await page.waitForLoadState("domcontentloaded");
        await page.waitForTimeout(2000);
        console.log("Records tab clicked");
      }
    } catch {}

    let pageNum = 1;
    while (true) {
      let cards = await page.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
      if (!cards.length) cards = await page.$$("tr, div.recordRow");

      let matched = 0;
      for (const card of cards) {
        const cardText = await card.innerText().catch(() => "");
        if (!cardText.trim()) continue;
        const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) continue;

        const permitNum  = lines[1] || "";
        const permitType = lines[2] || "";
        const isPlumbing = permitNum.includes("MEP-") || permitNum.includes("LSR-") ||
          permitNum.includes("INV-PLB") || permitNum.includes("26TMP") ||
          permitType.toLowerCase().includes("plumb") || permitType.toLowerCase().includes("mep");

        if (!isPlumbing) continue;
        matched++;

        permitList.push({
          permitNum,
          permitDate:  lines[0] || "",
          permitType,
          description: lines[4] || "",
          status:      lines[5] || "",
        });
      }

      console.log(`  Page ${pageNum}: ${matched} permits`);
      const nextBtn = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
      if (!nextBtn || !(await nextBtn.isVisible())) break;
      await nextBtn.click();
      await page.waitForLoadState("domcontentloaded");
      pageNum++;
      await page.waitForTimeout(2000);
    }

    // Deduplicate by permit number
    const seen = new Set();
    const uniquePermits = permitList.filter(p => {
      if (seen.has(p.permitNum)) return false;
      seen.add(p.permitNum);
      return true;
    });

    console.log(`\nTotal unique permits: ${uniquePermits.length}`);

    // Save permit list as index
    fs.writeFileSync(
      path.join(process.cwd(), "data", "permit_index.json"),
      JSON.stringify(uniquePermits, null, 2)
    );
    console.log("Saved permit_index.json");

    // ── PASS 2: Visit each permit via search result click ────────────────────
    console.log("\nPass 2: Saving detail page HTML...\n");

    for (const permit of uniquePermits) {
      const outputFile = path.join(OUTPUT_DIR, `${permit.permitNum}.html`);

      // Skip if already saved
      if (fs.existsSync(outputFile)) {
        console.log(`  [skip] ${permit.permitNum} — already saved`);
        skippedCount++;
        continue;
      }

      try {
        // Navigate to search results fresh
        await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
        await page.waitForTimeout(2000);

        // Click Records tab
        try {
          const tab = await page.$("a:has-text('Records'), span:has-text('Records')");
          if (tab) {
            await tab.click();
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1500);
          }
        } catch {}

        // Find the link for this specific permit number
        const permitLink = await page.$(`a:has-text("${permit.permitNum}")`);

        if (!permitLink) {
          console.log(`  [miss] ${permit.permitNum} — not on first page, searching...`);

          // Paginate to find it
          let found = false;
          let pNum = 1;
          while (!found && pNum <= 10) {
            const link = await page.$(`a:has-text("${permit.permitNum}")`);
            if (link) {
              found = true;
              await Promise.all([
                page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
                link.click(),
              ]);
              break;
            }
            const nb = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
            if (!nb || !(await nb.isVisible())) break;
            await nb.click();
            await page.waitForLoadState("domcontentloaded");
            await page.waitForTimeout(1500);
            pNum++;
          }

          if (!found) {
            console.log(`  [skip] ${permit.permitNum} — could not find link`);
            continue;
          }
        } else {
          // Click the link on first page
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
            permitLink.click(),
          ]);
        }

        await page.waitForTimeout(2000);

        // Save full HTML
        const html = await page.content();
        const pageText = await page.innerText("body").catch(() => "");

        // Check if we got real detail page content
        if (pageText.includes("Applicant:") || pageText.includes("Record Details") || pageText.includes("Licensed Professional")) {
          fs.writeFileSync(outputFile, html);
          savedCount++;
          console.log(`  [saved] ${permit.permitNum} (${pageText.length} chars)`);
        } else {
          // Save anyway for debugging, but flag it
          fs.writeFileSync(outputFile + ".debug.txt", pageText.slice(0, 500));
          console.log(`  [warn] ${permit.permitNum} — unexpected content: ${pageText.slice(0, 100).trim()}`);
        }

        await new Promise(r => setTimeout(r, 800));

      } catch (e) {
        console.log(`  [error] ${permit.permitNum}: ${e.message.slice(0, 80)}`);
      }
    }

  } catch (e) {
    console.error(`\n[FATAL] ${e.message}`);
  } finally {
    await browser.close();
  }

  console.log(`\n✓ Done.`);
  console.log(`  Saved:   ${savedCount} HTML files`);
  console.log(`  Skipped: ${skippedCount} already existed`);
  console.log(`  Total:   ${savedCount + skippedCount} permits processed`);
  console.log(`\nNext: run 'node api/extract.js' to pull fields from HTML`);
})();
