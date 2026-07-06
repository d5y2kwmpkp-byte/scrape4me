// fetch-roads.mjs
// Pulls TxDOT interstate + US/SH highway geometry for each FlowState city
// and writes one GeoJSON file per city into /public/roads/.
// Runs on GitHub Actions (Node 20+ has global fetch). No browser needed.
//
// Output: public/roads/austin.geojson, sanantonio.geojson, houston.geojson, dfw.geojson
// Each file: { ih: [...features], ushs: [...features] }  (two tiers, pre-split)

import { mkdir, writeFile } from "node:fs/promises";

const TXDOT = "https://services.arcgis.com/KTcxiTD9dsQw4r7Z/arcgis/rest/services/TxDOT_Roadway_Status/FeatureServer/0/query";

// Same city centers as Command.jsx
const CITIES = [
  { key:"austin",     lon:-97.7431, lat:30.2672 },
  { key:"sanantonio", lon:-98.4936, lat:29.4241 },
  { key:"houston",    lon:-95.3698, lat:29.7604 },
  { key:"dfw",        lon:-96.9000, lat:32.7900 },
];

const R = 0.6; // bounding-box radius in degrees around each city

// One query to TxDOT. Handles the 2000-record transfer limit by paging
// with resultOffset until no more records come back.
async function fetchTier(city, whereClause){
  const xmin = city.lon-R, ymin = city.lat-R, xmax = city.lon+R, ymax = city.lat+R;
  let all = [];
  let offset = 0;
  const pageSize = 2000;
  while(true){
    const params = new URLSearchParams({
      where: whereClause,
      geometry: `${xmin},${ymin},${xmax},${ymax}`,
      geometryType: "esriGeometryEnvelope",
      inSR: "4326",
      spatialRel: "esriSpatialRelIntersects",
      outFields: "RTE_PRFX,RTE_NBR",
      outSR: "4326",
      returnGeometry: "true",
      resultOffset: String(offset),
      resultRecordCount: String(pageSize),
      f: "geojson",
    });
    const url = `${TXDOT}?${params.toString()}`;
    const res = await fetch(url);
    if(!res.ok){ throw new Error(`TxDOT ${res.status} for ${city.key} (${whereClause})`); }
    const gj = await res.json();
    const feats = (gj && gj.features) ? gj.features : [];
    all = all.concat(feats);
    // stop when we got less than a full page (no more records)
    if(feats.length < pageSize) break;
    offset += pageSize;
    if(offset > 20000){ break; } // safety cap
  }
  return all;
}

// Trim each feature down to just geometry (drop heavy properties we don't draw)
function slim(features){
  return features.map(f => ({ type:"Feature", geometry: f.geometry, properties: { p: f.properties?.RTE_PRFX, n: f.properties?.RTE_NBR } }));
}

async function main(){
  await mkdir("public/roads", { recursive:true });
  for(const city of CITIES){
    process.stdout.write(`Fetching ${city.key}… `);
    const ih   = slim(await fetchTier(city, "RTE_PRFX='IH'"));
    const ushs = slim(await fetchTier(city, "RTE_PRFX='US' OR RTE_PRFX='SH'"));
    const out = { city: city.key, ih, ushs, fetchedAt: new Date().toISOString() };
    await writeFile(`public/roads/${city.key}.geojson`, JSON.stringify(out));
    console.log(`✓ ${ih.length} interstate + ${ushs.length} US/SH segments`);
  }
  console.log("Done. Files in public/roads/");
}

main().catch(err => { console.error(err); process.exit(1); });
