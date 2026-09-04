const { buildCleanRow, countyToFips } = require("./flowstate-cleaners.cjs");


// ── FlowState target ──────────────────────────────────────────────
const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";

const YEAR       = 2026;
const SCAN_AHEAD = 300;   // scrape this many numbers above the current max
const RECHECK    = 20;    // re-scan this many below max (catch late edits)
const DELAY_MS   = 300;
const BATCH_SIZE = 50;

const BASE_URL = "https://www.tdlr.texas.gov/TABS/Search/Project";

// Find where the live edge is: highest tabs_number already stored.
async function getMaxNum() {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tabs_projects?select=tabs_number&order=tabs_number.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (rows && rows[0] && rows[0].tabs_number) {
      const m = rows[0].tabs_number.match(/TABS\d{4}(\d{6})/);
      if (m) return parseInt(m[1], 10);
    }
  } catch (e) { console.log(`  [maxnum] ${e.message}`); }
  return null;
}

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

// The filing has TWO "Contact Name:" fields — the RAS filer (top) and the OWNER
// contact (bottom). extractField grabs the first (RAS). This grabs the owner-section
// one, anchored after "Owner Phone", and stops cleanly at the next section header.
function extractOwnerContact(text) {
  const re = /Owner Phone\s*:?\s*.+?\bContact Name\s*:?\s*(.+?)(?=\s*(?:TENANT|OWNER|RAS|Tenant Name|Tenant Phone|Design Firm|RAS Name|Type of Work|Scope of Work|Current Status)\b|$)/is;
  const m = text.match(re);
  if (!m) return "";
  let v = m[1].trim()
    .replace(/\s+(TENANT|OWNER|RAS)\s*$/i, "")   // strip trailing section header if it bled in
    .trim();
  // drop placeholder non-contacts
  if (/not assigned/i.test(v) || /^tenant\b/i.test(v)) return "";
  return (v && v.length < 120) ? v : "";
}

// ── GEOCODE (hardened) ──────────────────────────────────────────────────
// The first geocode a project gets is the one that sticks: the cleanup pass
// only revisits rows with NO coordinates, so a wrong-but-present point written
// here is never looked at again. It has to be right or it has to be refused.
//
// Deliberately duplicated from api/geocode_texbuild.cjs and
// api/tabs_scraper_daily.cjs rather than split into a shared module — same
// reason OwnerCard is duplicated across the dossiers: a new file is another
// hand-copy step in the phone/GitHub-web workflow. Change the bbox or the
// relevance floor in ALL THREE.
const TX_BBOX = { west: -106.75, south: 25.78, east: -93.45, north: 36.55 };
const MIN_RELEVANCE = parseFloat(process.env.MIN_RELEVANCE || "0.6");

const inTexas = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= TX_BBOX.south && lat <= TX_BBOX.north &&
  lng >= TX_BBOX.west  && lng <= TX_BBOX.east;

const normCounty = s => String(s || "").replace(/\s+county\s*$/i, "").trim().toLowerCase();

async function geocodeInline(address, county) {
  if (!MAPBOX_TOKEN || !address || address.trim().length < 5) {
    return { ok: false, reason: "no token or address" };
  }
  const hasState = /,?\s*TX\s+\d{5}/.test(address) || address.includes(", TX");
  const full = hasState ? address.trim() : `${address}, ${county || ""} County, TX`.replace(/\s+/g, " ").trim();

  const url = "https://api.mapbox.com/geocoding/v5/mapbox.places/"
    + encodeURIComponent(full) + ".json"
    + "?country=US"
    // Without this a TDLR address ending in an out-of-state zip resolves out
    // of state and is stored as a success — that is how a Houston Panera
    // landed in Springfield, Missouri.
    + `&bbox=${TX_BBOX.west},${TX_BBOX.south},${TX_BBOX.east},${TX_BBOX.north}`
    + "&limit=1"
    + `&access_token=${MAPBOX_TOKEN}`;

  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `mapbox HTTP ${res.status}` };
    const data = await res.json();
    const f = data && data.features && data.features[0];
    if (!f) return { ok: false, reason: "no result inside Texas" };

    const [lng, lat] = f.center || [];
    if (!inTexas(lat, lng)) return { ok: false, reason: "result outside Texas" };

    const relevance = typeof f.relevance === "number" ? f.relevance : 0;
    if (relevance < MIN_RELEVANCE) return { ok: false, reason: "low relevance" };

    const ctx = Array.isArray(f.context) ? f.context : [];
    const pick = pfx => {
      const hit = ctx.find(c => String(c.id || "").startsWith(pfx));
      return hit ? hit.text : null;
    };
    const types = Array.isArray(f.place_type) ? f.place_type : [];
    return {
      ok: true, lat, lng, relevance,
      county: pick("district"),
      city: types.includes("place") ? f.text : pick("place"),
    };
  } catch (e) {
    return { ok: false, reason: e.message };
  }
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
  const regMatch = text.match(/Registration Date\s*:?\s*(\d{1,2}\/\d{1,2}\/\d{4})/i);
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
    owner_contact:       extractOwnerContact(text),
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

  const geo = await geocodeInline(row.address, row.county);
  if (geo.ok) {
    row.latitude       = geo.lat;
    row.longitude      = geo.lng;
    row.geocoded_at    = new Date().toISOString();
    row.geocode_failed = false;

    // TDLR's "Location County" is typed by the filer; the geocoded point is a
    // spatial answer, so it wins. This matters more here than anywhere else:
    // extract-parcels.yml selects `where t.fips = '$FIPS'`, so a DFW project
    // mislabelled Wharton is shipped to the Wharton run and can only ever
    // miss. buildCleanRow already set fips from the OLD county, so recompute.
    if (geo.county && normCounty(geo.county) !== normCounty(row.county)) {
      row.county = geo.county.replace(/\s+County\s*$/i, "").trim();
      row.fips   = countyToFips(row.county);
    }
    if (geo.city) row.city = geo.city;
  } else {
    // No coordinate rather than a wrong one, so the cleanup pass can find it
    // again and geocode_failed finally means what it says.
    row.latitude       = null;
    row.longitude      = null;
    row.geocode_failed = true;
  }

  return row;
}

(async () => {
  console.log("FlowState TABS Daily — Clean + Geocode → tabs_projects (FlowState)");

  const maxNum = await getMaxNum();
  if (maxNum === null) {
    console.log("Could not determine max TABS number — aborting.");
    process.exit(1);
  }

  const START_NUM = maxNum + SCAN_AHEAD;
  const END_NUM   = Math.max(1, maxNum - RECHECK);

  console.log(`Current max: TABS${YEAR}${String(maxNum).padStart(6,"0")}`);
  console.log(`Scanning: TABS${YEAR}${String(START_NUM).padStart(6,"0")} → TABS${YEAR}${String(END_NUM).padStart(6,"0")}`);
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
