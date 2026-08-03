// api/comptroller_probe.cjs — OFFICIAL JSON API (read-only test, no writes)
// ────────────────────────────────────────────────────────────────
// The account-status search is a client-side SPA — scraping search.do
// only returns the empty JS shell. Real data is the CPA public JSON API:
//   search: GET /public-data/v1/public/franchise-tax-list?name=<NAME>
//   detail: GET /public-data/v1/public/franchise-tax/<taxpayerId>
//           (account status + registered agent + officers/directors)
// Docs show an x-api-key header; public scrapers report it works key-free,
// so we try keyless and only add a key if COMPTROLLER_API_KEY is set.
// Zero deps (Node 20 fetch). Env: TEXBUILD_SUPABASE_KEY, N (default 5),
//   COMPTROLLER_API_KEY (optional)
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const SB_KEY  = process.env.TEXBUILD_SUPABASE_KEY || "";
const API_KEY = process.env.COMPTROLLER_API_KEY || "";
const N       = Math.max(1, Math.min(25, parseInt(process.env.N || "5", 10)));
const API     = "https://api.comptroller.texas.gov/public-data/v1/public";
const CONTROL = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION";

if (!SB_KEY) { console.error("Missing TEXBUILD_SUPABASE_KEY"); process.exit(1); }

const HEAD = { Accept: "application/json", "User-Agent": "flowstate-enrich/1.0",
  ...(API_KEY ? { "x-api-key": API_KEY } : {}) };

async function getJSON(url) {
  try {
    const r = await fetch(url, { headers: HEAD });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  } catch (e) { return { status: 0, data: null, text: "ERR " + e.message }; }
}

function pick(obj, ...cands) {
  const norm = s => String(s).toLowerCase().replace(/[_\s-]/g, "");
  const want = cands.map(norm);
  let hit;
  (function walk(o) {
    if (hit !== undefined || !o || typeof o !== "object") return;
    for (const k of Object.keys(o))
      if (want.includes(norm(k)) && o[k] != null && typeof o[k] !== "object") { hit = o[k]; return; }
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") walk(o[k]);
  })(obj);
  return hit;
}
function officers(obj) {
  let arr;
  (function walk(o) {
    if (arr || !o || typeof o !== "object") return;
    if (Array.isArray(o) && o.length && typeof o[0] === "object" &&
        Object.keys(o[0]).some(k => /name|title|officer|director/i.test(k))) { arr = o; return; }
    for (const k of Object.keys(o)) if (o[k] && typeof o[k] === "object") walk(o[k]);
  })(obj);
  return arr || [];
}
function resultList(data) {
  if (Array.isArray(data)) return data;
  for (const k of Object.keys(data || {}))
    if (Array.isArray(data[k]) && data[k].length && typeof data[k][0] === "object") return data[k];
  return data && typeof data === "object" ? [data] : [];
}

async function searchByName(name) {
  const variants = [
    `${API}/franchise-tax-list?name=${encodeURIComponent(name)}`,
    `${API}/franchise-tax-list?searchType=name&name=${encodeURIComponent(name)}`,
    `${API}/franchise-tax?name=${encodeURIComponent(name)}`,
  ];
  for (const u of variants) {
    const res = await getJSON(u);
    console.log(`   [search] …${u.slice(API.length)} → ${res.status}`);
    if (res.status === 401 || res.status === 403) return { needKey: true, ...res, url: u };
    if (res.status === 200 && res.data) return { ...res, url: u };
  }
  return null;
}

async function enrich(name, dumpRaw) {
  console.log(`\n■ "${name}"`);
  const s = await searchByName(name);
  if (!s) { console.log("   no search variant returned data"); return; }
  if (s.needKey) {
    console.log("   → 401/403: API wants an x-api-key. Register at api-doc.comptroller.texas.gov, set COMPTROLLER_API_KEY.");
    return;
  }
  if (dumpRaw) {
    console.log("   ── raw SEARCH json (first 1200 chars) ──");
    console.log("   " + (s.text || "").slice(0, 1200));
  }
  const list = resultList(s.data);
  console.log(`   matches: ${list.length}`);
  if (!list.length) { console.log("   (no entity matched this name)"); return; }

  const top = list[0];
  const id = pick(top, "taxpayerId", "taxpayerNumber", "taxpayer_number");
  const summ = {
    matched: pick(top, "taxpayerName", "name", "entityName", "legalName") || "?",
    status:  pick(top, "rightToTransactBusiness", "rightToTransact", "status", "accountStatus"),
    sos:     pick(top, "sosFileNumber", "fileNumber", "sosFile"),
    agent:   pick(top, "registeredAgent", "agentName", "raName"),
  };
  console.log(`   match: ${summ.matched}  id:${id || "?"}  status:${summ.status || "—"}  sos:${summ.sos || "—"}  agent:${summ.agent || "—"}`);

  if (id) {
    const d = await getJSON(`${API}/franchise-tax/${encodeURIComponent(id)}`);
    console.log(`   [detail] franchise-tax/${id} → ${d.status}`);
    if (dumpRaw) {
      console.log("   ── raw DETAIL json (first 1200 chars) ──");
      console.log("   " + (d.text || "").slice(0, 1200));
    }
    if (d.data) {
      const offs = officers(d.data);
      const agent2 = pick(d.data, "registeredAgent", "agentName", "raName");
      console.log(`   detail agent:${agent2 || summ.agent || "—"}  officers:${offs.length}`);
      offs.slice(0, 8).forEach(o => {
        const nm = pick(o, "name", "officerName") || "?";
        const ti = pick(o, "title", "officerTitle", "role") || "";
        const yr = pick(o, "reportYear", "year") || "";
        console.log(`      • ${ti ? ti + " — " : ""}${nm}${yr ? "  (" + yr + ")" : ""}`);
      });
    }
  }
}

async function getNames() {
  const url = `${SUPABASE_URL}/rest/v1/tabs_projects?select=owner_name,owner_name_norm&owner_name=not.is.null&order=id.desc&limit=${N * 6}`;
  const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
  if (!r.ok) throw new Error(`tabs read ${r.status}`);
  const rows = await r.json();
  const seen = new Set(), out = [];
  for (const row of rows) {
    const nm = (row.owner_name || "").trim();
    const key = row.owner_name_norm || nm.toUpperCase();
    if (!nm || seen.has(key)) continue;
    seen.add(key); out.push(nm);
    if (out.length >= N) break;
  }
  return out;
}

(async () => {
  console.log("Comptroller OFFICIAL API — read-only test" + (API_KEY ? " (with key)" : " (keyless)"));
  console.log("─".repeat(60));
  await enrich(CONTROL, true);   // raw dump for the control locks field names
  const names = await getNames();
  console.log(`\nNewest ${names.length} owner names from tabs_projects:`);
  for (const nm of names) await enrich(nm, false);
  console.log("\nRead: control prints status + officers → API works, we build the writer next.");
  console.log("401 → register a key. matches:0 on real names but control works → name-format cleanup.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
