const fs   = require("fs");
const path = require("path");

const SUPABASE_URL  = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY  = process.env.SUPABASE_SECRET_KEY || "";
const MAPBOX_TOKEN  = process.env.MAPBOX_TOKEN || "";
const PAGE_SIZE     = 1000;
const DELAY_MS      = 50;

async function getUngeocodedRecords(offset = 0) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?select=id,address,county,state&latitude=is.null&limit=${PAGE_SIZE}&offset=${offset}`,
    {
      headers: {
        apikey:        SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
      }
    }
  );
  return res.json();
}

async function geocodeAddress(address, county, state) {
  if (!address || address.trim().length < 5) return null;

  // Don't append county/state if address already contains TX
  const hasState = /,?\s*TX\s+\d{5}/.test(address) || address.includes(", TX");
  const fullAddress = hasState
    ? address.trim()
    : `${address}, ${county || ""} County, TX`.replace(/\s+/g, " ").trim();

  const encoded = encodeURIComponent(fullAddress);
  const url     = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encoded}.json?country=US&limit=1&access_token=${MAPBOX_TOKEN}`;

  try {
    const res  = await fetch(url);
    const data = await res.json();
    if (data.features && data.features.length > 0) {
      const [lng, lat] = data.features[0].center;
      return { lat, lng };
    }
  } catch (e) {
    console.log(`    [geocode error] ${address}: ${e.message}`);
  }
  return null;
}

async function updateCoords(id, lat, lng) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        apikey:         SUPABASE_KEY,
        Authorization:  `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer:         "return=minimal",
      },
      body: JSON.stringify({
        latitude:    lat,
        longitude:   lng,
        geocoded_at: new Date().toISOString(),
      }),
    }
  );
  return res.ok;
}

(async () => {
  console.log("FlowState TABS Geocoder v2");
  console.log("─".repeat(50));

  let totalGeocoded = 0;
  let totalFailed   = 0;
  let offset        = 0;
  let hasMore       = true;

  while (hasMore) {
    console.log(`\nFetching records ${offset}...`);
    const records = await getUngeocodedRecords(offset);

    if (!records || records.length === 0) {
      console.log("No more ungeocoded records.");
      hasMore = false;
      break;
    }

    console.log(`Processing ${records.length} records...`);

    for (const record of records) {
      const coords = await geocodeAddress(record.address, record.county, record.state);
      if (coords) {
        const ok = await updateCoords(record.id, coords.lat, coords.lng);
        if (ok) {
          totalGeocoded++;
          if (totalGeocoded % 100 === 0) console.log(`  [progress] ${totalGeocoded} geocoded`);
        }
      } else {
        totalFailed++;
      }
      await new Promise(r => setTimeout(r, DELAY_MS));
    }

    offset += PAGE_SIZE;
    if (records.length < PAGE_SIZE) hasMore = false;
  }

  console.log(`\n✓ Done — Geocoded: ${totalGeocoded} | Failed: ${totalFailed}`);
})();
