const { buildCleanRow } = require("./scraper-cleaners.cjs");

// ── FlowState target ──────────────────────────────────────────────
const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";

const YEAR       = 2026;

// ── BACKFILL RANGE ────────────────────────────────────────────────
// TEST SLICE FIRST: 100 projects in the middle where data exists.
// Once verified, change to START_NUM=22212, END_NUM=1 for full backfill.
const START_NUM  = 11100;
const END_NUM    = 11000;
// ──────────────────────────────────────────────────────────────────

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
const LABEL_ALT = FIELD_LABELS.map(l => l.replace(/[.*+?^${}()|[\]\\]/g, "\\$&")).join("|");

function extractField(text, label) {
  const escLabel = label.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
  const re = new RegExp(escLabel + "\\s*:?\\s*(.+?)(?=\\s*(?:" + LABEL_ALT + ")\\s*:|$)", "i");
  const m = text.match(re);
  return m ? m[1].trim() : "";
}

async function geocodeInline(address, county) {
  if (!MAPBOX_TOKEN || !address || address.trim().length < 5) return null;
  const hasState = /,?\s*TX\s+\d{5}/.test(address) || address.includes(", TX");
  const full = hasState ? address.trim() : `${address}, ${county || ""} County, TX`.replace(/\s+/g, " ").trim();
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(full)}.json?country=US&limit=1&access_token=${MAPBOX_TOKEN}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.features && data.features.length > 0) {
      const [lng, lat] = data.features[0].center;
      return { lat, lng };
    }
  } catch (e) {}
  return null;
}

async function parseProject(html, tabsNum) {
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
  const regMatch = text.match(/Registration Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i)
              || text.match(/Registration Date[^\d]{0,40}(\d{1,2}\/\d{1,2}\/\d{4})/i);
  const regIdx = text.indexOf("Registration");
  console.log(`  [debug ${tabsId}] found=${regIdx !== -1} ctx="${regIdx !== -1 ? text.slice(regIdx, regIdx + 50).replace(/"/g,"'") : "NONE"}"`);

  const registrationDate = regMatch ? regMatch[1] : null;

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
    project_category:    null,
    fetched_at:          new Date().toISOString(),
  };

  let regDateISO = null;
  if (registrationDate) {
    const [m, d, y] = registrationDate.split("/");
    regDateISO = `${y}-${m.padStart(2,"0")}-${d.padStart(2,"0")}`;
  }

  const row = buildCleanRow(raw, regDateISO);

  if (regDateISO) {
    row.reg_month = regDateISO.slice(0, 7) + "-01";
  }

  const coords = await geocodeInline(row.address, row.county);
  if (coords) {
    row.latitude    = coords.lat;
    row.longitude   = coords.lng;
    row.geocoded_at = new Date().toISOString();
  } else {
    row.geocode_failed = true;
  }

  return row;
}

(async () => {
  console.log("FlowState TABS Backfill — Clean + Geocode → tabs_projects (FlowState)");
  console.log(`Range: TABS${YEAR}${String(START_NUM).padStart(6,"0")} → TABS${YEAR}${String(END_NUM).padStart(6,"0")}`);
  console.log("─".repeat(50));

  let checked = 0, matched = 0, flagged = 0, errors = 0;
  let pending = [];

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
      const row  = await parseProject(html, num);

      if (row && row.project_name) {
        matched++;
        if (row.cost_flag) flagged++;
        pending.push(row);

        const flag = row.cost_flag ? ` [${row.cost_flag}]` : "";
        const geo  = row.latitude ? "[geo]" : "—";
        console.log(`  ok ${tabsId} | ${row.county || "?"} | $${row.estimated_cost || "?"} | reg:${row.registration_date || "—"} ${geo}${flag}`);

        if (pending.length >= BATCH_SIZE) {
          await upsertToSupabase(pending);
          pending = [];
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
  console.log(`Done. Checked:${checked} Matched:${matched} Flagged:${flagged} Errors:${errors}`);
})();
