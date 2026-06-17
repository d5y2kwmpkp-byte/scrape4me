/**
 * FlowState / TexasBuild Intel — TABS Scraper v3
 * Writes CLEAN data to tabs_projects_v2
 *
 * Key changes from v2:
 *   - Captures registration_date (the institutional signal field)
 *   - Runs every field through scraper-cleaners.js before insert
 *   - Tighter field extraction to reduce bleed at the source
 *
 * Run: node api/tabs_scraper_v3.js
 */

const fs   = require("fs");
const path = require("path");
const { buildCleanRow } = require("./scraper-cleaners.cjs");

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const SUPABASE_KEY = process.env.TEXBUILD_SUPABASE_KEY || "";

const YEAR       = 2026;
const START_NUM  = 23042;   // test range
const END_NUM    = 23033;   // TEST: just 10 records — change to 1 for full backfill
const DELAY_MS   = 300;
const BATCH_SIZE = 50;

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
    if (!res.ok) {
      const err = await res.text();
      console.log(`  [supabase] ${res.status} — ${err.slice(0, 200)}`);
    } else {
      console.log(`  [supabase] ${res.status} — ${records.length} clean records upserted`);
    }
  } catch (e) {
    console.error(`  [supabase] Error: ${e.message}`);
  }
}

/**
 * Extract a labeled field from the cleaned page text.
 * Tighter than v2 — stops at the next known label to reduce bleed.
 */
const FIELD_LABELS = [
  "Project Name", "Project Number", "Facility Name", "Location Address",
  "Location County", "Start Date", "Completion Date", "Estimated Cost",
  "Type of Work", "Type of Funds", "Scope of Work", "Square Footage",
  "Are the private funds", "Current Status", "Contact Name",
  "RAS Name", "RAS #", "RAS Address", "RAS Phone",
  "Owner Name", "Owner Address", "Owner Phone",
  "Tenant Name", "Tenant Phone",
  "Design Firm Name", "Design Firm Address", "Design Firm Phone",
  "Registration Date", "Project #",
];

function buildLabelPattern() {
  // Build alternation of all labels for lookahead boundary
  return FIELD_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");
}
const LABEL_ALT = buildLabelPattern();

function extractField(text, label) {
  const escLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  // Grab everything after "Label:" up to the next known label
  const re = new RegExp(
    escLabel + "\\s*:?\\s*(.+?)(?=\\s*(?:" + LABEL_ALT + ")\\s*:|$)",
    "i"
  );
  const m = text.match(re);
  return m ? m[1].trim() : "";
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

  if (!text.includes("Project Name") && !text.includes("TABS")) return null;
  if (text.includes("No project found") || text.includes("not found")) return null;

  const tabsId = `TABS${YEAR}${String(tabsNum).padStart(6, "0")}`;

  // Registration Date — the institutional signal field
  // Appears as: "Project #: TABS2026023042  Registration Date: 6/16/2026"
  const regMatch = text.match(/Registration Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const registrationDate = regMatch ? regMatch[1] : null;

  // Build the raw object (uncleaned — cleaners handle the scrubbing)
  const raw = {
    id:                  tabsId,
    tabs_number:         tabsId,
    project_name:        extractField(text, "Project Name"),
    facility_name:       extractField(text, "Facility Name"),
    address:             extractField(text, "Location Address"),
    county:              extractField(text, "Location County"),
    state:               "TX",
    start_date:          extractField(text, "Start Date"),
    completion_date:     extractField(text, "Completion Date"),
    estimated_cost:      extractField(text, "Estimated Cost"),
    square_footage:      extractField(text, "Square Footage"),
    type_of_work:        extractField(text, "Type of Work"),
    type_of_funds:       extractField(text, "Type of Funds"),
    scope_of_work:       extractField(text, "Scope of Work"),
    status:              extractField(text, "Current Status"),
    contact_name:        extractField(text, "Contact Name"),
    owner_name:          extractField(text, "Owner Name"),
    owner_address:       extractField(text, "Owner Address"),
    owner_phone:         extractField(text, "Owner Phone"),
    tenant_name:         extractField(text, "Tenant Name"),
    tenant_phone:        extractField(text, "Tenant Phone"),
    design_firm_name:    extractField(text, "Design Firm Name"),
    design_firm_address: extractField(text, "Design Firm Address"),
    design_firm_phone:   extractField(text, "Design Firm Phone"),
    ras_name:            extractField(text, "RAS Name"),
    ras_phone:           extractField(text, "RAS Phone"),
    project_category:    null,  // classifier runs separately
    fetched_at:          new Date().toISOString(),
  };

  // Convert reg date M/D/YYYY → YYYY-MM-DD for Postgres DATE
  let regDateISO = null;
  if (registrationDate) {
    const [m, d, y] = registrationDate.split("/");
    regDateISO = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  // Run through cleaners — returns insert-ready clean row
  const row = buildCleanRow(raw, regDateISO);

  // Add reg_month (first day of registration month) for signal bucketing
  if (regDateISO) {
    row.reg_month = regDateISO.slice(0, 7) + "-01";  // 2026-06-16 → 2026-06-01
  }

  return row;
}

(async () => {
  console.log("FlowState TABS Scraper v3 — Clean → tabs_projects_v2");
  console.log(`Range: TABS${YEAR}${String(END_NUM).padStart(6,"0")} → TABS${YEAR}${START_NUM}`);
  console.log("Capturing registration_date | running cleaners");
  console.log("─".repeat(50));

  let checked  = 0;
  let matched  = 0;
  let flagged  = 0;
  let errors   = 0;
  let pending  = [];

  for (let num = START_NUM; num >= END_NUM; num--) {
    const tabsId = `TABS${YEAR}${String(num).padStart(6, "0")}`;
    const url    = `${BASE_URL}/${tabsId}`;

    try {
      const res = await fetch(url, {
        headers: {
          "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36",
          "Accept": "text/html",
        }
      });

      checked++;
      if (res.status === 404) continue;

      const html = await res.text();
      const row  = parseProject(html, num);

      if (row && row.project_name) {
        matched++;
        if (row.cost_flag) flagged++;
        pending.push(row);

        const flag = row.cost_flag ? ` [${row.cost_flag}]` : "";
        console.log(`  ✓ ${tabsId} | ${row.county || "?"} | $${row.estimated_cost || "?"} | reg:${row.registration_date || "—"}${flag}`);

        if (pending.length >= BATCH_SIZE) {
          await upsertToSupabase(pending);
          pending = [];
          fs.mkdirSync(path.join(process.cwd(), "data"), { recursive: true });
          fs.writeFileSync(
            path.join(process.cwd(), "data", "tabs_v2_checkpoint.json"),
            JSON.stringify({ lastNum: num, matched, checked, flagged, errors }, null, 2)
          );
        }
      }

    } catch (e) {
      errors++;
      if (errors < 20) console.log(`  [error] ${tabsId}: ${e.message.slice(0, 60)}`);
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  if (pending.length) await upsertToSupabase(pending);

  console.log("\n" + "─".repeat(50));
  console.log(`✓ Done`);
  console.log(`  Checked: ${checked}`);
  console.log(`  Matched: ${matched}`);
  console.log(`  Flagged for review: ${flagged}`);
  console.log(`  Errors:  ${errors}`);
})();
