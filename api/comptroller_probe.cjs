// api/comptroller_probe.cjs — SPA BUNDLE RECON (read-only, no writes)
// The documented API needs an x-api-key (that's the 403). But the
// account-status SPA fetches this same data in-browser, so its JS must
// either call a key-free endpoint or ship a public api-key. This fetches
// the search page + its script bundles and greps for both.
// Zero deps (Node 20 fetch). No env needed.

const PAGE   = "https://comptroller.texas.gov/taxes/franchise/account-status/search";
const ORIGIN = "https://comptroller.texas.gov";
const UA     = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";

async function get(url) {
  try {
    const r = await fetch(url, { headers: { "User-Agent": UA, Accept: "*/*" } });
    return { status: r.status, text: await r.text() };
  } catch (e) { return { status: 0, text: "ERR " + e.message }; }
}
const uniq = a => [...new Set(a)];
function abs(src) {
  if (/^https?:/i.test(src)) return src;
  if (src.startsWith("//")) return "https:" + src;
  if (src.startsWith("/")) return ORIGIN + src;
  return ORIGIN + "/taxes/franchise/account-status/" + src;
}
function grep(text, label) {
  const pats = {
    "comptroller URLs": /https?:\/\/[a-z0-9.\-]*comptroller[a-z0-9.\-]*\/[^\s"'`<>()]+/gi,
    "api / public-data paths": /["'`]\/?(?:public-data|api)\/[^\s"'`<>()]*/gi,
    "franchise-tax refs": /franchise-tax[a-z\-/]*/gi,
    "api-key literals": /["']?(?:x-api-key|api[_-]?key|apikey)["']?\s*[:=]\s*["'`][A-Za-z0-9._\-]{6,}["'`]/gi,
    "fetch/axios calls": /(?:fetch|axios(?:\.get|\.post)?)\s*\(\s*[`"'][^`"')]+/gi,
  };
  const out = {};
  for (const [k, re] of Object.entries(pats)) {
    const hits = uniq((text.match(re) || []).map(s => s.trim())).slice(0, 12);
    if (hits.length) out[k] = hits;
  }
  if (Object.keys(out).length) {
    console.log(`\n── ${label} ──`);
    for (const [k, hits] of Object.entries(out)) {
      console.log(`  ${k}:`);
      hits.forEach(h => console.log(`    ${h.length > 130 ? h.slice(0, 130) + "…" : h}`));
    }
  }
}

(async () => {
  console.log("SPA bundle recon — finding the key-free endpoint / embedded key");
  console.log("─".repeat(62));
  const page = await get(PAGE);
  console.log(`GET search page → HTTP ${page.status} · ${page.text.length} bytes`);
  grep(page.text, "search page HTML");

  const srcs = uniq([...page.text.matchAll(/<script\b[^>]*\bsrc\s*=\s*["']([^"']+)["']/gi)].map(m => abs(m[1])))
    .filter(u => /\.js(\?|$)/i.test(u));
  console.log(`\nFound ${srcs.length} script bundles:`);
  srcs.forEach(s => console.log("  " + s));

  let n = 0;
  for (const s of srcs) {
    if (n++ >= 8) break;
    const js = await get(s);
    if (js.status !== 200) { console.log(`\n[skip] ${s} → ${js.status}`); continue; }
    grep(js.text, `bundle: ${s.split("/").pop()} (${js.text.length}b)`);
  }

  console.log("\nRead: a fetch/axios URL pointing somewhere other than the keyed public-data endpoint,");
  console.log("or an 'api-key literals' hit (a public key the SPA ships) — either one unblocks us. Paste the log.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
