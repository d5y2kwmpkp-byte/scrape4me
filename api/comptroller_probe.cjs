// api/comptroller_probe.cjs — REAL LOOKUP v3 (read-only, writes nothing)
// ────────────────────────────────────────────────────────────────
// Endpoint cracked: the franchise search is form[1] on /coa/search.do —
//   GET search.do?name=<ENTITY>   (fields: taxpayerId, name, fileNumber)
// coaSearchBtn was a decoy (returns the page shell, ignores params);
// the header "open-search" box is a different, site-wide widget.
//
// This hits the real endpoint for a known control + your newest owner
// names, parses status/agent/SOS inline, and dumps any result/detail
// links so we can see the format for the officers follow-through.
//
// Zero npm deps (Node 20 fetch). Env: TEXBUILD_SUPABASE_KEY, N (default 5)
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const KEY     = process.env.TEXBUILD_SUPABASE_KEY || "";
const N       = Math.max(1, Math.min(25, parseInt(process.env.N || "5", 10)));
const SEARCH  = "https://mycpa.cpa.state.tx.us/coa/search.do";
const UA      = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CONTROL = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION CO";  // known to exist

if (!KEY) { console.error("Missing TEXBUILD_SUPABASE_KEY"); process.exit(1); }

const strip = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

function links(html) {
  const out = [];
  for (const a of html.matchAll(/<a\b[^>]*href\s*=\s*["']([^"']+)["'][^>]*>([\s\S]*?)<\/a>/gi)) {
    const href = a[1], txt = strip(a[2]);
    if (/tpid|coaget|detail|status|\.do\?/i.test(href) || /detail|status|view/i.test(txt))
      out.push({ href, txt });
  }
  const seen = new Set();
  return out.filter(l => (seen.has(l.href) ? false : seen.add(l.href))).slice(0, 15);
}

function parseStatus(flat) {
  const g = re => (flat.match(re) || [])[1] || null;
  return {
    right_to_transact: g(/Right to Transact Business(?: in Texas)?\s*:?\s*([A-Za-z ]+?)(?:\s+State|\s+Texas|\s+Registered|\s+Effective|$)/i),
    taxpayer_number:   g(/Taxpayer Number\s*:?\s*(\d{6,11})/i),
    sos_file_number:   g(/SOS File Number\s*:?\s*(\d+)/i),
    state_formation:   g(/State of Formation\s*:?\s*([A-Za-z]{2,})/i),
    registered_agent:  g(/Registered Agent(?: Name)?\s*:?\s*([A-Za-z.,'\- ]+?)(?:\s+Registered Office|\s+\d|$)/i),
  };
}

async function lookup(name) {
  const url = `${SEARCH}?taxpayerId=&name=${encodeURIComponent(name)}&fileNumber=`;
  let html = "", status = 0;
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "text/html" } });
    status = r.status;
    html = await r.text();
  } catch (e) {
    console.log(`\n■ "${name}" → ERR ${e.message}`);
    return;
  }
  const flat = strip(html);
  const bodyish = flat.replace(/^.*?(Franchise Tax Account Status Search)/i, "$1");
  const st = parseStatus(flat);
  const detailCount = (flat.match(/Details/gi) || []).length;

  console.log(`\n■ "${name}"  → HTTP ${status} · ${html.length} bytes · ${detailCount} "Details"`);
  console.log(`   status:${st.right_to_transact || "—"}  taxpayer:${st.taxpayer_number || "—"}  sos:${st.sos_file_number || "—"}  formed:${st.state_formation || "—"}  agent:${st.registered_agent || "—"}`);

  const lk = links(html);
  if (lk.length) {
    console.log(`   result/detail links (${lk.length}):`);
    lk.forEach(l => console.log(`     ${(l.txt || "").slice(0, 26).padEnd(26)}  ${l.href}`));
  } else {
    console.log("   no detail links found");
  }
  console.log("   ── result text (260 chars after title) ──");
  console.log("   " + bodyish.slice(0, 260));
}

async function getNames() {
  const url = `${SUPABASE_URL}/rest/v1/tabs_projects?select=owner_name,owner_name_norm,county&owner_name=not.is.null&order=id.desc&limit=${N * 6}`;
  const r = await fetch(url, { headers: { apikey: KEY, Authorization: "Bearer " + KEY } });
  if (!r.ok) throw new Error(`tabs read ${r.status}: ${(await r.text()).slice(0, 160)}`);
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
  console.log("Comptroller lookup v3 — REAL endpoint (search.do?name=) · read-only");
  console.log("─".repeat(64));

  console.log("Control first:");
  await lookup(CONTROL);

  const names = await getNames();
  console.log(`\nNewest ${names.length} owner names from tabs_projects:`);
  for (const nm of names) await lookup(nm.toUpperCase());

  console.log("\n─".repeat(32));
  console.log("READ THIS: if status/taxpayer/sos populated → direct single-result hit, we're basically done.");
  console.log("If you only see \"Details\" links → it's a results LIST; paste one detail href back and I'll");
  console.log("build the follow-through (detail page + separate officers/directors page) against it.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
