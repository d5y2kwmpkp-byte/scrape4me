const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";
const ANTHROPIC_KEY = process.env.ANTHROPIC_API_KEY || "";

// Start small. Set to a big number (or 9999) for the full run after the test looks good.
const LIMIT = 9999;
const BATCH = 20;
const MODEL = "claude-haiku-4-5";

const CATEGORIES = [
  "data_center","healthcare","senior_living","childcare","education","religious",
  "gas_station","financial","hospitality","utility","industrial","civic","recreation",
  "ev_charging","restaurant","retail","infrastructure","residential","storage","parking",
  "office","general"
];

const SYSTEM = `You categorize Texas construction projects by BUILDING TYPE for contractors.
You will get a numbered list of projects (name + scope). Return ONLY a JSON array like [{"n":1,"category":"retail"},...] with no other text.
Use EXACTLY one category per project from this list: ${CATEGORIES.join(", ")}.
Judge by what KIND OF BUILDING it is, not the kind of work. Brand names are strong signals (Chipotle=restaurant, Buc-ee's=gas_station, HomeGoods=retail, Gymboree=childcare, LabCorp=healthcare, Academy Sports=retail).
A city named "College Station" is a place, not a school. A helipad on a garage is parking. A bank branch is financial.
Use "general" ONLY when there is genuinely NO building-type signal (e.g. bare "interior finish out" of an unnamed shell). If the name or scope hints at a use, pick that specific category instead of general.`;

async function fetchGeneralRows() {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?select=id,project_name,facility_name,scope_of_work&project_category=eq.general&limit=${LIMIT}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return res.json();
}

async function classifyBatch(rows) {
  const list = rows.map((r, i) =>
    `${i + 1}. NAME: ${(r.project_name || "").slice(0, 120)} | FACILITY: ${(r.facility_name || "").slice(0, 80)} | SCOPE: ${(r.scope_of_work || "").slice(0, 200)}`
  ).join("\n");

  const res = await fetch("https://api.anthropic.com/v1/messages", {
    method: "POST",
    headers: {
      "x-api-key": ANTHROPIC_KEY,
      "anthropic-version": "2023-06-01",
      "content-type": "application/json",
    },
    body: JSON.stringify({
      model: MODEL,
      max_tokens: 1024,
      system: SYSTEM,
      messages: [{ role: "user", content: list }],
    }),
  });
  const data = await res.json();
  if (!data.content) { console.log("  [api error]", JSON.stringify(data).slice(0, 300)); return []; }
  const text = data.content.map(c => c.text || "").join("");
  const clean = text.replace(/```json|```/g, "").trim();
  try { return JSON.parse(clean); }
  catch (e) { console.log("  [parse fail]", text.slice(0, 200)); return []; }
}

async function writeBack(id, category) {
  await fetch(`${SUPABASE_URL}/rest/v1/tabs_projects?id=eq.${id}`, {
    method: "PATCH",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "return=minimal",
    },
    body: JSON.stringify({ project_category: category }),
  });
}

(async () => {
  const rows = await fetchGeneralRows();
  console.log(`Fetched ${rows.length} 'general' rows (LIMIT=${LIMIT}), batching ${BATCH}`);
  let changed = 0, kept = 0, failed = 0;

  for (let i = 0; i < rows.length; i += BATCH) {
    const batch = rows.slice(i, i + BATCH);
    const results = await classifyBatch(batch);
    for (const r of results) {
      const row = batch[r.n - 1];
      if (!row || !r.category || !CATEGORIES.includes(r.category)) { failed++; continue; }
      // log every decision so you can eyeball the test run
      console.log(`  ${r.category.padEnd(14)} ← ${(row.project_name || "").slice(0, 50)}`);
      if (r.category !== "general") { await writeBack(row.id, r.category); changed++; }
      else kept++;
    }
    await new Promise(res => setTimeout(res, 400));
  }
  console.log(`\nDone. ${changed} re-categorized, ${kept} stayed general, ${failed} skipped.`);
})();
