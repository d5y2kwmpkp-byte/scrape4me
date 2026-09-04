// api/geocode_texbuild.cjs
// TexasBuild Intel — geocode fill + repair
//
// ── WHY THIS FILE CHANGED ─────────────────────────────────────────────────
// v1 accepted whatever Mapbox returned first. Three consequences, all visible
// in the data:
//
//   1. OUT OF STATE. `country=US` was set; a Texas bounding box was not. TABS
//      2026029128 ("Panera NW Freeway") carries two addresses glued together
//      by TDLR ending in zip 65804 — a Springfield, Missouri zip — so Mapbox
//      dutifully returned 37.178, -93.227 and it was stored as a success.
//      A bbox makes that query return nothing, which is the correct answer.
//
//   2. geocode_failed MEANT NOTHING. It was written `false` on every success
//      and never written at all on failure, so it recorded "Mapbox replied",
//      not "the coordinates are right". A wrong answer scored the same as a
//      right one and nothing downstream could tell them apart.
//
//   3. NO COUNTY CHECK. TDLR's "Location County" is typed by the filer and is
//      wrong often enough to matter — a Huntsville project filed as Waller, a
//      DFW project filed as Wharton. county drives fips, and fips decides
//      which county's parcel extract a project ships to, so a bad label means
//      the project is compared against the wrong county's parcels and can
//      only ever miss. Mapbox returns the county of the point it resolved;
//      that is a spatial answer and beats the typed one.
//
// Also fixed: the paging bug. v1 filtered `latitude=is.null` and walked
// offset 0, 1000, 2000 — but rows leave that filter as they succeed, so the
// result set shrank under the cursor and every page after the first skipped
// roughly as many rows as the previous page had just fixed. It now holds
// offset at 0 and stops when a page returns nothing new.
//
// env: TEXBUILD_SUPABASE_KEY, MAPBOX_TOKEN
//      MODE          fill (default) | verify
//                      fill   — rows with no coordinates
//                      verify — rows whose coordinates are outside Texas
//      LIMIT         max rows this run (default 5000)
//      DRY_RUN       1 = report only, write nothing
//      FIX_LOCATION  1 = correct county/city from the geocode (default 1)
//      MIN_RELEVANCE Mapbox relevance floor (default 0.6)

const SUPABASE_URL  = "https://yoqcvjqojklemhxwvgby.supabase.co";
const SUPABASE_KEY  = process.env.TEXBUILD_SUPABASE_KEY || "";
const MAPBOX_TOKEN  = process.env.MAPBOX_TOKEN || "";
const MODE          = (process.env.MODE || "fill").toLowerCase();
const LIMIT         = Math.max(1, parseInt(process.env.LIMIT || "5000", 10));
const DRY           = process.env.DRY_RUN === "1";
const FIX_LOCATION  = process.env.FIX_LOCATION !== "0";
const MIN_RELEVANCE = parseFloat(process.env.MIN_RELEVANCE || "0.6");

const PAGE_SIZE = 500;
// Mapbox geocoding v5 allows 600 req/min. v1 slept 50ms (1200/min) and would
// have been throttled on any large run.
const DELAY_MS  = 150;

// Texas, generously. West of El Paso, east of Orange, south of Brownsville,
// north of the Panhandle. Anything outside this is not a Texas project.
const TX_BBOX = { west: -106.75, south: 25.78, east: -93.45, north: 36.55 };

const SB = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
};

const sleep = ms => new Promise(r => setTimeout(r, ms));
const inTexas = (lat, lng) =>
  Number.isFinite(lat) && Number.isFinite(lng) &&
  lat >= TX_BBOX.south && lat <= TX_BBOX.north &&
  lng >= TX_BBOX.west  && lng <= TX_BBOX.east;

const normCounty = s => String(s || "")
  .replace(/\s+county\s*$/i, "")
  .trim()
  .toLowerCase();

// ── mapbox ────────────────────────────────────────────────────────────────
// Returns { ok, lat, lng, relevance, county, city, region, reason }.
// ok=false means DO NOT STORE — the caller marks the row failed instead of
// writing a coordinate it cannot stand behind.
async function geocodeOne(address, county) {
  if (!address || address.trim().length < 5) {
    return { ok: false, reason: "address too short" };
  }
  const hasState = /,?\s*TX\s+\d{5}/.test(address) || address.includes(", TX");
  const full = hasState
    ? address.trim()
    : `${address}, ${county || ""} County, TX`.replace(/\s+/g, " ").trim();

  const url = "https://api.mapbox.com/geocoding/v5/mapbox.places/"
    + encodeURIComponent(full) + ".json"
    + "?country=US"
    // THE FIX. bbox constrains the search to Texas, so an address that only
    // resolves out of state comes back empty rather than plausible-and-wrong.
    + `&bbox=${TX_BBOX.west},${TX_BBOX.south},${TX_BBOX.east},${TX_BBOX.north}`
    + "&limit=1"
    + `&access_token=${MAPBOX_TOKEN}`;

  let data;
  try {
    const res = await fetch(url);
    if (!res.ok) return { ok: false, reason: `mapbox HTTP ${res.status}` };
    data = await res.json();
  } catch (e) {
    return { ok: false, reason: `mapbox error: ${e.message}` };
  }

  const f = data && data.features && data.features[0];
  if (!f) return { ok: false, reason: "no result inside Texas" };

  const [lng, lat] = f.center || [];
  if (!inTexas(lat, lng)) return { ok: false, reason: "result outside Texas" };

  const relevance = typeof f.relevance === "number" ? f.relevance : 0;
  if (relevance < MIN_RELEVANCE) {
    return { ok: false, reason: `relevance below ${MIN_RELEVANCE}` };
  }

  // Mapbox context: district = county, place = city, region = state.
  const ctx = Array.isArray(f.context) ? f.context : [];
  const pick = pfx => {
    const hit = ctx.find(c => String(c.id || "").startsWith(pfx));
    return hit ? hit.text : null;
  };
  const types = Array.isArray(f.place_type) ? f.place_type : [];

  return {
    ok: true,
    lat, lng, relevance,
    county: pick("district"),
    city: types.includes("place") ? f.text : pick("place"),
    region: pick("region"),
    reason: null,
  };
}

// ── supabase ──────────────────────────────────────────────────────────────
async function fetchPage() {
  const cols = "select=id,address,county,city,latitude,longitude";
  let filter;
  if (MODE === "verify") {
    // Only rows already carrying coordinates that fall outside Texas. Cheap,
    // precise, and exactly the class the bbox now prevents from being created.
    filter = "&latitude=not.is.null"
      + `&or=(latitude.lt.${TX_BBOX.south},latitude.gt.${TX_BBOX.north},`
      + `longitude.lt.${TX_BBOX.west},longitude.gt.${TX_BBOX.east})`;
  } else {
    filter = "&latitude=is.null";
  }
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?${cols}${filter}&order=id.desc&limit=${PAGE_SIZE}`,
    { headers: SB }
  );
  if (!res.ok) throw new Error(`read ${res.status}: ${(await res.text()).slice(0, 200)}`);
  return res.json();
}

async function patch(id, body) {
  if (DRY) return true;
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: { ...SB, "Content-Type": "application/json", Prefer: "return=minimal" },
      body: JSON.stringify(body),
    }
  );
  if (!res.ok) console.log(`  [patch ${id}] ${res.status} ${(await res.text()).slice(0, 120)}`);
  return res.ok;
}

// ── main ──────────────────────────────────────────────────────────────────
(async () => {
  console.log("TexasBuild Intel — Geocode " + (MODE === "verify" ? "Repair" : "Fill"));
  console.log("─".repeat(58));
  if (!SUPABASE_KEY || !MAPBOX_TOKEN) {
    console.error("Missing TEXBUILD_SUPABASE_KEY or MAPBOX_TOKEN");
    process.exit(1);
  }
  console.log(`  bbox ${TX_BBOX.west},${TX_BBOX.south} → ${TX_BBOX.east},${TX_BBOX.north}`);
  console.log(`  relevance floor ${MIN_RELEVANCE} · ${DRY ? "DRY RUN" : "LIVE"}`
    + ` · county fix ${FIX_LOCATION ? "on" : "off"}\n`);

  let ok = 0, failed = 0, countyFixed = 0, cityFixed = 0;
  const reasons = new Map();
  const seen = new Set();          // guards the moving-window loop below

  while (seen.size < LIMIT) {
    // Offset stays at 0 on purpose. Rows leave the filter as they are fixed,
    // so the window moves on its own; `seen` is what stops us re-walking the
    // rows that failed and therefore never leave it.
    const rows = await fetchPage();
    if (!rows.length) { console.log("  ✔ nothing left to process"); break; }

    const fresh = rows.filter(r => !seen.has(r.id));
    if (!fresh.length) {
      console.log(`  ✔ remaining ${rows.length} row(s) all failed this run — stopping`);
      break;
    }

    for (const r of fresh) {
      if (seen.size >= LIMIT) break;
      seen.add(r.id);

      const g = await geocodeOne(r.address, r.county);

      if (!g.ok) {
        failed++;
        reasons.set(g.reason, (reasons.get(g.reason) || 0) + 1);
        // An honest failure. In verify mode the bad coordinates are cleared —
        // leaving them would keep a Missouri point on a Texas map.
        const body = { geocode_failed: true, geocoded_at: new Date().toISOString() };
        if (MODE === "verify") { body.latitude = null; body.longitude = null; }
        await patch(r.id, body);
        console.log(`  ✗ ${r.id} — ${g.reason}`);
        await sleep(DELAY_MS);
        continue;
      }

      const body = {
        latitude: g.lat,
        longitude: g.lng,
        geocoded_at: new Date().toISOString(),
        geocode_failed: false,
      };

      let note = "";
      if (FIX_LOCATION) {
        // The point knows which county it is in; the filer's typed label does
        // not. fips is derived from county downstream, so correcting the name
        // here is what stops a project being shipped to the wrong county's
        // parcel extract.
        if (g.county && normCounty(g.county) !== normCounty(r.county)) {
          body.county = g.county.replace(/\s+County\s*$/i, "").trim();
          countyFixed++;
          note += ` [county ${r.county || "?"} → ${body.county}]`;
        }
        if (g.city && g.city !== r.city) {
          body.city = g.city;
          cityFixed++;
        }
      }

      if (await patch(r.id, body)) {
        ok++;
        if (ok % 100 === 0) console.log(`  … ${ok} geocoded`);
      }
      if (note) console.log(`  ✓ ${r.id}${note}`);
      await sleep(DELAY_MS);
    }
  }

  console.log("\n" + "─".repeat(58));
  console.log(`geocoded ${ok} · failed ${failed} · county corrected ${countyFixed} · city corrected ${cityFixed}`);
  if (reasons.size) {
    console.log("failure reasons:");
    for (const [why, n] of [...reasons.entries()].sort((a, b) => b[1] - a[1])) {
      console.log(`  ${String(n).padStart(5)}  ${why}`);
    }
  }
  if (DRY) console.log("DRY RUN — nothing written.");
})();
