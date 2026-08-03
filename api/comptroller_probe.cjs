// api/comptroller_probe.cjs  — RECON v2 (read-only, writes nothing)
// Cracks the real Franchise Tax Account Status search endpoint.
//   1. GET search.do → dump ALL <form>s + endpoint hints from raw HTML
//   2. brute-try candidate endpoints for a known control name
//   3. try one real owner name from tabs_projects too
// Zero deps (Node 20 fetch). Env: TEXBUILD_SUPABASE_KEY
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const KEY  = process.env.TEXBUILD_SUPABASE_KEY || "";
const BASE = "https://mycpa.cpa.state.tx.us";
const COA  = BASE + "/coa";
const UA   = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CONTROL = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION CO";

const strip = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

function allForms(html) {
  const out = [];
  for (const f of html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)) {
    const action = (f[1].match(/action\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "(self)";
    const method = ((f[1].match(/method\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "get").toUpperCase();
    const fields = [];
    for (const m of f[2].matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
      const name = (m[2].match(/name\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
      if (name) fields.push(name + "[" + ((m[2].match(/type\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || m[1].toLowerCase()) + "]");
    }
    out.push({ action, method, fields });
  }
  return out;
}

function hints(html) {
  const grabAll = re => [...new Set([...html.matchAll(re)].map(m => m[0]))].slice(0, 12);
  return {
    actions: grabAll(/action\s*=\s*["'][^"']+["']/gi),
    dofiles: grabAll(/[\w./-]*\.do\b/gi),
    coaBtn:  grabAll(/coaSearchBtn|CoaGet\w*/gi),
    params:  grabAll(/Search_\w+|search_\w+/gi),
  };
}

async function pull(url, opts) {
  const r = await fetch(url, opts);
  const html = await r.text();
  return { status: r.status, cookie: (r.headers.get("set-cookie") || "").split(";")[0], html };
}

async function getName() {
  if (!KEY) return null;
  try {
    const r = await fetch(`${SUPABASE_URL}/rest/v1/tabs_projects?select=owner_name&owner_name=not.is.null&order=id.desc&limit=1`,
      { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
    const d = await r.json();
    return d && d[0] ? d[0].owner_name : null;
  } catch { return null; }
}

async function tryCandidate(c, cookie, q) {
  const body = new URLSearchParams(c.p);
  const headers = { "User-Agent": UA, Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  let url = c.u, opts = { headers };
  if (c.m === "GET") { url += "?" + body.toString(); }
  else { headers["Content-Type"] = "application/x-www-form-urlencoded"; opts = { method: "POST", headers, body: body.toString() }; }

  try {
    const r = await fetch(url, opts);
    const html = await r.text();
    const flat = strip(html);
    const alive = /Right to Transact|Taxpayer Number|SOS File|Details/i.test(flat);
    console.log(`\n  [${c.m}] ${c.u}  params=${JSON.stringify(c.p)}`);
    console.log(`    HTTP ${r.status} · ${html.length} bytes · ${alive ? "★ LOOKS LIVE" : "no entity markers"}`);
    console.log("    " + flat.slice(0, 300));
  } catch (e) { console.log(`\n  [${c.m}] ${c.u} → ERR ${e.message}`); }
}

(async () => {
  console.log("Comptroller probe v2 — READ-ONLY (no writes)");
  console.log("─".repeat(60));

  const first = await pull(COA + "/search.do", { headers: { "User-Agent": UA, Accept: "text/html" } });
  console.log(`GET /coa/search.do → HTTP ${first.status}${first.cookie ? " (cookie set)" : ""}\n`);

  console.log("ALL forms on the page:");
  allForms(first.html).forEach((f, i) => console.log(`  form[${i}] ${f.method} action=${f.action} fields=[${f.fields.join(", ")}]`));

  const h = hints(first.html);
  console.log("\nRaw HTML hints:");
  console.log("  actions:", h.actions.join("  ") || "—");
  console.log("  .do:    ", h.dofiles.join("  ") || "—");
  console.log("  coa/Get:", h.coaBtn.join("  ") || "—");
  console.log("  Search_*:", h.params.join("  ") || "—");

  const q = CONTROL;
  const candidates = [
    { m: "GET",  u: COA + "/coaSearchBtn", p: { Search_Nm: q } },
    { m: "POST", u: COA + "/coaSearchBtn", p: { Search_Nm: q, Search_Type: "E" } },
    { m: "POST", u: COA + "/search.do",    p: { Search_Nm: q, Search_Type: "E" } },
    { m: "GET",  u: COA + "/coaSearchBtn", p: { Search_Nm: q, Search_Type: "E" } },
    { m: "POST", u: COA + "/coaSearchBtn", p: { searchNm: q } },
  ];
  console.log(`\nBrute-trying candidate endpoints for control "${q}":`);
  for (const c of candidates) await tryCandidate(c, first.cookie, q);

  const owner = await getName();
  if (owner) {
    console.log(`\nRepeating the top 2 candidates for a real owner: "${owner.toUpperCase()}"`);
    for (const c of candidates.slice(0, 2)) await tryCandidate({ ...c, p: { ...c.p, [Object.keys(c.p)[0]]: owner.toUpperCase() } }, first.cookie, owner.toUpperCase());
  }

  console.log("\nDone. Paste the whole log back — the form dump + any ★ LOOKS LIVE candidate tells me the real endpoint and params, and I'll build the parser against it.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
