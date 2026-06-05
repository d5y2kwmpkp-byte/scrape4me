/**
 * FlowState — San Antonio Permit Scraper v6
 * Fix: uses page.click() on the results page link directly
 * then reads detail from same page, then navigates back
 * No eval, no postback manipulation needed
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

function parseApplicantBlock(fullText) {
  const lines = fullText.split("\n").map(l => l.trim()).filter(Boolean);
  const data = { applicantName: "", phone: "", email: "", location: "", mailingAddress: "" };

  // Location
  const locIdx = lines.findIndex(l => l === "Location");
  if (locIdx !== -1) {
    for (let i = locIdx + 1; i < Math.min(locIdx + 5, lines.length); i++) {
      if (lines[i].length > 5 && !lines[i].includes("Record")) {
        data.location = lines[i]; break;
      }
    }
  }

  // Applicant block
  const skip = new Set(["Individual", "Business", "Organization", "Corporation", "Trust"]);
  const stop = new Set(["Contacts:", "Payments", "Record Info", "Inspections", "Conditions", "Attached Files"]);
  let inApplicant = false;

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i];
    if (line === "Applicant:")                        { inApplicant = true; continue; }
    if (!inApplicant)                                 continue;
    if (stop.has(line))                               break;
    if (skip.has(line))                               continue;
    if (line.startsWith("Do not receive"))            continue;
    if (!data.applicantName)                          { data.applicantName = line; }
    else if (line === "Primary Phone:" && lines[i+1]) { data.phone = lines[i+1]; i++; }
    else if (line.includes("@") && !data.email)       { data.email = line; }
    else if (line === "Mailing" && lines[i+1])        { data.mailingAddress = lines[i+1]; break; }
  }
  return data;
}

(async () => {
  console.log("FlowState SA Permit Scraper v6");
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
  // Store all permit basic info first, then fetch details
  const permitQueue = [];

  try {
    console.log("\nLoading search results...");
    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);

    // Click Records tab
    try {
      const tab = await page.$("a:has-text('Records'), span:has-text('Records')");
      if (tab) {
        await tab.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        console.log("Records tab clicked");
      }
    } catch { console.log("[warn] Records tab not found"); }

    // PASS 1: Collect all permit basic info + row index for clicking
    let pageNum = 1;
    while (true) {
      console.log(`\n  Collecting page ${pageNum}...`);

      let cards = await page.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
      if (!cards.length) cards = await page.$$("tr, div.recordRow");

      let matched = 0;
      for (let idx = 0; idx < cards.length; idx++) {
        const card = cards[idx];
        const cardText = await card.innerText().catch(() => "");
        if (!cardText.trim()) continue;

        const lines = cardText.split("\n").map(l => l.trim()).filter(Boolean);
        if (lines.length < 3) continue;

        const permitNum  = lines[1] || "";
        const permitType = lines[2] || "";

        const isPlumbing =
          permitNum.includes("MEP-") ||
          permitNum.includes("LSR-") ||
          permitNum.includes("INV-PLB") ||
          permitNum.includes("26TMP") ||
          permitType.toLowerCase().includes("plumb") ||
          permitType.toLowerCase().includes("gas") ||
          permitType.toLowerCase().includes("mep");

        if (!isPlumbing) continue;
        matched++;

        permitQueue.push({
          pageNum,
          cardIdx: idx,
          permitDate:  lines[0] || "",
          permitNum,
          permitType,
          description: lines[4] || "",
          status:      lines[5] || "",
        });
      }

      console.log(`  Found ${matched} permits on page ${pageNum}`);

      const nextBtn = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
      if (!nextBtn || !(await nextBtn.isVisible())) break;
      await nextBtn.click();
      await page.waitForLoadState("networkidle");
      pageNum++;
      await page.waitForTimeout(2000);
    }

    console.log(`\nTotal permits found: ${permitQueue.length}`);
    console.log("Now fetching detail pages...\n");

    // PASS 2: For each permit, navigate to detail via clicking link
    // Reload search results page and paginate to each record
    let currentPage = 1;
    await page.goto(SEARCH_URL, { waitUntil: "networkidle", timeout: 30000 });
    await page.waitForTimeout(3000);
    try {
      const tab = await page.$("a:has-text('Records'), span:has-text('Records')");
      if (tab) { await tab.click(); await page.waitForLoadState("networkidle"); await page.waitForTimeout(2000); }
    } catch {}

    for (const permit of permitQueue) {
      // Navigate to the right page
      while (currentPage < permit.pageNum) {
        const nextBtn = await page.$("a[id*='lbtnNext'], a:has-text('Next >')");
        if (!nextBtn || !(await nextBtn.isVisible())) break;
        await nextBtn.click();
        await page.waitForLoadState("networkidle");
        await page.waitForTimeout(2000);
        currentPage++;
      }

      // Find and click the permit link — opens detail in same page
      let detail = {};
      try {
        let cards = await page.$$(".ACA_TabRow_Odd, .ACA_TabRow_Even, tr.ACA_TabRow_Odd, tr.ACA_TabRow_Even");
        if (!cards.length) cards = await page.$$("tr, div.recordRow");

        const card = cards[permit.cardIdx];
        if (card) {
          const link = await card.$("a");
          if (link) {
            // Open in new tab to preserve results page
            const [detailPage] = await Promise.all([
              context.waitForEvent("page"),
              link.click({ modifiers: ["Meta"] }) // Cmd+click opens new tab
            ]).catch(async () => {
              // Fallback: middle click
              return [null];
            });

            if (detailPage) {
              await detailPage.waitForLoadState("networkidle").catch(() => {});
              const text = await detailPage.innerText("body").catch(() => "");
              detail = parseApplicantBlock(text);
              await detailPage.close();
            } else {
              // Last resort: just click and go back
              await link.click();
              await page.waitForLoadState("networkidle");
              await page.waitForTimeout(1500);
              const text = await page.innerText("body").catch(() => "");
              detail = parseApplicantBlock(text);
              await page.goBack();
              await page.waitForLoadState("networkidle");
              await page.waitForTimeout(1500);
            }
          }
        }
      } catch (e) {
        console.log(`    [detail error] ${permit.permitNum}: ${e.message}`);
      }

      const record = {
        id:              `sa_${permit.permitNum}`,
        city:            "San Antonio",
        address:         detail.location ? `${detail.location}, San Antonio, TX` : "",
        work_desc:       permit.description,
        permit_num:      permit.permitNum,
        applied_date:    permit.permitDate,
        estimated_value: null,
        status:          permit.status,
        source:          "SA_Accela",
        fetched_at:      new Date().toISOString(),
        applicant_name:  detail.applicantName || "",
        phone:           detail.phone || "",
        email:           detail.email || "",
        mailing_address: detail.mailingAddress || "",
      };

      permits.push(record);
      console.log(`    + ${permit.permitNum} | ${detail.applicantName || "N/A"} | ${detail.phone || "N/A"}`);

      if (permits.length % 10 === 0) {
        await upsertToSupabase(permits.slice(-10));
        fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
        fs.writeFileSync(
          path.join(process.cwd(), "data/sa_permits_checkpoint.json"),
          JSON.stringify(permits, null, 2)
        );
        console.log(`  [checkpoint] ${permits.length} records`);
      }

      await page.waitForTimeout(500);
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
