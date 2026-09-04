// ════════════════════════════════════════════════════════════════
// TABS SCRAPER — FIELD CLEANERS
// Drop these into your scraper before the Supabase insert.
// Each fixes a specific field-bleed bug seen in the raw data.
// ════════════════════════════════════════════════════════════════

// ── COST: '$1,506,445 Type' → 1506445.00 ────────────────────────
function cleanCost(raw) {
  if (!raw) return null;
  // strip everything except digits and decimal point
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

// ── SQFT: '110,719 ft 2 Are the' → 110719.00 ────────────────────
function cleanSqft(raw) {
  if (!raw) return null;
  // take the first number group before 'ft'
  const match = String(raw).replace(/,/g, '').match(/(\d+(\.\d+)?)/);
  return match ? parseFloat(match[1]) : null;
}

// ── TYPE OF WORK: 'Renovation/Alteration Type' → 'Renovation/Alteration'
function cleanTypeOfWork(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s*Type\s*$/i, '').trim();
}

// ── WORK TYPE: the TDLR enum -> the app's three-way axis ────────
// tabs_projects.work_type was NEVER written by this file. It exists only
// because of a one-off UPDATE on 2026-08-09, so every row scraped since has
// carried a null and the NEW CONSTRUCTION filter has been blind to all new
// intake. type_of_work itself is clean and has no nulls, so the derivation
// is free — it just has to actually happen on the way in.
//
// \bnew\b, not includes('new'): "Renewal" contains "new" and is not a
// ground-up build. Order matters — check new before addition before renovation.
function workType(typeOfWork) {
  if (!typeOfWork) return null;
  const t = String(typeOfWork).toLowerCase();
  if (/\bnew\b/.test(t)) return 'new_construction';
  if (/\baddition/.test(t)) return 'addition';
  if (/renovat|alterat|remodel|repair/.test(t)) return 'renovation';
  return null;   // unmapped rather than guessed — a null is auditable
}

// ── STATUS: 'Review Complete PERSON FILING FORM' → 'Review Complete'
function cleanStatus(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s*PERSON FILING FORM\s*$/i, '').trim();
}

// ── DESIGN FIRM: 'Insite Design Design' → 'Insite Design' ────────
function cleanDesignFirm(raw) {
  if (!raw) return null;
  return String(raw).replace(/\s+Design\s*$/i, '').trim();
}

// ── RAS NAME: 'ANDY S,CASTILLO RAS #: 1464' → 'ANDY S, CASTILLO' +1464
function cleanRas(raw) {
  if (!raw) return { name: null, number: null };
  const numMatch = String(raw).match(/RAS\s*#:\s*(\d+)/i);
  const number = numMatch ? numMatch[1] : null;
  const name = String(raw)
    .replace(/RAS\s*#:\s*\d+/i, '')
    .replace(/,/g, ', ')          // 'ANDY S,CASTILLO' → 'ANDY S, CASTILLO'
    .replace(/\s+/g, ' ')
    .trim();
  return { name: name || null, number };
}

// ── RAS PHONE: '(210) 393-4285 OWNER' → '(210) 393-4285' ────────
function cleanPhone(raw) {
  if (!raw) return null;
  const match = String(raw).match(/\(?\d{3}\)?[\s.-]?\d{3}[\s.-]?\d{4}/);
  return match ? match[0].trim() : null;
}

// ── FUND CATEGORY from type_of_funds text ───────────────────────
function cleanFundCategory(raw) {
  if (!raw) return null;
  const t = String(raw).toLowerCase();
  if (t.includes('public')) return 'public';
  if (t.includes('private')) return 'private';
  return null;
}

// ── ADDRESS PARSER: split 'City, TX 78251' tail ─────────────────
// The old version matched /([A-Za-z\s]+),\s*TX/, which grabs the longest run
// of letters and spaces before ", TX" — so "Suite #P Houston, TX" yielded
// "P Houston" and "48th Floor Houston, TX" yielded "Floor Houston". Those
// went straight into tabs_projects.city.
//
// Walk the segment instead and drop everything up to the last token that
// cannot be part of a city name: anything containing a digit, a unit marker,
// or a street-type suffix. What survives is the city.
//
// This is still a heuristic on a free-text field. geocode_texbuild.cjs
// overwrites city from the Mapbox `place` context when it geocodes, which is
// a spatial answer rather than a regex, and that one wins.
const UNIT_TOKEN   = /^(ste|suite|apt|apts|unit|bldg|building|fl|floor|rm|room|lot|blk|block|#)\.?$/i;
const STREET_TOKEN = /^(st|street|rd|road|dr|drive|ave|avenue|blvd|boulevard|ln|lane|way|ct|court|cir|circle|pkwy|parkway|hwy|highway|fwy|freeway|expy|expressway|trl|trail|ter|terrace|pl|place|loop|bnd|bend|cv|cove|xing|crossing|pass|run|row|walk|plz|plaza|sq|square|frontage|service|bus|byp|bypass|spur|alt|fm|rr)\.?$/i;

function parseAddress(raw) {
  if (!raw) return { city: null, zip: null };
  const s = String(raw);
  const zipMatch = s.match(/\b(\d{5})(?:-\d{4})?\b/);
  const zip = zipMatch ? zipMatch[1] : null;

  const seg = s.match(/([^,]+),\s*(?:TX|TEXAS)\b/i);
  if (!seg) return { city: null, zip };

  const tokens = seg[1].trim().split(/\s+/).filter(Boolean);
  let start = 0;
  tokens.forEach((t, i) => {
    if (/\d/.test(t) || t.startsWith('#') || UNIT_TOKEN.test(t) || STREET_TOKEN.test(t)) {
      start = i + 1;
    }
  });

  let city = tokens.slice(start).join(' ').trim();
  // Nothing survived (the whole segment was a street) — fall back to the tail,
  // which is where the city sits in every well-formed TDLR address.
  if (!city) city = tokens.slice(-1).join(' ').trim();
  // A stray directional or initial left on the front is noise, not a city.
  let parts = city.split(/\s+/);
  if (parts.length > 1 && parts[0].length <= 2) parts.shift();
  // No Texas city is more than three words. Anything longer means the address
  // had no street suffix to cut on ("...across from Colt Elementary Marble
  // Falls") and the tail is the best available guess.
  if (parts.length > 3) parts = parts.slice(-2);
  city = parts.join(' ');

  return { city: city || null, zip };
}

// ── NORMALIZE ENTITY NAME for grouping ──────────────────────────
// 'Reserve Capital - Westover Office SPE LLC' → 'RESERVE CAPITAL WESTOVER OFFICE SPE'
function normalizeEntity(raw) {
  if (!raw) return null;
  return String(raw)
    .toUpperCase()
    .replace(/\b(LLC|L\.L\.C\.|INC|INC\.|LP|L\.P\.|LTD|PLLC|SPE|CORP|CO)\b/g, '')
    .replace(/[^A-Z0-9\s]/g, ' ')
    .replace(/\s+/g, ' ')
    .trim();
}

// ── COST SANITY FLAG ────────────────────────────────────────────
// Catches the $109M-warehouse-on-12k-sqft type errors
function costFlag(cost, sqft) {
  if (!cost) return null;

  // Placeholder sqft on a real cost = missing-sqft infrastructure.
  // Dollars are trustworthy; only the footprint is fake.
  if (sqft != null && sqft < 100) {
    return cost > 0 ? 'missing_sqft' : null;
  }

  // Genuinely large — needs eyeball, but keep (many are real public works)
  if (cost > 50_000_000) return 'review_high';

  // Real footprint, absurd cost-per-sqft = true anomaly
  if (sqft && sqft > 0 && (cost / sqft) > 2000) return 'review_cps';

  return null;
}


// ── VELOCITY ────────────────────────────────────────────────────
function velocityDays(regDate, startDate) {
  if (!regDate || !startDate) return null;
  const r = new Date(regDate), s = new Date(startDate);
  const days = Math.floor((s - r) / (1000 * 60 * 60 * 24));
  return days >= 0 ? days : null;
}

// ════════════════════════════════════════════════════════════════
// ASSEMBLE A CLEAN ROW
// Map your raw scraped object → clean row ready for tabs_projects_v2
// ════════════════════════════════════════════════════════════════
function buildCleanRow(raw, registrationDate) {
  const cost = cleanCost(raw.estimated_cost);
  const sqft = cleanSqft(raw.square_footage);
  const ras = cleanRas(raw.ras_name);
  const addr = parseAddress(raw.address);
  const typeOfWork = cleanTypeOfWork(raw.type_of_work);

  return {
    id: raw.id,
    tabs_number: raw.tabs_number,
    project_name: raw.project_name || null,
    facility_name: raw.facility_name || null,

    // estimated_cost / square_footage are the TEXT columns and keep holding
    // the cleaned number, exactly as before — nothing downstream changes.
    // What was missing is the NUMERIC pair the app actually does arithmetic
    // on. Neither was ever written here, which is why estimated_cost_num was
    // null on 100% of recent intake and every cost signal was dark.
    estimated_cost: cost,
    estimated_cost_num: cost,
    square_footage: sqft,
    square_footage_num: sqft,
    cost_per_sqft: cost && sqft ? parseFloat((cost / sqft).toFixed(2)) : null,

    type_of_work: typeOfWork,
    work_type: workType(typeOfWork),
    fund_category: cleanFundCategory(raw.type_of_funds),
    scope_of_work: raw.scope_of_work || null,
    project_category: raw.project_category || null,

    registration_date: registrationDate || null,   // pull from TABS detail page
    start_date: raw.start_date || null,
    completion_date: raw.completion_date || null,
    velocity_days: velocityDays(registrationDate, raw.start_date),

    address: raw.address || null,
    city: addr.city,
    county: raw.county || null,
    state: raw.state || 'TX',
    zip: addr.zip,
    latitude: raw.latitude ? parseFloat(raw.latitude) : null,
    longitude: raw.longitude ? parseFloat(raw.longitude) : null,
    geocoded_at: raw.geocoded_at || null,
    geocode_failed: raw.geocode_failed || false,

    owner_name: raw.owner_name || null,
    owner_name_norm: normalizeEntity(raw.owner_name),
    owner_address: raw.owner_address || null,
    owner_phone: cleanPhone(raw.owner_phone),
    owner_contact: raw.owner_contact || null,

    tenant_name: raw.tenant_name || null,
    tenant_phone: cleanPhone(raw.tenant_phone),

    design_firm_name: cleanDesignFirm(raw.design_firm_name),
    design_firm_norm: normalizeEntity(cleanDesignFirm(raw.design_firm_name)),
    design_firm_address: raw.design_firm_address || null,
    design_firm_phone: cleanPhone(raw.design_firm_phone),

    ras_name: ras.name,
    ras_number: ras.number || raw.ras_number || null,
    ras_phone: cleanPhone(raw.ras_phone),

    contact_name: raw.contact_name || null,
    status: cleanStatus(raw.status),

    cost_flag: costFlag(cost, sqft),

    source: 'TDLR_TABS',
    source_url: `https://www.tdlr.texas.gov/TABS/Search/Project/${raw.id}`,
    fetched_at: raw.fetched_at || new Date().toISOString(),
  };
}

module.exports = { buildCleanRow, cleanCost, cleanSqft, cleanRas, normalizeEntity, costFlag, workType, parseAddress };
