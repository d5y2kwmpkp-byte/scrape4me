// api/comptroller_probe.cjs — DUAL TEST: key-free data-search vs keyed official API
// Finding: /data-search/franchise-tax?name=... returns JSON and validates params
// ("draw" is not allowed) → it's the SPA's real endpoint, no key needed.
// This tries param variants there, then the keyed API, and dumps raw JSON.
// Env: TEXBUILD_SUPABASE_KEY, COMPTROLLER_API_KEY (optional), N (default 5)

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const SB_KEY  = process.env.TEXBUILD_SUPABASE_KEY || "";
const API_KEY = process.env.COMPTROLLER_API_KEY || "";
const N       = Math.max(1, Math.min(25, parseInt(process.env.N || "5", 10)));
const DS      = "https://comptroller.texas.gov/data-search/franchise-tax";
const API     = "https://api.comptroller.texas.gov/public-data/v1/public";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CONTROL = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION";

async function getJSON(url, extra) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...(extra || {}) } });
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
function rows(data) {
  if (Array.isArray(data)) return data;
  for (const k of Object.keys(data || {}))
    if (Array.isArray(data[k]) && data[k].length && typeof data[k][0] === "object") return data[k];
  return [];
}

async function tryDataSearch(name, dump) {
  const q = encodeURIComponent(name);
  const variants = [
    `${DS}?name=${q}`,
    `${DS}?name=${q}&start=0&length=10`,
    `${DS}?name=${q}&page=1&pageSize=10`,
    `${DS}?searchType=name&name=${q}`,
  ];
  for (const u of variants) {
    const r = await getJSON(u, { Referer: "https://comptroller.texas.gov/taxes/franchise/account-status/search", "X-Requested-With": "XMLHttpRequest" });
    const ok = r.status === 200 && r.data;
    console.log(`   [ds] ${u.replace(DS, "")} → ${r.status}${ok ? " ★" : ""}  ${ok ? "" : (r.text || "").slice(0, 90)}`);
    if (ok) {
      if (dump) { console.log("   ── raw JSON (1400) ──"); console.log("   " + r.text.slice(0, 1400)); }
      return r;
    }
  }
  return null;
}

async function tryOfficial(name) {
  if (!API_KEY) { console.log("   [api] no COMPTROLLER_API_KEY set — skipped"); return null; }
  const r = await getJSON(`${API}/franchise-tax-list?name=${encodeURIComponent(name)}`, { "x-api-key": API_KEY });
  console.log(`   [api] franchise-tax-list?name= → ${r.status}${r.status === 200 ? " ★" : "  " + (r.text || "").slice(0, 90)}`);
  return r.status === 200 ? r : null;
}

function summarize(res) {
  const list = rows(res.data);
  console.log(`   matches: ${list.length}`);
  if (!list.length) return;
  const top = list[0];
  const id = pick(top, "taxpayerId", "taxpayerNumber", "taxId");
  console.log(`   → ${pick(top, "taxpayerName", "name", "entityName") || "?"}  id:${id || "?"}`);
  console.log(`     status:${pick(top, "rightToTransactBusiness", "status") || "—"}  sos:${pick(top, "sosFileNumber", "fileNumber") || "—"}  agent:${pick(top, "registeredAgent", "agentName") || "—"}`);
  const offs = (top.officerInfo || pick(top, "officerInfo") || []);
  if (Array.isArray(offs) && offs.length) {
    console.log(`     officers: ${offs.length}`);
    offs.slice(0, 6).forEach(o => console.log(`       • ${o.AGNT_TITL_TX || o.title || ""} — ${o.AGNT_NM || o.name || "?"} ${o.AGNT_ACTV_YR ? "(" + o.AGNT_ACTV_YR + ")" : ""}`));
  }
  return id;
}

async function getNames() {
  const url = `${SUPABASE_URL}/rest/v1/tabs_projects?select=owner_name,owner_name_norm&owner_name=not.is.null&order=id.desc&limit=${N * 6}`;
  const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
  if (!r.ok) throw new Error(`tabs read ${r.status}`);
  const seen = new Set(), out = [];
  for (const row of await r.json()) {
    const nm = (row.owner_name || "").trim();
    const key = row.owner_name_norm || nm.toUpperCase();
    if (!nm || seen.has(key)) continue;
    seen.add(key); out.push(nm);
    if (out.length >= N) break;
  }
  return out;
}

(async () => {
  console.log(`Dual test — key-free data-search vs official API${API_KEY ? " (key present)" : " (no key)"}`);
  console.log("─".repeat(62));

  console.log(`\n■ CONTROL "${CONTROL}"`);
  let res = await tryDataSearch(CONTROL, true);
  if (!res) res = await tryOfficial(CONTROL);
  if (res) summarize(res); else console.log("   both doors closed for control");

  const names = await getNames();
  console.log(`\nNewest ${names.length} owner names:`);
  for (const nm of names) {
    console.log(`\n■ "${nm}"`);
    let r = await tryDataSearch(nm, false);
    if (!r) r = await tryOfficial(nm);
    if (r) summarize(r); else console.log("   no result");
  }

  console.log("\nRead: ★ on a [ds] line = key-free endpoint works, we build on that (no rate limits).");
  console.log("★ only on [api] = use the key. Both fail on real names but control works = name cleanup.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
