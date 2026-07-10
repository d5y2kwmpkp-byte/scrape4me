const zlib = require("zlib");
const { Readable } = require("stream");
const readline = require("readline");


const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const MANIFEST = "https://minedbuildings.z5.web.core.windows.net/global-buildings/dataset-links.csv";

// Scope: how many permits to attach footprints to. Start small.
const LIMIT = 500;
const MATCH_RADIUS_M = 20;   // fallback: nearest footprint within this distance
const ZOOM = 9;              // MSFT partitions at level-9 quadkeys

// ── quadkey math (Bing standard) ─────────────────────────────
function lngLatToTile(lng, lat, z) {
  const n = 2 ** z;
  const x = Math.floor(((lng + 180) / 360) * n);
  const latRad = (lat * Math.PI) / 180;
  const y = Math.floor(((1 - Math.log(Math.tan(latRad) + 1 / Math.cos(latRad)) / Math.PI) / 2) * n);
  return { x, y };
}
function tileToQuadkey(x, y, z) {
  let qk = "";
  for (let i = z; i > 0; i--) {
    let digit = 0;
    const mask = 1 << (i - 1);
    if ((x & mask) !== 0) digit += 1;
    if ((y & mask) !== 0) digit += 2;
    qk += digit;
  }
  return qk;
}
const quadkeyOf = (lng, lat) => { const t = lngLatToTile(lng, lat, ZOOM); return tileToQuadkey(t.x, t.y, ZOOM); };

// ── geometry helpers (no deps) ───────────────────────────────
function pointInRing(px, py, ring) {
  let inside = false;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0], yi = ring[i][1], xj = ring[j][0], yj = ring[j][1];
    if (((yi > py) !== (yj > py)) && (px < ((xj - xi) * (py - yi)) / (yj - yi) + xi)) inside = !inside;
  }
  return inside;
}
function pointInPolygon(lng, lat, coords) {
  if (!coords || !coords[0]) return false;
  if (!pointInRing(lng, lat, coords[0])) return false;       // outer ring
  for (let h = 1; h < coords.length; h++) if (pointInRing(lng, lat, coords[h])) return false; // holes
  return true;
}
function centroidOf(coords) {
  const ring = coords[0]; let x = 0, y = 0;
  for (const p of ring) { x += p[0]; y += p[1]; }
  return { lng: x / ring.length, lat: y / ring.length };
}
function distM(aLng, aLat, bLng, bLat) {
  const dx = (aLng - bLng) * Math.cos(((aLat + bLat) * Math.PI) / 360) * 111320;
  const dy = (aLat - bLat) * 111320;
  return Math.hypot(dx, dy);
}
// rough polygon area in m^2 (shoelace on a local planar approx)
function areaM2(coords) {
  const ring = coords[0];
  const lat0 = ring[0][1];
  const kx = Math.cos((lat0 * Math.PI) / 180) * 111320, ky = 111320;
  let a = 0;
  for (let i = 0, j = ring.length - 1; i < ring.length; j = i++) {
    const xi = ring[i][0] * kx, yi = ring[i][1] * ky;
    const xj = ring[j][0] * kx, yj = ring[j][1] * ky;
    a += xj * yi - xi * yj;
  }
  return Math.abs(a / 2);
}

// ── category floor heights (meters) for derived height ────────
const FLOOR_H = {
  retail: 6, gas_station: 5, restaurant: 5, industrial: 8, storage: 8,
  data_center: 7, office: 4, healthcare: 4.5, education: 4.5, residential: 3,
  hospitality: 3.5, recreation: 6, civic: 4.5, religious: 7, financial: 4.5,
  parking: 3, childcare: 4, senior_living: 3.5, utility: 6, ev_charging: 5,
  infrastructure: 5, general: 5,
};

async function sb(path, opts = {}) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, {
    ...opts,
    headers: {
      apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json", ...(opts.headers || {}),
    },
  });
  if (!res.ok) console.error("  supabase:", res.status, (await res.text()).slice(0, 200));
  return res;
}

(async () => {
  // 1. target permits
  const res = await sb(`tabs_projects?select=id,latitude,longitude,square_footage_num,project_category&latitude=not.is.null&longitude=not.is.null&order=registration_date.desc&limit=${LIMIT}`);
  const permits = (await res.json()).map(p => ({
    id: p.id, lng: +p.longitude, lat: +p.latitude,
    sqft: p.square_footage_num, cat: p.project_category || "general",
    qk: quadkeyOf(+p.longitude, +p.latitude),
  }));
  console.log(`${permits.length} permits`);

  // 2. needed quadkeys
  const needed = new Set(permits.map(p => p.qk));
  console.log(`${needed.size} quadkeys:`, [...needed].join(", "));

  // 3. manifest -> matching US urls
  const man = await (await fetch(MANIFEST)).text();
  const urls = [];
  for (const line of man.split(/\r?\n/).slice(1)) {
    const [loc, qk, url] = line.split(",");
    if (loc === "UnitedStates" && needed.has(qk)) urls.push({ qk, url });
  }
  console.log(`${urls.length} tile files to fetch`);

    // 4-6. stream each tile, keep only footprints matching a permit
  const { Readable } = require("stream");
  const readline = require("readline");

  const matches = new Map();
  for (const { qk, url } of urls) {
    const local = permits.filter(p => p.qk === qk);
    console.log(`\ntile ${qk}: ${local.length} permits`);

    const resp = await fetch(url);
    const gunzip = zlib.createGunzip();
    const nodeStream = Readable.fromWeb(resp.body).pipe(gunzip);
    const rl = readline.createInterface({ input: nodeStream, crlfDelay: Infinity });

    let seen = 0;
    for await (const line of rl) {
      if (!line.trim()) continue;
      seen++;
      let f; try { f = JSON.parse(line); } catch { continue; }
      const coords = f.geometry?.coordinates;
      if (!coords) continue;
      const c = centroidOf(coords);
      for (const p of local) {
        if (Math.abs(c.lat - p.lat) > 0.002 || Math.abs(c.lng - p.lng) > 0.002) continue;
        const inside = pointInPolygon(p.lng, p.lat, coords);
        const d = inside ? 0 : distM(p.lng, p.lat, c.lng, c.lat);
        if (!inside && d > MATCH_RADIUS_M) continue;
        const prev = matches.get(p.id);
        if (prev && prev.match_dist_m <= d) continue;
                const msftH = f.properties?.height;
        const area = areaM2(coords);
        let height = (msftH && msftH >= 2.5) ? msftH : null;     // was: msftH > 0
        let hsrc = height ? "msft" : null;
        if (!height && p.sqft && area > 20) {
          const floors = Math.max(1, Math.round(p.sqft / 10.7639 / area));
          height = floors * (FLOOR_H[p.cat] || 5);
          hsrc = "derived";
        }
        if (!height) { height = FLOOR_H[p.cat] || 5; hsrc = "default"; }
        height = Math.min(height, 200);                          // NEW: sanity ceiling

        matches.set(p.id, {
          permit_id: p.id,
          footprint: f.geometry,
          centroid_lat: c.lat, centroid_lng: c.lng,
          height_m: Math.round(height * 10) / 10,
          height_source: hsrc,
          confidence: inside ? "contains" : "nearest",
          match_dist_m: Math.round(d),
          source: "msft",
        });
      }
    }
    console.log(`  scanned ${seen} footprints, ${matches.size} permits matched so far`);
  }


  // upsert
  const rows = [...matches.values()];
  console.log(`\nupserting ${rows.length} footprints`);
  for (let i = 0; i < rows.length; i += 200) {
    await sb("building_geometry", {
      method: "POST",
      headers: { Prefer: "resolution=merge-duplicates,return=minimal" },
      body: JSON.stringify(rows.slice(i, i + 200)),
    });
  }

  const byConf = rows.reduce((a, r) => ((a[r.confidence] = (a[r.confidence] || 0) + 1), a), {});
  const byH = rows.reduce((a, r) => ((a[r.height_source] = (a[r.height_source] || 0) + 1), a), {});
  console.log(`\nmatched ${rows.length}/${permits.length} permits`);
  console.log("confidence:", byConf);
  console.log("height source:", byH);
})();
