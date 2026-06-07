/**
 * FlowState — TDLR TABS Project Scraper v2
 * Statewide — no county filtering
 * Captures ALL projects, ALL fund types
 * Adds fund_category: private | state | federal
 *
 * Run: node api/tabs_scraper.js
 */

const fs   = require("fs");
const path = require("path");

const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

const YEAR      = 2026;
const START_NUM = 22212;  // most recent known
const END_NUM   = 1;      // go all the way back to start of year
const DELAY_MS  = 300;    // polite delay
const BATCH_SIZE = 50;    // upsert every 50 records

const BASE_URL = "https://www.tdlr.texas.gov/TABS/Search/Project";

async function upsertToSupabase(records) {
  if (!SUPABASE_KEY) { console.log("  [supabase] No key — skipping"); return; }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/tabs_projects`, {
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

function categorizeFunds(fundsText) {
  const t = (fundsText || "").toLowerCase();
  if (t.includes("federal"))                    return "federal";
  if (t.includes("public funds") || 
      t.includes("public land"))                return "state";
  if (t.includes("privately funded"))           return "private";
  return "unknown";
}

function parseProject(html, tabsNum) {
  const text = html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  // Return null if no project data (404 page or error)
  if (!text.includes("Project Name") && !text.includes("TABS")) return null;
  if (text.includes("No project found") || text.includes("not found")) return null;

  const get = (label) => {
    const patterns = [
      new RegExp(label + "\\s*:\\s*([^|]{2,150}?)(?=\\s{2,}|[A-Z][a-z]+(?: Name| Address| Phone| Date| Cost| Number| County| Status| Work| Funds| Footage)|$)", "i"),
      new RegExp(label + "\\s*([^|]{2,100}?)(?=\\s{3,})", "i"),
    ];
    for (const re of patterns) {
      const m = text.match(re);
      if (m && m[1].trim()) return m[1].trim();
    }
    return "";
  };

  const fundsText = get("Type of Funds");
  const tabsId    = `TABS${YEAR}${String(tabsNum).padStart(6, "0")}`;

  return {
    id:                tabsId,
    tabs_number:       tabsId,
    project_name:      get("Project Name"),
    facility_name:     get("Facility Name"),
    address:           get("Location Address"),
    county:            get("Location County"),
    state:             "TX",
    start_date:        get("Start Date"),
    completion_date:   get("Completion Date"),
    estimated_cost:    get("Estimated Cost"),
    type_of_work:      get("Type of Work"),
    type_of_funds:     fundsText,
    fund_category:     categorizeFunds(fundsText),
    scope_of_work:     get("Scope of Work"),
    square_footage:    get("Square Footage"),
    status:            get("Current Status"),
    contact_name:      get("Contact Name"),
    owner_name:        get("Owner Name"),
    owner_address:     get("Owner Address"),
    owner_phone:       get("Owner Phone"),
    owner_contact:     get("Contact Name"),
    tenant_name:       get("Tenant Name"),
    tenant_phone:      get("Tenant Phone"),
    design_firm_name:  get("Design Firm Name"),
    design_firm_address: get("Design Firm Address"),
    design_firm_phone: get("Design Firm Phone"),
    ras_name:          get("RAS Name"),
    ras_number:        get("RAS #"),
    ras_phone:         get("RAS Phone"),
    source:            "TDLR_TABS",
    fetched_at:        new Date().toISOString(),
  };
}

(async () => {
  console.log("FlowState TABS Scraper v2 — Statewide");
  console.log(`Range: TABS${YEAR}${String(END_NUM).padStart(6,"0")} → TABS${YEAR}${START_NUM}`);
  console.log("No county filter — capturing everything");
  console.log("─".repeat(50));

  const results = [];
  let checked   = 0;
  let matched   = 0;
  let notFound  = 0;
  let errors    = 0;
  let pending   = [];

  for (let num = START_NUM; num >= END_NUM; num--) {
    const tabsId = `TABS${YEAR}${String(num).padStart(6, "0")}`;
    const url    = `${BASE_URL}/${tabsId}`;

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept":     "text/html",
        }
      });

      checked++;

      if (res.status === 404) {
        notFound++;
        continue;
      }

      const html    = await res.text();
      const project = parseProject(html, num);

      if (project && project.project_name) {
        matched++;
        pending.push(project);
        results.push(project);
        console.log(`  ✓ ${tabsId} | ${project.county || "?"} | ${project.project_name} | ${project.fund_category} | ${project.estimated_cost}`);

        if (pending.length >= BATCH_SIZE) {
          await upsertToSupabase(pending);
          pending = [];

          // Checkpoint
          fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
          fs.writeFileSync(
            path.join(process.cwd(), "data", "tabs_checkpoint.json"),
            JSON.stringify({ lastNum: num, matched, checked, notFound, errors }, null, 2)
          );
          console.log(`  [checkpoint] ${matched} matched / ${checked} checked`);
        }
      } else {
        notFound++;
      }

    } catch (e) {
      errors++;
      if (errors < 20) console.log(`  [error] ${tabsId}: ${e.message.slice(0, 60)}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  // Final flush
  if (pending.length) await upsertToSupabase(pending);

  // Save JSON
  fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
  fs.writeFileSync(
    path.join(process.cwd(), "data", "tabs_projects.json"),
    JSON.stringify({
      success:   true,
      source:    "TDLR_TABS",
      scrapedAt: new Date().toISOString(),
      checked,
      matched,
      notFound,
      errors,
      projects: results,
    }, null, 2)
  );

  console.log("\n" + "─".repeat(50));
  console.log(`✓ Done`);
  console.log(`  Checked: ${checked}`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Errors:  ${errors}`);
})();
