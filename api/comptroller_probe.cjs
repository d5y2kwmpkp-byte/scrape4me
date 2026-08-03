// api/comptroller_probe.cjs — SPA v2: the REAL app page (read-only)
// The account-status page was a landing shell (generic bundles only).
// Its HTML leaked the actual app: /data-search/franchise-tax.
// DataTables is loaded → the API's "draw" mode is likely in play, probably
// via a same-origin path that needs no key. Fetch the app + its bundles, grep.

const APP    = "https://comptroller.texas.gov/data-search/franchise-tax";
const ORIGIN = "https://comptroller.texas.gov";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

async function get(url, extra) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*", ...(extra || {}) } });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: "ERR " + e.message }; }
}
const uniq = a => [...new Set(a)];
const abs = s => /^https?:/i.test(s) ? s : s.startsWith("//") ? "https:" + s
  : s.startsWith("/") ? ORIGIN + s : ORIGIN + "/data-search/" + s;

function grep(text, label) {
  const pats = {
    "api-key literals": /["']?(?:x-api-key|api[_-]?key|apikey)["']?\s*[:=]\s*["'`][A-Za-z0-9._\-]{6,}["'`]/gi,
    "ajax/fetch urls":  /(?:url|fetch|ajax)\s*[:(]\s*[`"'][^`"')]{6,}/gi,
    "public-data paths":/["'`]\/?(?:public-data|data-search|api)\/[^\s"'`<>()]*/gi,
    "franchise refs":   /franchise-tax[a-z\-/]*/gi,
    "api hosts":        /https?:\/\/api[a-z0-9.\-]*\.[a-z]+\/[^\s"'`<>()]*/gi,
  };
  const out = {};
  for (const [k, re] of Object.entries(pats)) {
    const h = uniq((text.match(re) || []).map(s => s.trim())).slice(0, 14);
    if (h.length) out[k] = h;
  }
  if (Object.keys(out).length) {
    console.log(`\n── ${label} ──`);
    for (const [k, h] of Object.entries(out)) {
      console.log(`  ${k}:`);
      h.forEach(x => console.log(`    ${x.length > 140 ? x.slice(0, 140) + "…" : x}`));
    }
  } else console.log(`\n── ${label} ── (nothing)`);
}

(async () => {
  console.log("SPA recon v2 — the real app page");
  console.log("─".repeat(60));
  const app = await get(APP);
  console.log(`GET ${APP} → HTTP ${app.status} · ${app.text.length} bytes`);
  grep(app.text, "app page HTML");

  const srcs = uniq([...app.text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => abs(m[1])))
    .filter(u => /\.js(\?|$)/i.test(u) && !/jquery|underscore|motion-ui|tablesorter|datatables\.net/i.test(u));
  console.log(`\nApp-specific bundles (${srcs.length}):`);
  srcs.forEach(s => console.log("  " + s));
  for (const s of srcs.slice(0, 8)) {
    const js = await get(s);
    if (js.status === 200) grep(js.text, `bundle: ${s.split("/").pop()} (${js.text.length}b)`);
    else console.log(`\n[skip] ${s} → ${js.status}`);
  }

  console.log("\n\n── same-origin proxy attempts (DataTables 'draw' mode) ──");
  const q = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION";
  const tries = [
    `${ORIGIN}/data-search/api/franchise-tax?name=${encodeURIComponent(q)}&draw=1&start=0&length=10`,
    `${ORIGIN}/data-search/franchise-tax?name=${encodeURIComponent(q)}&draw=1&start=0&length=10`,
    `https://api.comptroller.texas.gov/public-data/v1/public/franchise-tax-list?name=${encodeURIComponent(q)}&draw=1&start=0&length=10`,
  ];
  for (const u of tries) {
    const r = await get(u, { Referer: APP, "X-Requested-With": "XMLHttpRequest" });
    const json = r.text.trim().startsWith("{") || r.text.trim().startsWith("[");
    console.log(`\n  ${r.status}  ${json ? "★ JSON" : "html/other"}  ${u.replace(ORIGIN, "").slice(0, 90)}`);
    console.log("    " + r.text.replace(/\s+/g, " ").slice(0, 240));
  }
  console.log("\nRead: ★ JSON with entity data = we're in, no key needed. All 403/HTML = register the key.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
