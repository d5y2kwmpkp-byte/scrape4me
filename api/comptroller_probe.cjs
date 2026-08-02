// api/comptroller_probe.cjs
// ────────────────────────────────────────────────────────────────
// COMPTROLLER ENTITY LOOKUP — READ-ONLY RECON PROBE (writes nothing)
// Goal of THIS run: prove the pieces before building the real parser.
//   1. pull newest distinct owner names from tabs_projects
//   2. AUTO-DETECT the Franchise Tax Account Status search form
//      (reads the real field names off the page — no guessing)
//   3. submit one known-good control + your newest name, dump raw response
// Zero npm deps (Node 20 fetch). Env: TEXBUILD_SUPABASE_KEY, N (default 5)
// ────────────────────────────────────────────────────────────────

const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const KEY = process.env.TEXBUILD_SUPABASE_KEY || "";
const N   = Math.max(1, Math.min(25, parseInt(process.env.N || "5", 10)));
const UA  = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36";
const CONTROL = "DOUBLE DIAMOND PROPERTIES CONSTRUCTION CO";  // known to exist
const SEARCH_PAGES = [
  "https://mycpa.cpa.state.tx.us/coa/search.do",
  "https://mycpa.cpa.state.tx.us/coa/",
];

if (!KEY) { console.error("Missing TEXBUILD_SUPABASE_KEY"); process.exit(1); }

const strip = h => h
  .replace(/<script[\s\S]*?<\/script>/gi, "").replace(/<style[\s\S]*?<\/style>/gi, "")
  .replace(/<[^>]+>/g, " ").replace(/&nbsp;/g, " ").replace(/&amp;/g, "&")
  .replace(/\s+/g, " ").trim();

function parseForm(html) {
  const forms = [...html.matchAll(/<form\b([^>]*)>([\s\S]*?)<\/form>/gi)];
  if (!forms.length) return null;
  const pick = forms.find(f => /search|coa/i.test(f[1])) || forms[0];
  const attrs = pick[1], inner = pick[2];
  const action = (attrs.match(/action\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "";
  const method = ((attrs.match(/method\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || "get").toUpperCase();
  const fields = [];
  for (const m of inner.matchAll(/<(input|select|textarea)\b([^>]*)>/gi)) {
    const a = m[2];
    const name = (a.match(/name\s*=\s*["']?([^"'\s>]+)/i) || [])[1];
    if (!name) continue;
    const type = (a.match(/type\s*=\s*["']?([^"'\s>]+)/i) || [])[1] || m[1].toLowerCase();
    const value = (a.match(/value\s*=\s*["']?([^"']*)/i) || [])[1] || "";
    fields.push({ name, type, value });
  }
  return { action, method, fields };
}

function absolute(action, base) {
  if (!action) return base;
  if (/^https?:/i.test(action)) return action;
  if (action.startsWith("/")) return "https://mycpa.cpa.state.tx.us" + action;
  return base.replace(/[^/]*$/, "") + action;
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
    seen.add(key); out.push({ name: nm, county: row.county || "?" });
    if (out.length >= N) break;
  }
  return out;
}

async function recon() {
  for (const page of SEARCH_PAGES) {
    try {
      const r = await fetch(page, { headers: { "User-Agent": UA, Accept: "text/html" } });
      const cookie = (r.headers.get("set-cookie") || "").split(";")[0];
      const html = await r.text();
      const form = parseForm(html);
      console.log(`\n[recon] ${page} → HTTP ${r.status}${cookie ? " (cookie set)" : ""}`);
      if (form) {
        console.log(`  form action = ${form.action || "(self)"}  method = ${form.method}`);
        console.log(`  fields: ${form.fields.map(f => `${f.name}[${f.type}]`).join(", ") || "(none)"}`);
        return { page, cookie, form };
      }
      console.log("  no <form> found; page head:");
      console.log("  " + strip(html).slice(0, 300));
    } catch (e) { console.log(`[recon] ${page} → ERR ${e.message}`); }
  }
  return null;
}

async function submit(rc, query) {
  const { page, cookie, form } = rc;
  const action = absolute(form.action, page);
  const nameField =
    form.fields.find(f => /(nm|name)/i.test(f.name) && !/button|submit|image|reset|hidden/i.test(f.type))
    || form.fields.find(f => /text/i.test(f.type));
  const body = new URLSearchParams();
  for (const f of form.fields) {
    if (/submit|button|image|reset/i.test(f.type)) continue;
    body.set(f.name, f.value || "");
  }
  if (nameField) body.set(nameField.name, query);
  const headers = { "User-Agent": UA, "Content-Type": "application/x-www-form-urlencoded", Accept: "text/html" };
  if (cookie) headers.Cookie = cookie;
  const url = form.method === "GET" ? `${action}?${body.toString()}` : action;
  const opts = form.method === "GET" ? { headers } : { method: "POST", headers, body: body.toString() };

  console.log(`\n[submit] "${query}"  via ${form.method} ${action}`);
  console.log(`  name field used: ${nameField ? nameField.name : "(NONE DETECTED)"}`);
  const r = await fetch(url, opts);
  const html = await r.text();
  const flat = strip(html);
  const grab = re => (flat.match(re) || [])[1] || "—";
  console.log(`  HTTP ${r.status} · ${html.length} bytes`);
  console.log(`  Right to Transact : ${grab(/Right to Transact Business(?: in Texas)?\s*:?\s*([A-Za-z ]+?)(?:\s+State|\s+Texas|\s+Registered|$)/i)}`);
  console.log(`  Taxpayer Number   : ${grab(/Taxpayer Number\s*:?\s*(\d{6,11})/i)}`);
  console.log(`  SOS File Number   : ${grab(/SOS File Number\s*:?\s*(\d+)/i)}`);
  console.log(`  Registered Agent  : ${grab(/Registered Agent(?: Name)?\s*:?\s*([A-Za-z.,'\- ]+?)(?:\s+Registered Office|\s+\d|$)/i)}`);
  console.log(`  list signals      : ${(flat.match(/Details/gi) || []).length} "Details" · ${(flat.match(/Taxpayer/gi) || []).length} "Taxpayer"`);
  console.log("  ── raw flat text (first 700 chars) ──");
  console.log("  " + flat.slice(0, 700));
}

(async () => {
  console.log("Comptroller probe — READ-ONLY recon (no writes)");
  console.log("─".repeat(60));
  const names = await getNames();
  console.log(`Newest ${names.length} distinct owner names from tabs_projects:`);
  names.forEach((n, i) => console.log(`  ${i + 1}. ${n.name}  (${n.county})`));

  const rc = await recon();
  if (!rc || !rc.form) {
    console.log("\nNo search form auto-detected. Paste the [recon] output back and I'll wire the request by hand.");
    return;
  }
  await submit(rc, CONTROL);
  if (names[0]) await submit(rc, names[0].name.toUpperCase());

  console.log("\nDone. This run gave us: DB read works, the real form fields, and the raw response shape.");
  console.log("Paste the whole log back — I'll build the two-step fetch+parse (results → detail → officers) against it.");
})().catch(e => { console.error("FATAL", e.message); process.exit(1); });
