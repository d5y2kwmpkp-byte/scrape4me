// ════════════════════════════════════════════════════════════════
// FLOWSTATE TABS SCRAPER — FIELD CLEANERS  (FlowState-only copy)
// Separate from TexBuildIntel's scraper-cleaners.cjs so changes here
// (category + fips) never touch the TexBuildIntel pipeline.
// ════════════════════════════════════════════════════════════════

// ── COST: '$1,506,445 Type' → 1506445.00 ────────────────────────
function cleanCost(raw) {
  if (!raw) return null;
  const num = parseFloat(String(raw).replace(/[^0-9.]/g, ''));
  return isNaN(num) ? null : num;
}

// ── SQFT: '110,719 ft 2 Are the' → 110719.00 ────────────────────
function cleanSqft(raw) {
  if (!raw) return null;
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
    .replace(/,/g, ', ')
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
  const cityMatch = String(raw).match(/([A-Za-z\s]+),\s*TX/);
  const city = cityMatch ? cityMatch[1].trim() : null;
  return { city, zip };
}

// ── NORMALIZE ENTITY NAME for grouping ──────────────────────────
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
function costFlag(cost, sqft) {
  if (!cost) return null;
  if (sqft != null && sqft < 100) {
    return cost > 0 ? 'missing_sqft' : null;
  }
  if (cost > 50_000_000) return 'review_high';
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
// NEW — PROJECT CATEGORY  (keyword v3, ~75%; LLM pass lifts to ~90%)
// Reads name + facility + scope. Order matters: specific/steal-prone
// categories first, weak catch-alls (office) last before general.
// ════════════════════════════════════════════════════════════════
function categorizeProject(name, facility, scope) {
  const txt = (String(name || '') + ' ' + String(facility || '') + ' ' + String(scope || '')).toLowerCase();
  const m = (re) => re.test(txt);

  if (m(/data center|data hall|colo|data module/)) return 'data_center';
  if (m(/hospital|medical|clinic|surgery|patient|dental|periodont|primary care|behavioral health|cath lab|nicu|\bicu\b|health care|healthcare|infusion|imaging center|urgent care|physical therapy|chiropractic|pharmacy/)) return 'healthcare';
  if (m(/assisted living|senior living|nursing home|memory care|retirement community/)) return 'senior_living';
  if (m(/daycare|child care|childcare|early childhood|preschool|learning experience/)) return 'childcare';
  if (m(/church|worship|temple|mosque|synagogue|chapel|parish|baptist|catholic|methodist|ministry|congregation/)) return 'religious';
  if (m(/\bschool\b|\bisd\b|elementary|high school|middle school|university|college|\bcampus\b|academy of|classroom building/)) return 'education';
  if (m(/gasoline|fuel sales|fuel canopy|fueling|gas pump|gas station|c-store|convenience store|travel stop|travel center|truck stop|quiktrip|racetrac|buc-ee|7-eleven|7-11|7 eleven|circle.k|love's|loves travel|murphy usa|corner store|stripes|kwik|underground storage tank|\bust\b/)) return 'gas_station';
  if (m(/bank|credit union|wells fargo|chase|navy federal|nfcu|financial center/)) return 'financial';
  if (m(/hotel|motel|resort|marriott|hilton|hyatt| inn |guestroom|hospitality/)) return 'hospitality';
  if (m(/wastewater|water treatment|water reclamation|sewer|pump station|lift station|substation|water plant/)) return 'utility';
  if (m(/warehouse|distribution center|logistics|manufacturing|fabrication|distillery|blendery|brewery|refinery|\bplant\b/)) return 'industrial';
  if (m(/fire station|police|courthouse|city hall|library|civic center|municipal/)) return 'civic';
  if (m(/splashpad|amenity center|recreation|\btrail\b|fitness|\bgym\b|boot camp|athletic|sports complex|workout|pilates|country club|golf|ninja/)) return 'recreation';
  if (m(/ev charg|charging station|electric vehicle/)) return 'ev_charging';
  if (m(/restaurant|cafe|coffee|sandwich|kitchen|dining|eatery|drive.thru|fast food|grill|smoothie|brew|bakery|yogurt|mcdonald|\bmcd\b|taco bell|burger king|wendy|chipotle|panda|popeye|raising cane|sonic|dairy queen|jack in the box|wingstop|jersey mike|firehouse|jimmy john|chili|applebee|chick.fil|\bcfa\b|dunkin|starbucks|pizza|domino|papa john|little caesar|\bkfc\b|whataburger|in-n-out|five guys|culver|zaxby|bojangle|del taco|panera|qdoba|chuy|torchy|layne|slim chicken|crumbl|dutch bros|jets pizza|mo bettah|16 handles|portillo|first watch|juice bar/)) return 'restaurant';
  if (m(/retail|\bstore\b|\bshop\b|mall|grocery|\bmarket\b|showroom|boutique|shopping center|dollar tree|dollar general|walmart|target|homegoods|home goods|academy sports|chair king|victoria|great clips|salon/)) return 'retail';
  if (m(/roadway|highway|\broad\b|bridge|csj:|frontage|interchange|\bih |\bsh |\bus [0-9]|\bfm [0-9]|sidewalk|pedestrian|traffic signal|paving|street improvement|curb ramp|crosswalk/)) return 'infrastructure';
  if (m(/apartment|residential|multifamily|condo|housing|dormitory|\bdorm\b|townhome|clubhouse|model home/)) return 'residential';
  if (m(/self storage|mini storage|storage facility/)) return 'storage';
  if (m(/parking garage|parking structure|parking lot/)) return 'parking';
  if (m(/office|corporate|headquarters|\bhq\b|\bsuite\b|tower/)) return 'office';
  return 'general';
}

// ════════════════════════════════════════════════════════════════
// NEW — COUNTY → FIPS  (5-digit, Texas state 48 + county code)
// Matches plain county names (case-insensitive, trimmed). 254 counties.
// ════════════════════════════════════════════════════════════════
const COUNTY_FIPS = {
  'anderson':'48001','andrews':'48003','angelina':'48005','aransas':'48007','archer':'48009',
  'armstrong':'48011','atascosa':'48013','austin':'48015','bailey':'48017','bandera':'48019',
  'bastrop':'48021','baylor':'48023','bee':'48025','bell':'48027','bexar':'48029',
  'blanco':'48031','borden':'48033','bosque':'48035','bowie':'48037','brazoria':'48039',
  'brazos':'48041','brewster':'48043','briscoe':'48045','brooks':'48047','brown':'48049',
  'burleson':'48051','burnet':'48053','caldwell':'48055','calhoun':'48057','callahan':'48059',
  'cameron':'48061','camp':'48063','carson':'48065','cass':'48067','castro':'48069',
  'chambers':'48071','cherokee':'48073','childress':'48075','clay':'48077','cochran':'48079',
  'coke':'48081','coleman':'48083','collin':'48085','collingsworth':'48087','colorado':'48089',
  'comal':'48091','comanche':'48093','concho':'48095','cooke':'48097','coryell':'48099',
  'cottle':'48101','crane':'48103','crockett':'48105','crosby':'48107','culberson':'48109',
  'dallam':'48111','dallas':'48113','dawson':'48115','deaf smith':'48117','delta':'48119',
  'denton':'48121','dewitt':'48123','dickens':'48125','dimmit':'48127','donley':'48129',
  'duval':'48131','eastland':'48133','ector':'48135','edwards':'48137','el paso':'48141',
  'ellis':'48139','erath':'48143','falls':'48145','fannin':'48147','fayette':'48149',
  'fisher':'48151','floyd':'48153','foard':'48155','fort bend':'48157','franklin':'48159',
  'freestone':'48161','frio':'48163','gaines':'48165','galveston':'48167','garza':'48169',
  'gillespie':'48171','glasscock':'48173','goliad':'48175','gonzales':'48177','gray':'48179',
  'grayson':'48181','gregg':'48183','grimes':'48185','guadalupe':'48187','hale':'48189',
  'hall':'48191','hamilton':'48193','hansford':'48195','hardeman':'48197','hardin':'48199',
  'harris':'48201','harrison':'48203','hartley':'48205','haskell':'48207','hays':'48209',
  'hemphill':'48211','henderson':'48213','hidalgo':'48215','hill':'48217','hockley':'48219',
  'hood':'48221','hopkins':'48223','houston':'48225','howard':'48227','hudspeth':'48229',
  'hunt':'48231','hutchinson':'48233','irion':'48235','jack':'48237','jackson':'48239',
  'jasper':'48241','jeff davis':'48243','jefferson':'48245','jim hogg':'48247','jim wells':'48249',
  'johnson':'48251','jones':'48253','karnes':'48255','kaufman':'48257','kendall':'48259',
  'kenedy':'48261','kent':'48263','kerr':'48265','kimble':'48267','king':'48269',
  'kinney':'48271','kleberg':'48273','knox':'48275','la salle':'48283','lamar':'48277',
  'lamb':'48279','lampasas':'48281','lavaca':'48285','lee':'48287','leon':'48289',
  'liberty':'48291','limestone':'48293','lipscomb':'48295','live oak':'48297','llano':'48299',
  'loving':'48301','lubbock':'48303','lynn':'48305','madison':'48313','marion':'48315',
  'martin':'48317','mason':'48319','matagorda':'48321','maverick':'48323','mcculloch':'48307',
  'mclennan':'48309','mcmullen':'48311','medina':'48325','menard':'48327','midland':'48329',
  'milam':'48331','mills':'48333','mitchell':'48335','montague':'48337','montgomery':'48339',
  'moore':'48341','morris':'48343','motley':'48345','nacogdoches':'48347','navarro':'48349',
  'newton':'48351','nolan':'48353','nueces':'48355','ochiltree':'48357','oldham':'48359',
  'orange':'48361','palo pinto':'48363','panola':'48365','parker':'48367','parmer':'48369',
  'pecos':'48371','polk':'48373','potter':'48375','presidio':'48377','rains':'48379',
  'randall':'48381','reagan':'48383','real':'48385','red river':'48387','reeves':'48389',
  'refugio':'48391','roberts':'48393','robertson':'48395','rockwall':'48397','runnels':'48399',
  'rusk':'48401','sabine':'48403','san augustine':'48405','san jacinto':'48407','san patricio':'48409',
  'san saba':'48411','schleicher':'48413','scurry':'48415','shackelford':'48417','shelby':'48419',
  'sherman':'48421','smith':'48423','somervell':'48425','starr':'48427','stephens':'48429',
  'sterling':'48431','stonewall':'48433','sutton':'48435','swisher':'48437','tarrant':'48439',
  'taylor':'48441','terrell':'48443','terry':'48445','throckmorton':'48447','titus':'48449',
  'tom green':'48451','travis':'48453','trinity':'48455','tyler':'48457','upshur':'48459',
  'upton':'48461','uvalde':'48463','val verde':'48465','van zandt':'48467','victoria':'48469',
  'walker':'48471','waller':'48473','ward':'48475','washington':'48477','webb':'48479',
  'wharton':'48481','wheeler':'48483','wichita':'48485','wilbarger':'48487','willacy':'48489',
  'williamson':'48491','wilson':'48493','winkler':'48495','wise':'48497','wood':'48499',
  'yoakum':'48501','young':'48503','zapata':'48505','zavala':'48507'
};

function countyToFips(county) {
  if (!county) return null;
  return COUNTY_FIPS[String(county).trim().toLowerCase()] || null;
}

// ════════════════════════════════════════════════════════════════
// ASSEMBLE A CLEAN ROW  (FlowState)
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

    project_category: categorizeProject(raw.project_name, raw.facility_name, raw.scope_of_work),

    registration_date: registrationDate || null,
    start_date: raw.start_date || null,
    completion_date: raw.completion_date || null,
    velocity_days: velocityDays(registrationDate, raw.start_date),

    address: raw.address || null,
    city: addr.city,
    county: raw.county || null,
    state: raw.state || 'TX',
    zip: addr.zip,

    fips: countyToFips(raw.county),

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

module.exports = {
  buildCleanRow, cleanCost, cleanSqft, cleanRas, normalizeEntity, costFlag,
  categorizeProject, countyToFips,
};
