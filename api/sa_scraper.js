/**
 * FlowState — San Antonio Permit Scraper v10
 * Fix: establishes session via homepage before hitting detail pages
 * Uses single shared context with session, clears only local storage between requests
 */

const { chromium } = require("playwright");
const fs = require("fs");
const path = require("path");

const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const SEARCH_URL   = "https://aca-prod.accela.com/COSA/Cap/GlobalSearchResults.aspx?isNewQuery=yes&QueryText=Plumbing";
const HOME_URL     = "https://aca-prod.accela.com/COSA/Default.aspx";
const BASE_URL     = "https://aca-prod.accela.com/COSA";

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
    applicantName:    "",
    phone:            "",
    email:            "",
    location:         "",
    mailingAddress:   "",
    licensedProName:  "",
    licensedProPhone: "",
    licensedProLic:   "",
    ownerName:        "",
    ownerAddress:     "",
    projectDesc:      "",
  };

  // Location
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
    if (line === "Project Description:")  { section = "project";   continue; }
    if (line === "Owner:")                { section = "owner";     continue; }
    if (["Contacts:", "Payments", "Inspections", "Conditions"].includes(line)) { section = "done"; break; }

    if (skip.has(line)) continue;
    if (line.startsWith("Do not receive")) continue;
    if (line === "Mailing" || line === "Physical") continue;

    if (section === "applicant") {
      if (!data.applicantName)                          { data.applicantName  = line; }
      else if (line === "Primary Phone:" && lines[i+1]) { data.phone          = lines[i+1]; i++; }
      else if (line.includes("@") && !data.email)       { data.email          = line; }
      else if (!data.mailingAddress && line.match(/\d{5}/)) { data.mailingAddress = line; }
    }
    if (section === "licensed") {
      if (!data.licensedProName)                                { data.licensedProName  = line; }
      else if (line === "Primary Phone:" && lines[i+1])         { data.licensedProPhone = lines[i+1]; i++; }
      else if (line.match(/RMP|LIC|TICL|State /))               { data.licensedProLic   = line; }
    }
    if (section === "project" && !data.projectDesc) { data.projectDesc = line; }
    if (section === "owner") {
      if (!data.ownerName)                                      { data.ownerName    = line; }
      else if (!data.ownerAddress && line.match(/\d{5}|\d+ /)) { data.ownerAddress = line; }
    }
  }
  return data;
}

(async () => {
  console.log("FlowState SA Permit Scraper v10");
  console.log("─".repeat(50));

  const browser = await chromium.launch({
    headless: true,
    args: ["--no-sandbox", "--disable-setuid-sandbox", "--disable-dev-shm-usage", "--disable-gpu"],
  });

  // Single shared context — session persists across all requests
  const context = await browser.newContext({
    userAgent: "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 Chrome/120.0.0.0 Safari/537.36",
  });

  const permits = [];
  const permitQueue = [];

  try {
    // Establish session via homepage first
    console.log("\nEstablishing session...");
    const sessionPage = await context.newPage();
    await sessionPage.goto(HOME_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sessionPage.waitForTimeout(3000);
    console.log("Session established");

    // PASS 1: Collect permit numbers
    console.log("\nPass 1: Collecting permit numbers...");
    await sessionPage.goto(SEARCH_URL, { waitUntil: "domcontentloaded", timeout: 60000 });
    await sessionPage.waitForTimeout(4000);

    try {
      const tab = await sessionPage.$("a:has-text('Records'), span:has-text('Records')");
      if (tab) { await tab.click(); await sessionPage.waitForLoadState("domcontentloaded"); await sessionPage.waitForTimeout(2000); console.log("Records tab clicked"); }
    } catch {}

    let pageNum = 1;
    while (true) {
      let cards = await sessionPage.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
      if (!cards.length) cards = await sessionPage.$$("tr, div.recordRow");

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
        permitQueue.push({
          permitNum,
          permitDate:  lines[0] || "",
          permitType,
          description: lines[4] || "",
          status:      lines[5] || "",
        });
      }

      console.log(`  Page ${pageNum}: ${matched} permits`);
      const nextBtn = await sessionPage.$("a[id*='lbtnNext'], a:has-text('Next >')");
      if (!nextBtn || !(await nextBtn.isVisible())) break;
      await nextBtn.click();
      await sessionPage.waitForLoadState("domcontentloaded");
      pageNum++;
      await sessionPage.waitForTimeout(2000);
    }

    await sessionPage.close();
    console.log(`\nTotal: ${permitQueue.length} permits`);
    console.log("Pass 2: Fetching detail pages within established session...\n");

    // PASS 2: Open detail pages in new tabs within the SAME context (shares session cookies)
    for (const permit of permitQueue) {
      const detailUrl = `${BASE_URL}/Cap/CapDetail.aspx?altId=${encodeURIComponent(permit.permitNum)}&module=Building`;
      let detail = {};

      const detailPage = await context.newPage();
      try {
        await detailPage.goto(detailUrl, { waitUntil: "domcontentloaded", timeout: 30000 });
        await detailPage.waitForTimeout(2000);

        // Wait for Record Details section to appear
        try {
          await detailPage.waitForSelector("text=Record Details", { timeout: 5000 });
        } catch {}

        const text = await detailPage.innerText("body").catch(() => "");

        if (text.includes("Applicant:") || text.includes("Record Details")) {
          detail = parseDetail(text);
          console.log(`    + ${permit.permitNum} | ${detail.applicantName || "N/A"} | ${detail.phone || "N/A"} | owner: ${detail.ownerName || "N/A"}`);
        } else {
          console.log(`    ~ ${permit.permitNum} | no detail (page: ${text.slice(0, 80).trim().replace(/\n/g, " ")})`);
        }
      } catch (e) {
        console.log(`    [error] ${permit.permitNum}: ${e.message.slice(0, 60)}`);
      } finally {
        await detailPage.close();
      }

      const record = {
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
      };

      permits.push(record);

      if (permits.length % 10 === 0) {
        await upsertToSupabase(permits.slice(-10));
        fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
        fs.writeFileSync(path.join(process.cwd(), "data/sa_permits_checkpoint.json"), JSON.stringify(permits, null, 2));
        console.log(`  [checkpoint] ${permits.length} records`);
      }

      await new Promise(r => setTimeout(r, 500));
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
