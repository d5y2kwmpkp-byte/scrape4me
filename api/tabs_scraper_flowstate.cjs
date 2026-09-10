const { buildCleanRow } = require("./flowstate-cleaners.cjs");

// ── IPv4 ONLY ─────────────────────────────────────────────────────
// A run scanning 621 numbers returned 621 "fetch failed" and 0 checked, while
// the same pages loaded fine from a phone. "fetch failed" is Node's generic
// wrapper — the real reason sits in err.cause, which this script was throwing
// away (fixed below).
//
// The likeliest cause is Happy Eyeballs: GitHub runners have IPv6, Node 20
// tries AAAA first, and if the host's IPv6 path is unreachable every connection
// dies instantly — which matches the first request failing 0.24s in. Pinning
// resolution to IPv4 removes that whole class of failure and costs nothing if
// IPv6 was never the problem.
require("dns").setDefaultResultOrder("ipv4first");


// ── FlowState target ──────────────────────────────────────────────
const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";

// ── TABS SERIES YEAR ──────────────────────────────────────────────
// This was hardcoded to 2026 and that silently stopped the scraper dead.
//
// TDLR numbers projects TABS<fiscal-year><6 digits>, and the TEXAS FISCAL YEAR
// STARTS SEPTEMBER 1. On 2026-08-31 the TABS2026 series closed at 029290; on
// 2026-09-01 filings resumed at TABS2027000001. With YEAR pinned to 2026 the
// scanner kept probing TABS2026029291 upward — numbers that will never exist —
// so every filing from Sept 1 onward was invisible. It looked like TDLR had
// simply gone quiet.
//
// Derived from the clock now, so the rollover happens by itself every year.
// Override with YEAR=2026 in the environment to backfill an old series.
function fiscalYear(d = new Date()) {
  // Sept (month index 8) onward belongs to the NEXT fiscal year.
  return d.getUTCMonth() >= 8 ? d.getUTCFullYear() + 1 : d.getUTCFullYear();
}
const YEAR       = parseInt(process.env.YEAR || "", 10) || fiscalYear();
// How long after a rollover to keep sweeping the previous series. Registrations
// filed in late August can appear days later, and without this they would be
// stranded in a series nothing scans any more.
const PREV_TAIL_DAYS = 60;

const SCAN_AHEAD = 300;   // scrape this many numbers above the current max
const RECHECK    = 20;    // re-scan this many below max (catch late edits)
const DELAY_MS   = 300;
const COLD_ABORT = 25;    // consecutive failures that mean the path is dead
const BATCH_SIZE = 50;

const BASE_URL = "https://www.tdlr.texas.gov/TABS/Search/Project";

// One header set, shared by the preflight and the scan loop. A bare UA is
// enough for most sites, but government WAFs commonly reject requests whose
// headers are inconsistent with a real browser, so send the full set.
const BROWSER_HEADERS = {
  "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 (KHTML, like Gecko) Chrome/126.0 Safari/537.36",
  "Accept": "text/html,application/xhtml+xml,application/xml;q=0.9,*/*;q=0.8",
  "Accept-Language": "en-US,en;q=0.9",
  "Connection": "keep-alive",
  "Upgrade-Insecure-Requests": "1",
};

// Find the live edge WITHIN ONE SERIES: highest tabs_number stored for `year`.
// The old version took the global max and stripped the year, so right after a
// rollover it returned 029290 (a TABS2026 number) and the scanner started at
// TABS2027029291 — 29,000 numbers past anything that exists.
//
// Returns 0 when the series has no rows yet, which is the correct starting
// point for a brand-new fiscal year: scan 1 → SCAN_AHEAD.
async function getMaxNum(year) {
  try {
    const res = await fetch(
      `${SUPABASE_URL}/rest/v1/tabs_projects?select=tabs_number`
      + `&tabs_number=like.TABS${year}*&order=tabs_number.desc&limit=1`,
      { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
    );
    const rows = await res.json();
    if (rows && rows[0] && rows[0].tabs_number) {
      const m = rows[0].tabs_number.match(new RegExp(`TABS${year}(\\d{6})`));
      if (m) return parseInt(m[1], 10);
    }
    return 0;                     // series not started yet — begin at 1
  } catch (e) { console.log(`  [maxnum] ${e.message}`); }
  return null;                    // network/auth failure — abort, do not guess
}

// Sept 1 of the fiscal year that `year` labels (FY2027 begins 2026-09-01).
const fyStart = year => Date.UTC(year - 1, 8, 1);
const daysSinceRollover = year => (Date.now() - fyStart(year)) / 86400000;

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

// `year` must be passed explicitly. It used to close over the global YEAR,
// which was harmless while only one series was ever scanned — but during the
// rollover grace window that would stamp a TABS2026 page with a TABS2027
// number and write a project that does not exist.
async function parseProject(html, tabsNum, year) {
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

  const tabsId = `TABS${year}${String(tabsNum).padStart(6, "0")}`;
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

// Prove we can reach TDLR at all before burning 19 minutes on 621 failures.
// A 404 is a SUCCESS here — it means the connection completed and the server
// answered. Only a thrown error means the network path is broken.
async function preflight() {
  const url = `${BASE_URL}/TABS${YEAR}000001`;
  for (let a = 1; a <= 3; a++) {
    try {
      const res = await fetch(url, { headers: BROWSER_HEADERS });
      // 200 = a real page, 404 = that number does not exist. Both prove the
      // path works. 403/429/503 mean the server is answering but refusing us —
      // a WAF block or throttle — and every page in the scan would fail the
      // same way, so stop now rather than logging hundreds of empty checks.
      if (res.status === 200 || res.status === 404) {
        console.log(`  ✔ reachable — TDLR answered HTTP ${res.status}`);
        return true;
      }
      console.log(`  ✗ attempt ${a}: HTTP ${res.status} — server is up but refusing this client`);
      if (a < 3) await new Promise(r => setTimeout(r, 5000));
      continue;
    } catch (e) {
      const why = e?.cause?.code || e?.cause?.message || e.message;
      console.log(`  ✗ attempt ${a}: ${why}`);
      if (a < 3) await new Promise(r => setTimeout(r, 5000));
    }
  }
  return false;
}

(async () => {
  console.log("FlowState TABS Daily — Clean + Geocode → tabs_projects (FlowState)");

  if (!(await preflight())) {
    console.error("ABORT: cannot reach tdlr.texas.gov. Nothing scanned, nothing written.");
    process.exit(1);
  }

  const maxNum = await getMaxNum(YEAR);
  if (maxNum === null) {
    console.log("Could not determine max TABS number — aborting.");
    process.exit(1);
  }

  // Build the scan list. Normally one series; for PREV_TAIL_DAYS after a
  // rollover, the previous one too, so late-published August filings are not
  // stranded in a series nothing looks at any more.
  const windows = [];
  const START_NUM = maxNum + SCAN_AHEAD;
  const END_NUM   = Math.max(1, maxNum - RECHECK);
  windows.push({ year: YEAR, from: START_NUM, to: END_NUM });

  const sinceRollover = daysSinceRollover(YEAR);
  if (sinceRollover >= 0 && sinceRollover <= PREV_TAIL_DAYS) {
    const prevMax = await getMaxNum(YEAR - 1);
    if (prevMax) {
      windows.push({ year: YEAR - 1, from: prevMax + SCAN_AHEAD, to: Math.max(1, prevMax - RECHECK) });
    }
  }

  console.log(`Fiscal year: TABS${YEAR} (day ${Math.floor(sinceRollover)} of FY)`);
  console.log(`Current max: ${maxNum ? `TABS${YEAR}${String(maxNum).padStart(6,"0")}` : "(series not started)"}`);
  for (const w of windows) {
    console.log(`Scanning: TABS${w.year}${String(w.from).padStart(6,"0")} → TABS${w.year}${String(w.to).padStart(6,"0")}`);
  }
  console.log("─".repeat(50));

  let checked = 0, matched = 0, flagged = 0, errors = 0, coldRun = 0;
  let pending = [];

  const plan = [];
  for (const w of windows) for (let n = w.from; n >= w.to; n--) plan.push({ year: w.year, num: n });

  for (const step of plan) {
    const num    = step.num;
    const tabsId = `TABS${step.year}${String(num).padStart(6, "0")}`;
    const url    = `${BASE_URL}/${tabsId}`;

    try {
      // Retry transient connection failures instead of recording the number as
      // checked-and-empty. Three attempts with a widening gap, then give up on
      // this one and let the catch below decide whether the path is dead.
      let res = null, lastWhy = "";
      for (let a = 1; a <= 3; a++) {
        try { res = await fetch(url, { headers: BROWSER_HEADERS }); break; }
        catch (e) {
          lastWhy = e?.cause?.code || e?.cause?.message || e.message;
          if (a < 3) await new Promise(r => setTimeout(r, 2000 * a));
        }
      }
      if (!res) throw new Error(lastWhy);

      checked++;
      coldRun = 0;
      if (res.status === 404) continue;

      const html = await res.text();
      const row  = await parseProject(html, num, step.year);

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
      coldRun++;
      // e.message is always the useless "fetch failed"; the real code lives in
      // e.cause (ENOTFOUND, ECONNREFUSED, UND_ERR_CONNECT_TIMEOUT, ...). The
      // old line logged the wrapper and threw the diagnosis away.
      const why = e?.cause?.code || e?.cause?.message || e.message;
      if (errors < 20) console.log(`  [error] ${tabsId}: ${String(why).slice(0, 60)}`);
      // A long unbroken run of failures is a dead network path, not 25 bad
      // pages. Stop rather than spending twenty minutes proving it.
      if (coldRun >= COLD_ABORT) {
        console.error(`ABORT: ${coldRun} consecutive failures (${why}) — TDLR unreachable.`);
        break;
      }
    }

    await new Promise(r => setTimeout(r, DELAY_MS));
  }

  if (pending.length) await upsertToSupabase(pending);

  console.log("\n" + "─".repeat(50));
  console.log(`Done. Checked:${checked} Matched:${matched} Flagged:${flagged} Errors:${errors}`);
})();
