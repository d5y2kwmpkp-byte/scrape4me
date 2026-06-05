/**
 * FlowState — San Antonio Permit Scraper v11
 * Single pass: navigate results → click each link → read detail → go back
 * Never hits detail URLs directly — all navigation flows through search session
 * Bypasses Cloudflare by behaving like a real browser
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

function parseDetail(fullText) {
  const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
  const data = {
    applicantName: "", phone: "", email: "", location: "",
    mailingAddress: "", licensedProName: "", licensedProPhone: "",
    licensedProLic: "", ownerName: "", ownerAddress: "", projectDesc: "",
  };

  const locIdx = lines.findIndex(l => l === "Location");
  if (locIdx !== -1) {
    for (let i = locIdx + 1; i < Math.min(locIdx + 5, lines.length); i++) {
      if (lines[i].length > 5 && !lines[i].includes("Record") && !lines[i].includes("Detail")) {
        data.location = lines[i]; break;
      }
    }
  }

  const skip = new Set(["Individual", "Business", "Organization", "Corporation", "Trust", "United States"]);
  let section = "";
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "Applicant:")             { section = "applicant"; continue; }
    if (line === "Licensed Professional:") { section = "licensed";  continue; }
    if (line === "Project Description:")   { section = "project";   continue; }
    if (line === "Owner:")                 { section = "owner";     continue; }
    if (["Contacts:", "Payments", "Inspections", "Conditions"].includes(line)) break;
    if (skip.has(line) || line.startsWith("Do not receive") || line === "Mailing" || line === "Physical") continue;

    if (section === "applicant") {
      if (!data.applicantName)                          { data.applicantName  = line; }
      else if (line === "Primary Phone:" && lines[i+1]) { data.phone          = lines[i+1]; i++; }
      else if (line.includes("@") && !data.email)       { data.email          = line; }
      else if (!data.mailingAddress && line.match(/\d{5}/)) { data.mailingAddress = line; }
    }
    if (section === "licensed") {
      if (!data.licensedProName)                        { data.licensedProName  = line; }
      else if (line === "Primary Phone:" && lines[i+1]) { data.licensedProPhone = lines[i+1]; i++; }
      else if (line.match(/RMP|LIC|TICL|State /))       { data.licensedProLic   = line; }
    }
    if (section === "project" && !data.projectDesc)     { data.projectDesc = line; }
    if (section === "owner") {
      if (!data.ownerName)                                       { data.ownerName    = line; }
      else if (!data.ownerAddress && line.match(/\d{5}|\d+ /))  { data.ownerAddress = line; }
    }
  }
  return data;
}

async function scrapePagePermits(page, pageNum) {
  const results = [];
  let cards = await page.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
  if (!cards.length) cards = await page.$$("tr, div.recordRow");

  for (let idx = 0; idx < cards.length; idx++) {
    const card = cards[idx];
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

    results.push({
      idx,
      permitNum,
      permitDate:  lines[0] || "",
      permitType,
      description: lines[4] || "",
      status:      lines[5] || "",
    });
  }
  return results;
}

(async () => {
  console.log("FlowState SA Permit Scraper v11");
  console.log("─".repeat(50));

  const browser = await chromium.launch({
    headless: true,
    args: [
      "--no-sandbox", "--disable-setuid-sandbox",
      "--disable-dev-shm-usage", "--disable-gpu",
      "--disable-blink-features=AutomationControlled", // hide automation flag
    ],
  });

  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/124.0.0.0 Safari/537.36",
    viewport: { width: 1280, height: 800 },
    locale: "en-US",
    timezoneId: "America/Chicago",
  });

  // Hide webdriver flag from Cloudflare detection
  await context.addInitScript(() => {
    Object.defineProperty(navigator, "webdriver", { get: () => false });
  });

  const page = await context.newPage();
  const permits = [];
  let totalProcessed = 0;

  try {
    console.log("\nLoading search results...");
    await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await page.waitForTimeout(4000);

    try {
      const tab = await page.$("a:has-text('Records'), span:has-text('Records')");
      if (tab) { await tab.click(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(2000); console.log("Records tab clicked"); }
    } catch {}

    let pageNum = 1;
    let hasMore = true;

    while (hasMore) {
      console.log(`\n  Page ${pageNum}...`);

      // Collect permit info from current page
      const pagePermits = await scrapePagePermits(page, pageNum);
      console.log(`  Found ${pagePermits.length} permits — fetching details...`);

      // For each permit, click through to detail and come back
      for (const permit of pagePermits) {
        try {
          // Re-query cards fresh each time (DOM changes after navigation)
          let cards = await page.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
          if (!cards.length) cards = await page.$$("tr, div.recordRow");

          const card = cards[permit.idx];
          if (!card) { console.log(`    [skip] ${permit.permitNum} — card not found`); continue; }

          // Find the clickable link in this card
          const link = await card.$("a");
          if (!link) { console.log(`    [skip] ${permit.permitNum} — no link`); continue; }

          // Click and wait for navigation
          await Promise.all([
            page.waitForNavigation({ waitUntil: "domcontentloaded", timeout: 20000 }),
            link.click(),
          ]);
          await page.waitForTimeout(2000);

          // Parse detail
          const text = await page.innerText("body").catch(() => "");
          const detail = parseDetail(text);

          console.log(`    + ${permit.permitNum} | ${detail.applicantName || "N/A"} | ${detail.phone || "N/A"} | ${detail.ownerName || "N/A"}`);

          permits.push({
            id:                 `sa_${permit.permitNum}`,
            city:               "San Antonio",
            address:            detail.location ? `${detail.location}, San Antonio, TX` : "",
            work_desc:          permit.description,
            permit_num:         permit.permitNum,
            applied_date:       permit.permitDate,
            estimated_value:    null,
            status:             permit.status,
            source:             "SA_Accela",
            fetched_at:         new Date().toISOString(),
            applicant_name:     detail.applicantName    || "",
            phone:              detail.phone            || "",
            email:              detail.email            || "",
            mailing_address:    detail.mailingAddress   || "",
            licensed_pro_name:  detail.licensedProName  || "",
            licensed_pro_phone: detail.licensedProPhone || "",
            licensed_pro_lic:   detail.licensedProLic   || "",
            owner_name:         detail.ownerName        || "",
            owner_address:      detail.ownerAddress     || "",
            project_desc:       detail.projectDesc      || "",
          });
          totalProcessed++;

          // Go back to results
          await page.goBack({ waitUntil: "domcontentloaded", timeout: 20000 });
          await page.waitForTimeout(1500);

          // Checkpoint
          if (permits.length % 10 === 0) {
            await upsertToSupabase(permits.slice(-10));
            fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
            fs.writeFileSync(path.join(process.cwd(), "data/sa_permits_checkpoint.json"), JSON.stringify(permits, null, 2));
            console.log(`  [checkpoint] ${permits.length} records`);
          }

        } catch (e) {
          console.log(`    [error] ${permit.permitNum}: ${e.message.slice(0, 80)}`);
          // Try to get back to results page if we errored mid-navigation
          try {
            await page.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 30000 });
            await page.waitForTimeout(3000);
            // Re-navigate to current page
            for (let p = 1; p < pageNum; p++) {
              const nb = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
              if (nb) { await nb.click(); await page.waitForLoadState("domcontentloaded"); await page.waitForTimeout(1500); }
            }
          } catch {}
          break; // skip remaining permits on this page, move to next
        }
      }

      // Move to next page
      const nextBtn = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
      if (!nextBtn || !(await nextBtn.isVisible())) {
        console.log("\n  No more pages.");
        hasMore = false;
      } else {
        await nextBtn.click();
        await page.waitForLoadState("domcontentloaded");
        pageNum++;
        await page.waitForTimeout(2000);
      }
    }

  } catch (e) {
    console.error(`\n[FATAL] ${e.message}`);
  } finally {
    await browser.close();
  }

  const remainder = permits.length % 10;
  if (remainder) await upsertToSupabase(permits.slice(-remainder));

  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data/sa_permits.json"),
    JSON.stringify({ success: true, source: "SA_Accela", scrapedAt: new Date().toISOString(), count: permits.length, permits }, null, 2)
  );

  console.log(`\n✓ Done. ${permits.length} permits saved.`);
  if (SUPABASE_KEY) console.log("✓ Records upserted to Supabase sa_permits table");
})();
