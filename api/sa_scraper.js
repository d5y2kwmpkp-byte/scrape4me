/**
 * FlowState — San Antonio Permit Scraper v4
 * Fixes: grabs ALL plumbing records + detail page contact info
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SEARCH_URL   = "https://aca-prod.accela.com/COSA/Cap/GlobalSearchResults.aspx?isNewQuery=yes&QueryText=Plumbing";

async function upsertToSupabase(records) {
  if (!SUPABASE_KEY) { console.log("  [supabase] No key — CSV only"); return; }
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
    await detailPage.goto(detailUrl, { timeout: 20000, waitUntil: "networkidle" });

    const fullText = await detailPage.innerText("body");
    const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);

    // Location — first non-empty line after "Location"
    const locIdx = lines.findIndex(l => l === "Location");
    if (locIdx !== -1) {
      // Skip blank/short lines to get the actual address
      for (let i = locIdx + 1; i < Math.min(locIdx + 5, lines.length); i++) {
        if (lines[i].length > 5) { data.location = lines[i]; break; }
      }
    }

    // Applicant block
    const skip = new Set(["Individual", "Business", "Organization", "Corporation", "Trust"]);
    const stop = new Set(["Contacts:", "Payments", "Record Info", "Inspections", "Conditions"]);
    let inApplicant = false;

    for (let i = 0; i < lines.length; i++) {
      const line = lines[i];
      if (line === "Applicant:")                        { inApplicant = true; continue; }
      if (!inApplicant)                                 continue;
      if (stop.has(line))                               break;
      if (skip.has(line))                               continue;
      if (line === "Do not receive Email Notifications: No" || 
          line === "Do not receive Email Notifications: Yes") continue;

      if (!data.applicantName)                          { data.applicantName  = line; }
      else if (line === "Primary Phone:" && lines[i+1]) { data.phone          = lines[i+1]; i++; }
      else if (line.includes("@") && !data.email)       { data.email          = line; }
      else if (line === "Mailing" && lines[i+1])        { data.mailingAddress = lines[i+1]; break; }
    }

  } catch (e) {
    console.log(`    [detail error] ${e.message}`);
  } finally {
    await detailPage.close();
  }
  return data;
}

(async () => {
  console.log("FlowState SA Permit Scraper v4");
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
    console.log("\nLoading search results...");
    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Click Records tab
    try {
      const recordsTab = await page.$("a:has-text('Records'), span:has-text('Records')");
      if (recordsTab) {
        await recordsTab.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        console.log("Records tab clicked");
      }
    } catch { console.log("[warn] Records tab not found"); }

    let pageNum = 1;

    while (true) {
      console.log(`\n  Page ${pageNum}...`);

      // Get all result cards
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

        // Grab ALL plumbing-related permits — not just two types
        const isPlumbing = 
          permitNum.includes("MEP-GAS-PMT") ||
          permitNum.includes("MEP-TRD-APP") ||
          permitType.toLowerCase().includes("plumb") ||
          permitType.toLowerCase().includes("gas") ||
          permitType.toLowerCase().includes("mep");

        if (!isPlumbing) continue;
        matched++;

        const permitDate  = lines[0] || "";
        const description = lines[4] || "";
        const status      = lines[5] || "";

        // Find detail link — try all common Accela href patterns
        let detail = {};
        const linkEl = await card.$("a[href*='CapDetail'], a[href*='Cap/CapDetail'], a[href*='CapID'], a[href*='altId']");
        if (linkEl) {
          const href = await linkEl.getAttribute("href");
          if (href) {
            const detailUrl = href.startsWith("http") 
              ? href 
              : `https://aca-prod.accela.com${href.startsWith("/") ? "" : "/COSA/"}${href}`;
            detail = await getDetail(context, detailUrl);
            await page.waitForTimeout(750);
          }
        } else {
          // Fallback — grab first anchor in the card
          const anyLink = await card.$("a");
          if (anyLink) {
            const href = await anyLink.getAttribute("href");
            if (href && (href.includes("Cap") || href.includes("cap"))) {
              const detailUrl = href.startsWith("http") ? href : `https://aca-prod.accela.com${href}`;
              detail = await getDetail(context, detailUrl);
              await page.waitForTimeout(750);
            }
          }
        }

        const record = {
          id:              `sa_${permitNum}`,
          city:            "San Antonio",
          address:         detail.location ? `${detail.location}, San Antonio, TX` : "",
          work_desc:       description,
          permit_num:      permitNum,
          applied_date:    permitDate,
          estimated_value: null,
          status:          status,
          source:          "SA_Accela",
          fetched_at:      new Date().toISOString(),
          applicant_name:  detail.applicantName || "",
          phone:           detail.phone || "",
          email:           detail.email || "",
          mailing_address: detail.mailingAddress || "",
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

      console.log(`  Matched ${matched} permits on page ${pageNum}`);

      // Debug first page if nothing found
      if (matched === 0 && pageNum === 1) {
        const bodyPreview = await page.innerText("body").catch(() => "");
        console.log("  [debug] Page preview:", bodyPreview.slice(0, 800));
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
    JSON.stringify({
      success:   true,
      source:    "SA_Accela",
      scrapedAt: new Date().toISOString(),
      count:     permits.length,
      permits,
    }, null, 2)
  );

  console.log(`\n✓ Done. ${permits.length} permits saved.`);
  if (SUPABASE_KEY) console.log("✓ Records upserted to Supabase sa_permits table");
})();
