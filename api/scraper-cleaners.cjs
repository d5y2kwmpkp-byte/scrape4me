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
function parseAddress(raw) {
  if (!raw) return { city: null, zip: null };
  const zipMatch = String(raw).match(/\b(\d{5})\b/);
  const zip = zipMatch ? zipMatch[1] : null;
  // city = word(s) right before ', TX'
  const cityMatch = String(raw).match(/([A-Za-z\s]+),\s*TX/);
  const city = cityMatch ? cityMatch[1].trim() : null;
  return { city, zip };
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

  return {
    id: raw.id,
    tabs_number: raw.tabs_number,
    project_name: raw.project_name || null,
    facility_name: raw.facility_name || null,

    estimated_cost: cost,
    square_footage: sqft,
    cost_per_sqft: cost && sqft ? parseFloat((cost / sqft).toFixed(2)) : null,

    type_of_work: cleanTypeOfWork(raw.type_of_work),
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

module.exports = { buildCleanRow, cleanCost, cleanSqft, cleanRas, normalizeEntity, costFlag };
