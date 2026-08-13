const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const BASE_URL = "https://www.tdlr.texas.gov/TABS/Search/Project";

const LIMIT = parseInt(process.env.LIMIT || "4500", 10);  // rows per run

const SB = {
  apikey: SUPABASE_KEY,
  Authorization: `Bearer ${SUPABASE_KEY}`,
  "Content-Type": "application/json",
};

// mirror of the live scraper's text normalize
function normalize(html) {
  return html
    .replace(/<script[\s\S]*?<\/script>/gi, "")
    .replace(/<style[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();
}

// identical to the live scraper's new extractor
function extractOwnerContact(text) {
  const re = /Owner Phone\s*:?\s*.+?\bContact Name\s*:?\s*(.+?)(?=\s*(?:TENANT|OWNER|RAS|Tenant Name|Tenant Phone|Design Firm|RAS Name|Type of Work|Scope of Work|Current Status)\b|$)/is;
  const m = text.match(re);
  if (!m) return null;
  let v = m[1].trim()
    .replace(/\s+(TENANT|OWNER|RAS)\s*$/i, "")   // strip trailing section header if it bled in
    .trim();
  return (v && v.length && v.length < 120) ? v : null;
}


async function sb(path, opts = {}) {
  const r = await fetch(`${SUPABASE_URL}/rest/v1/${path}`, { ...opts, headers: { ...SB, ...(opts.headers || {}) } });
  if (!r.ok) console.error("  sb", path, r.status, (await r.text()).slice(0, 150));
  return r;
}

(async () => {
  let grandFilled = 0, grandEmpty = 0, grandErr = 0, round = 0;

  while (true) {
    round++;
    // Supabase caps SELECT at 1000; loop until the queue is empty
    const res = await sb(`tabs_projects?select=id,tabs_number&owner_contact=is.null&tabs_number=not.is.null&limit=1000`);
    const rows = await res.json();
    if (!rows.length) { console.log("\nNothing left — queue empty."); break; }
    console.log(`\n=== Round ${round}: ${rows.length} rows ===`);

    let filled = 0, empty = 0, err = 0;
    for (let i = 0; i < rows.length; i++) {
      const { id, tabs_number } = rows[i];
      try {
        const r = await fetch(`${BASE_URL}/${tabs_number}`, {
          headers: { "User-Agent": "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36", "Accept": "text/html" },
        });
        if (!r.ok) { err++; continue; }
        const text = normalize(await r.text());
        const oc = extractOwnerContact(text);
        await sb(`tabs_projects?id=eq.${encodeURIComponent(id)}`, {
          method: "PATCH",
          headers: { Prefer: "return=minimal" },
          body: JSON.stringify({ owner_contact: oc || "" }),  // "" marks checked-but-empty so it drops from the queue
        });
        if (oc) filled++; else empty++;
      } catch (e) { err++; }
      if ((i + 1) % 100 === 0) console.log(`  ${i + 1}/${rows.length} — filled:${filled} empty:${empty} err:${err}`);
      await new Promise(s => setTimeout(s, 300));
    }
    grandFilled += filled; grandEmpty += empty; grandErr += err;
    console.log(`  Round ${round} done — filled:${filled} empty:${empty} err:${err}`);
  }

  console.log(`\n═══ ALL DONE — filled:${grandFilled} empty:${grandEmpty} err:${grandErr} ═══`);
})();

