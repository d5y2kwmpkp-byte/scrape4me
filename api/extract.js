const fs   = require("fs");
const path = require("path");

const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const PERMITS_DIR  = path.join(process.cwd(), "data", "permits");
const INDEX_FILE   = path.join(process.cwd(), "data", "permit_index.json");

async function upsertToSupabase(records) {
  if (!SUPABASE_KEY) { console.log("  [supabase] No key — skipping"); return; }
  try {
    const res = await fetch(`${SUPABASE_URL}/rest/v1/sa_permits`, {
      method: "POST",
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer:         "resolution=merge-duplicates",
      },
      body: JSON.stringify(records),
    });
    console.log(`  [supabase] ${res.status} — ${records.length} records upserted`);
  } catch (e) {
    console.error(`  [supabase] Error: ${e.message}`);
  }
}

function extractFromHtml(html) {
  const text = html
    .replace(/<script[^>]*>[\s\S]*?<\/script>/gi, "")
    .replace(/<style[^>]*>[\s\S]*?<\/style>/gi, "")
    .replace(/<[^>]+>/g, " ")
    .replace(/&nbsp;/g, " ")
    .replace(/&amp;/g, "&")
    .replace(/&lt;/g, "<")
    .replace(/&gt;/g, ">")
    .replace(/&#\d+;/g, " ")
    .replace(/\s+/g, " ")
    .trim();

  const lines = text.split(/\s{2,}|\n/).map(l => l.trim()).filter(Boolean);

  const data = {
    applicantName: "", phone: "", email: "", location: "",
    mailingAddress: "", licensedProName: "", licensedProPhone: "",
    licensedProLic: "", ownerName: "", ownerAddress: "", projectDesc: "",
  };

  const skip = new Set(["Individual", "Business", "Organization", "Corporation", "Trust", "United States"]);
  let section = "";

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i].trim();
    if (line === "Applicant:")             { section = "applicant"; continue; }
    if (line === "Licensed Professional:") { section = "licensed";  continue; }
    if (line === "Project Description:")   { section = "project";   continue; }
    if (line === "Owner:")                 { section = "owner";     continue; }
    if (["Contacts:", "Payments", "Inspections"].includes(line)) break;
    if (skip.has(line)) continue;
    if (line.startsWith("Do not receive")) continue;
    if (line === "Mailing" || line === "Physical") continue;
    if (line.length < 2) continue;

    if (section === "applicant") {
      if (!data.applicantName && !line.match(/^Primary Phone/))  { data.applicantName  = line; }
      else if (line === "Primary Phone:" && lines[i+1])          { data.phone          = lines[i+1].trim(); i++; }
      else if (line.includes("@") && !data.email)                { data.email          = line; }
      else if (!data.mailingAddress && line.match(/\d{5}/))      { data.mailingAddress = line; }
    }
    if (section === "licensed") {
      if (!data.licensedProName && !line.match(/^Primary Phone/)) { data.licensedProName  = line; }
      else if (line === "Primary Phone:" && lines[i+1])           { data.licensedProPhone = lines[i+1].trim(); i++; }
      else if (line.match(/RMP|LIC|TICL|State /))                 { data.licensedProLic   = line; }
    }
    if (section === "project" && !data.projectDesc) { data.projectDesc = line; }
    if (section === "owner") {
      if (!data.ownerName)                                        { data.ownerName    = line; }
      else if (!data.ownerAddress && line.match(/\d{5}|\d+ /))   { data.ownerAddress = line; }
    }
  }
  return data;
}

function toCSV(records) {
  const headers = [
    "permit_num","applied_date","permit_type","description","status",
    "city","address","applicant_name","phone","email","mailing_address",
    "licensed_pro_name","licensed_pro_phone","licensed_pro_lic",
    "owner_name","owner_address","project_desc","source","fetched_at"
  ];
  const rows = records.map(r =>
    headers.map(h => `"${(r[h] || "").replace(/"/g, '""')}"`).join(",")
  );
  return [headers.join(","), ...rows].join("\n");
}

console.log("FlowState SA Permit Extractor");
console.log("─".repeat(50));

if (!fs.existsSync(PERMITS_DIR)) {
  console.log("[warn] No permits directory — nothing to extract");
  process.exit(0);
}

let permitIndex = {};
if (fs.existsSync(INDEX_FILE)) {
  const idx = JSON.parse(fs.readFileSync(INDEX_FILE, "utf8"));
  idx.forEach(p => { permitIndex[p.permitNum] = p; });
  console.log(`Loaded ${idx.length} permits from index`);
}

const htmlFiles = fs.readdirSync(PERMITS_DIR).filter(f => f.endsWith(".html"));
console.log(`Found ${htmlFiles.length} HTML files\n`);

const records = [];
let extracted = 0;
let empty = 0;

for (const file of htmlFiles) {
  const permitNum = file.replace(".html", "");
  const html      = fs.readFileSync(path.join(PERMITS_DIR, file), "utf8");
  const detail    = extractFromHtml(html);
  const meta      = permitIndex[permitNum] || {};
  const hasData   = detail.applicantName || detail.phone || detail.licensedProName || detail.ownerName;

  if (hasData) { extracted++; console.log(`  ✓ ${permitNum} | ${detail.applicantName || "—"} | ${detail.phone || "—"}`); }
  else         { empty++;     console.log(`  ~ ${permitNum} | no contact data`); }

  records.push({
    id:                 `sa_${permitNum}`,
    permit_num:         permitNum,
    applied_date:       meta.permitDate   || "",
    permit_type:        meta.permitType   || "",
    description:        meta.description || "",
    status:             meta.status      || "",
    city:               "San Antonio",
    address:            detail.location ? `${detail.location}, San Antonio, TX` : "",
    applicant_name:     detail.applicantName    || "",
    phone:              detail.phone            || "",
    email:              detail.email            || "",
    mailing_address:    detail.mailingAddress   || "",
    licensed_pro_name:  detail.licensedProName  || "",
    licensed_pro_phone: detail.licensedProPhone || "",
    licensed_pro_lic:   detail.licensedProLic   || "",
    owner_name:         detail.ownerName        || "",
    owner_address:      detail.ownerAddress     || "",
    project_desc:       detail.projectDesc      || "",
    source:             "SA_Accela",
    fetched_at:         new Date().toISOString(),
  });
}

fs.writeFileSync(path.join(process.cwd(), "data", "sa_permits.json"), JSON.stringify({ success: true, count: records.length, records }, null, 2));
fs.writeFileSync(path.join(process.cwd(), "data", "sa_permits.csv"), toCSV(records));

console.log(`\n✓ Extracted: ${extracted} with contact data`);
console.log(`  Empty:     ${empty}`);
console.log(`  Total:     ${records.length}`);
console.log(`  Saved: data/sa_permits.json + data/sa_permits.csv`);

if (SUPABASE_KEY && records.length > 0) {
  console.log(`\nUpserting to Supabase...`);
  const batchSize = 20;
  (async () => {
    for (let i = 0; i < records.length; i += batchSize) {
      await upsertToSupabase(records.slice(i, i + batchSize));
    }
    console.log("\n✓ Done!");
  })();
} else {
  console.log("\n✓ Done!");
}

