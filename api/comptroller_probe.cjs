// api/comptroller_probe.cjs — DETAIL ENDPOINT + NAME CLEANUP (read-only)
// Search works key-free: /data-search/franchise-tax?name= → {name, taxpayerId, zip}
// Now: (a) find the detail call that returns status/agent/officers by taxpayerId
//      (b) retry misses with cleaned name variants
// Env: TEXBUILD_SUPABASE_KEY, COMPTROLLER_API_KEY (optional), N (default 5)

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const SB_KEY  = process.env.TEXBUILD_SUPABASE_KEY || "";
const API_KEY = process.env.COMPTROLLER_API_KEY || "";
const N       = Math.max(1, Math.min(25, parseInt(process.env.N || "5", 10)));
const DS      = "https://comptroller.texas.gov/data-search/franchise-tax";
const API     = "https://api.comptroller.texas.gov/public-data/v1/public";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const REF     = { Referer: "https://comptroller.texas.gov/taxes/franchise/account-status/search", "X-Requested-With": "XMLHttpRequest" };
const CONTROL = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION";

async function getJSON(url, extra) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "application/json", ...REF, ...(extra || {}) } });
    const text = await r.text();
    let data = null; try { data = JSON.parse(text); } catch {}
    return { status: r.status, data, text };
  } catch (e) { return { status: 0, data: null, text: "ERR " + e.message }; }
}

// name variants, most-specific first
function variants(raw) {
  const base = raw.trim().replace(/\s+/g, " ");
  const noTrailDot = base.replace(/\.\s*$/, "");
  const noPunct = noTrailDot.replace(/[#,]/g, " ").replace(/\s+/g, " ").trim();
  const noSuffix = noPunct.replace(/\b(L\.?L\.?C|INC|CORP(ORATION)?|LP|LTD|CO)\.?\s*$/i, "").trim();
  const firstWords = noSuffix.split(" ").slice(0, 3).join(" ");
  return [...new Set([base, noTrailDot, noPunct, noSuffix, firstWords])].filter(s => s.length >= 4);
}

async function search(name) {
  for (const v of variants(name)) {
    const r = await getJSON(`${DS}?name=${encodeURIComponent(v)}`);
    const list = (r.data && r.data.data) || [];
    console.log(`   [search] "${v}" → ${r.status} · ${list.length} match(es)`);
    if (list.length) return { hit: list[0], all: list, used: v };
  }
  return null;
}

async function detail(id, dump) {
  const tries = [
    { u: `${DS}/${id}`,               k: false },
    { u: `${DS}?taxpayerId=${id}`,    k: false },
    { u: `${DS}/detail?taxpayerId=${id}`, k: false },
    { u: `${API}/franchise-tax/${id}`,    k: true },
    { u: `${API}/franchise-tax-list?taxpayerId=${id}`, k: true },
  ];
  for (const t of tries) {
    if (t.k && !API_KEY) continue;
    const r = await getJSON(t.u, t.k ? { "x-api-key": API_KEY } : {});
    const rich = r.status === 200 && r.data && /right|status|agent|officer/i.test(r.text);
    console.log(`   [detail] ${t.u.replace(DS, "ds").replace(API, "api")} → ${r.status}${rich ? " ★ RICH" : ""}`);
    if (rich) {
      if (dump) { console.log("   ── raw DETAIL json (1800) ──"); console.log("   " + r.text.slice(0, 1800)); }
      return r;
    }
  }
  return null;
}

async function getNames() {
  const url = `${SUPABASE_URL}/rest/v1/tabs_projects?select=owner_name,owner_name_norm&owner_name=not.is.null&order=id.desc&limit=${N * 6}`;
  const r = await fetch(url, { headers: { apikey: SB_KEY, Authorization: "Bearer " + SB_KEY } });
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
  console.log("Detail endpoint + name cleanup — read-only");
  console.log("─".repeat(60));

  console.log(`\n■ CONTROL "${CONTROL}"`);
  const c = await search(CONTROL);
  if (c) { console.log(`   → ${c.hit.name}  id:${c.hit.taxpayerId}`); await detail(c.hit.taxpayerId, true); }

  const names = await getNames();
  let hits = 0;
  console.log(`\nNewest ${names.length} owner names:`);
  for (const nm of names) {
    console.log(`\n■ "${nm}"`);
    const s = await search(nm);
    if (!s) { console.log("   ✗ no match on any variant"); continue; }
    hits++;
    console.log(`   ✓ ${s.hit.name}  id:${s.hit.taxpayerId}  zip:${s.hit.mailingAddressZip || "—"}${s.used !== nm ? `  (via "${s.used}")` : ""}`);
    if (s.all.length > 1) console.log(`     ⚠ ${s.all.length} candidates — needs disambiguation`);
  }
  console.log(`\nHit rate: ${hits}/${names.length}`);
  console.log("Read: a ★ RICH detail line = we have status/agent/officers, and I write the real enrichment writer next.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
