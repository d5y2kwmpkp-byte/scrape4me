const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

// true = dump first 3 rows' columns and write nothing; false = full load
const TEST_MODE = false;

const SOURCES = [
  { trade: "hvac",       license_type: "Air Conditioning and Refrigeration", url: "https://www.tdlr.texas.gov/dbproduction2/ltairref.csv" },
  { trade: "electrical", license_type: "Electrical Contractor",              url: "https://www.tdlr.texas.gov/dbproduction2/Lteecele.csv" },
];

// ── quote-aware CSV line parser (fields can contain commas) ──────
function parseCsvLine(line) {
  const out = [];
  let cur = "", inQ = false;
  for (let i = 0; i < line.length; i++) {
    const ch = line[i];
    if (ch === '"') {
      if (inQ && line[i + 1] === '"') { cur += '"'; i++; }
      else inQ = !inQ;
    } else if (ch === "," && !inQ) {
      out.push(cur); cur = "";
    } else cur += ch;
  }
  out.push(cur);
  return out.map(s => s.trim());
}

// "HOUSTON TX 77031-2516" → "HOUSTON"
function cityOf(csz) {
  if (!csz) return null;
  const m = String(csz).match(/^(.*?)\s+[A-Z]{2}\s+\d{5}/);
  return m ? m[1].trim() : null;
}

// "05/12/2027" → "2027-05-12"
function parseDate(s) {
  if (!s) return null;
  const m = String(s).match(/(\d{1,2})\/(\d{1,2})\/(\d{4})/);
  return m ? `${m[3]}-${m[1].padStart(2, '0')}-${m[2].padStart(2, '0')}` : null;
}

// ── COUNTY → FIPS (same map as TABS) ─────────────────────────────
const COUNTY_FIPS = {
  'anderson':'48001','andrews':'48003','angelina':'48005','aransas':'48007','archer':'48009','armstrong':'48011','atascosa':'48013','austin':'48015','bailey':'48017','bandera':'48019','bastrop':'48021','baylor':'48023','bee':'48025','bell':'48027','bexar':'48029','blanco':'48031','borden':'48033','bosque':'48035','bowie':'48037','brazoria':'48039','brazos':'48041','brewster':'48043','briscoe':'48045','brooks':'48047','brown':'48049','burleson':'48051','burnet':'48053','caldwell':'48055','calhoun':'48057','callahan':'48059','cameron':'48061','camp':'48063','carson':'48065','cass':'48067','castro':'48069','chambers':'48071','cherokee':'48073','childress':'48075','clay':'48077','cochran':'48079','coke':'48081','coleman':'48083','collin':'48085','collingsworth':'48087','colorado':'48089','comal':'48091','comanche':'48093','concho':'48095','cooke':'48097','coryell':'48099','cottle':'48101','crane':'48103','crockett':'48105','crosby':'48107','culberson':'48109','dallam':'48111','dallas':'48113','dawson':'48115','deaf smith':'48117','delta':'48119','denton':'48121','dewitt':'48123','dickens':'48125','dimmit':'48127','donley':'48129','duval':'48131','eastland':'48133','ector':'48135','edwards':'48137','ellis':'48139','el paso':'48141','erath':'48143','falls':'48145','fannin':'48147','fayette':'48149','fisher':'48151','floyd':'48153','foard':'48155','fort bend':'48157','franklin':'48159','freestone':'48161','frio':'48163','gaines':'48165','galveston':'48167','garza':'48169','gillespie':'48171','glasscock':'48173','goliad':'48175','gonzales':'48177','gray':'48179','grayson':'48181','gregg':'48183','grimes':'48185','guadalupe':'48187','hale':'48189','hall':'48191','hamilton':'48193','hansford':'48195','hardeman':'48197','hardin':'48199','harris':'48201','harrison':'48203','hartley':'48205','haskell':'48207','hays':'48209','hemphill':'48211','henderson':'48213','hidalgo':'48215','hill':'48217','hockley':'48219','hood':'48221','hopkins':'48223','houston':'48225','howard':'48227','hudspeth':'48229','hunt':'48231','hutchinson':'48233','irion':'48235','jack':'48237','jackson':'48239','jasper':'48241','jeff davis':'48243','jefferson':'48245','jim hogg':'48247','jim wells':'48249','johnson':'48251','jones':'48253','karnes':'48255','kaufman':'48257','kendall':'48259','kenedy':'48261','kent':'48263','kerr':'48265','kimble':'48267','king':'48269','kinney':'48271','kleberg':'48273','knox':'48275','lamar':'48277','lamb':'48279','lampasas':'48281','la salle':'48283','lavaca':'48285','lee':'48287','leon':'48289','liberty':'48291','limestone':'48293','lipscomb':'48295','live oak':'48297','llano':'48299','loving':'48301','lubbock':'48303','lynn':'48305','madison':'48313','marion':'48315','martin':'48317','mason':'48319','matagorda':'48321','maverick':'48323','mcculloch':'48307','mclennan':'48309','mcmullen':'48311','medina':'48325','menard':'48327','midland':'48329','milam':'48331','mills':'48333','mitchell':'48335','montague':'48337','montgomery':'48339','moore':'48341','morris':'48343','motley':'48345','nacogdoches':'48347','navarro':'48349','newton':'48351','nolan':'48353','nueces':'48355','ochiltree':'48357','oldham':'48359','orange':'48361','palo pinto':'48363','panola':'48365','parker':'48367','parmer':'48369','pecos':'48371','polk':'48373','potter':'48375','presidio':'48377','rains':'48379','randall':'48381','reagan':'48383','real':'48385','red river':'48387','reeves':'48389','refugio':'48391','roberts':'48393','robertson':'48395','rockwall':'48397','runnels':'48399','rusk':'48401','sabine':'48403','san augustine':'48405','san jacinto':'48407','san patricio':'48409','san saba':'48411','schleicher':'48413','scurry':'48415','shackelford':'48417','shelby':'48419','sherman':'48421','smith':'48423','somervell':'48425','starr':'48427','stephens':'48429','sterling':'48431','stonewall':'48433','sutton':'48435','swisher':'48437','tarrant':'48439','taylor':'48441','terrell':'48443','terry':'48445','throckmorton':'48447','titus':'48449','tom green':'48451','travis':'48453','trinity':'48455','tyler':'48457','upshur':'48459','upton':'48461','uvalde':'48463','val verde':'48465','van zandt':'48467','victoria':'48469','walker':'48471','waller':'48473','ward':'48475','washington':'48477','webb':'48479','wharton':'48481','wheeler':'48483','wichita':'48485','wilbarger':'48487','willacy':'48489','williamson':'48491','wilson':'48493','winkler':'48495','wise':'48497','wood':'48499','yoakum':'48501','young':'48503','zapata':'48505','zavala':'48507'
};
const fips = (c) => c ? (COUNTY_FIPS[c.trim().toLowerCase()] || null) : null;

async function upsertBatch(rows) {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/contractors`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
      Prefer: "resolution=merge-duplicates,return=minimal",
    },
    body: JSON.stringify(rows),
  });
  if (!res.ok) console.error("  upsert error:", res.status, (await res.text()).slice(0, 300));
}

// ── confirmed offsets from the live test dump ──
const I = {
  license_type: 0, license_number: 1, license_exp: 2,
  license_county: 3, name: 4,
  mail_csz: 7, phone: 8,
  business_name: 9, business_csz: 12,
  business_county: 14, business_zip: 15, business_phone: 16,
  license_subtype: 17,
};

(async () => {
  for (const src of SOURCES) {
    console.log(`\n=== ${src.trade.toUpperCase()} — ${src.url}`);
    const resp = await fetch(src.url);
    if (!resp.ok) { console.error("  download failed:", resp.status); continue; }
    const text = await resp.text();
    const lines = text.split(/\r?\n/).filter(l => l.trim());
    console.log(`  ${lines.length} lines`);

    // ── TEST MODE: dump first 3 rows, write nothing ──
    if (TEST_MODE) {
      for (let r = 0; r < Math.min(3, lines.length); r++) {
        const cols = parseCsvLine(lines[r]);
        console.log(`\n  --- row ${r} (${cols.length} cols) ---`);
        cols.forEach((c, i) => console.log(`    [${i}] ${c}`));
      }
      console.log("\n  TEST_MODE on — no data written.");
      continue;
    }

    // ── LOAD MODE ──
    const hasHeader = /license/i.test(lines[0]);
    const start = hasHeader ? 1 : 0;

    let batch = [], total = 0;
    for (let r = start; r < lines.length; r++) {
      const c = parseCsvLine(lines[r]);
      if (c.length < 17) continue;
      const county = c[I.business_county] || c[I.license_county] || "";
      batch.push({
        app_id: "flowstate",
        trade: src.trade,
        license_type: src.license_type,
        license_number: c[I.license_number] || null,
        license_subtype: c[I.license_subtype] || null,
        license_exp: parseDate(c[I.license_exp]),
        name: c[I.name] || null,
        business_name: c[I.business_name] || c[I.name] || null,
        phone: c[I.business_phone] || c[I.phone] || null,
        business_phone: c[I.business_phone] || null,
        business_city: cityOf(c[I.business_csz]),
        mailing_city: cityOf(c[I.mail_csz]),
        business_county: county || null,
        business_zip: c[I.business_zip] || null,
        fips: fips(county),
        source: "TDLR",
      });
      if (batch.length >= 500) { await upsertBatch(batch); total += batch.length; batch = []; console.log(`  ${total} upserted`); }
    }
    if (batch.length) { await upsertBatch(batch); total += batch.length; }
    console.log(`  ${src.trade}: ${total} contractors loaded`);
  }
  console.log("\nDone.");
})();
