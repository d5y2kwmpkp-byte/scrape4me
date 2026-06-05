/**
 * FlowState — San Antonio Permit Scraper v3
 * Uses global search URL directly — no form interaction needed
 * Target: aca-prod.accela.com/COSA
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL  = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY  = process.env.SUPABASE_SECRET_KEY || "";
const TARGET_TYPES  = ["MEP-GAS-PMT", "MEP-TRD-APP"];
const SEARCH_URL    = "https://aca-prod.accela.com/COSA/Cap/GlobalSearchResults.aspx?isNewQuery=yes&QueryText=Plumbing";

async function upsertToSupabase(records) {
  if (!SUPABASE_KEY) {
    console.log("  [supabase] No key — CSV only");
    return;
  }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sa_permits`, {
      method: "POST",
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer:         "resolution=merge-duplicates",
      },
      body: JSON.stringify(records),
    });
    console.log(`  [supabase] ${res.status} — ${records.length} records upserted`);
  } catch (e) {
    console.error(`  [supabase] Error: ${e.message}`);
  }
}

async function getDetail(context, detailUrl) {
  const data = { applicantName: "", phone: "", email: "", location: "", mailingAddress: "" };
  const detailPage = await context.newPage();
  try {
    await detailPage.goto(detailUrl, { timeout: 20000 });
    await detailPage.waitForLoadState("networkidle");

    const fullText = await detailPage.innerText("body");
    const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);

    // Location
    const locIdx = lines.indexOf("Location");
    if (locIdx !== -1 && lines[locIdx + 1]) data.location = lines[locIdx + 1];

    // Applicant block
    const skip = new Set(["Individual", "Business", "Organization", "Corporation"]);
    const stop = new Set(["Contacts:", "Payments", "Record Info", "Inspections"]);
    let inApplicant = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "Applicant:")                          { inApplicant = true; continue; }
      if (!inApplicant)                                   continue;
      if (stop.has(line))                                 break;
      if (skip.has(line))                                 continue;
      if (!data.applicantName)                            { data.applicantName  = line; }
      else if (line === "Primary Phone:" && lines[i+1])   { data.phone          = lines[i+1]; }
      else if (line.includes("@") && !data.email)         { data.email          = line; }
      else if (line === "Mailing" && lines[i+1])          { data.mailingAddress = lines[i+1]; break; }
    }
  } catch (e) {
    console.log(`    [detail error] ${e.message}`);
  } finally {
    await detailPage.close();
  }
  return data;
}

(async () => {
  console.log("FlowState SA Permit Scraper v3");
  console.log("Search URL:", SEARCH_URL);
  console.log("─".repeat(50));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });

  const page = await context.newPage();
  const permits = [];

  try {
    // Go directly to search results — no form needed
    console.log("\nLoading search results...");
    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Click "Records" tab to filter to permit records only
    try {
      const recordsTab = await page.$("a:has-text('Records'), span:has-text('Records')");
      if (recordsTab) {
        await recordsTab.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        console.log("Clicked Records tab");
      }
    } catch (e) {
      console.log("[warn] Records tab not found — continuing");
    }

    let pageNum = 1;

    while (true) {
      console.log(`\n  Page ${pageNum}...`);

      // Grab all result cards
      let cards = await page.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
      if (!cards.length) {
        cards = await page.$$("div.records-result, li.record-item, div[class*='record'], tr");
        console.log(`  [fallback] Found ${cards.length} elements`);
      }

      let matched = 0;
      for (const card of cards) {
        const cardText = await card.innerText().catch(() => "");
        if (!cardText.trim()) continue;

        // Filter to plumbing permit types
        if (!TARGET_TYPES.some(t => cardText.includes(t))) continue;
        matched++;

        const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
        const permitDate  = lines[0] || "";
        const permitNum   = lines[1] || "";
        const permitType  = lines[2] || "";
        const description = lines[4] || "";
        const status      = lines[5] || "";

        // Get detail link
        let detail = {};
        const linkEl = await card.$("a[href*='CapDetail'], a[href*='Cap/CapDetail'], a[href*='CapID']");
        if (linkEl) {
          const href = await linkEl.getAttribute("href");
          if (href) {
            const detailUrl = href.startsWith("http") ? href : `https://aca-prod.accela.com${href}`;
            detail = await getDetail(context, detailUrl);
            await page.waitForTimeout(750);
          }
        }

        const record = {
          id:              `sa_${permitNum}`,
          city:            "San Antonio",
          address:         `${detail.location || ""}, San Antonio, TX`,
          work_desc:       description,
          permit_num:      permitNum,
          applied_date:    permitDate,
          estimated_value: null,
          status:          status,
          source:          "SA_Accela",
          fetched_at:      new Date().toISOString(),
        };

        permits.push(record);
        console.log(`    + ${permitNum} | ${detail.applicantName || "N/A"} | ${detail.phone || "N/A"}`);

        if (permits.length % 10 === 0) {
          await upsertToSupabase(permits.slice(-10));
          fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
          fs.writeFileSync(
            path.join(process.cwd(), "data/sa_permits_checkpoint.json"),
            JSON.stringify(permits, null, 2)
          );
          console.log(`  [checkpoint] ${permits.length} records`);
        }
      }

      console.log(`  Matched ${matched} target permits on page ${pageNum}`);

      // If 0 matched, log page text for debugging
      if (matched === 0 && pageNum === 1) {
        const bodyText = await page.innerText("body").catch(() => "");
        console.log("  [debug] Page preview:", bodyText.slice(0, 500));
      }

      // Pagination
      const nextBtn = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
      if (!nextBtn || !(await nextBtn.isVisible())) {
        console.log("\n  No more pages.");
        break;
      }
      await nextBtn.click();
      await page.waitForLoadState("networkidle");
      pageNum++;
      await page.waitForTimeout(2000);
    }

  } catch (e) {
    console.error(`\n[FATAL] ${e.message}`);
  } finally {
    await browser.close();
  }

  // Final flush
  const remainder = permits.length % 10;
  if (remainder) await upsertToSupabase(permits.slice(-remainder));

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data/sa_permits.json"),
    JSON.stringify({ success: true, source: "SA_Accela", scrapedAt: new Date().toISOString(), count: permits.length, permits }, null, 2)
  );

  console.log(`\n✓ Done. ${permits.length} permits saved.`);
})();
