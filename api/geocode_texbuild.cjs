const SUPABASE_URL = "https://yoqcvjqojklemhxwvgby.supabase.co";
const SUPABASE_KEY = process.env.TEXBUILD_SUPABASE_KEY || "";
const MAPBOX_TOKEN = process.env.MAPBOX_TOKEN || "";
const PAGE_SIZE    = 1000;
const DELAY_MS     = 50;

async function getUngeocoded(offset = 0) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?select=id,address,county&latitude=is.null&limit=${PAGE_SIZE}&offset=${offset}`,
    { headers: { apikey: SUPABASE_KEY, Authorization: `Bearer ${SUPABASE_KEY}` } }
  );
  return res.json();
}

async function geocode(address, county) {
  if (!address || address.trim().length < 5) return null;
  const hasState = /,?\s*TX\s+\d{5}/.test(address) || address.includes(", TX");
  const full = hasState ? address.trim() : `${address}, ${county || ""} County, TX`.replace(/\s+/g, " ").trim();
  const url = `https://api.mapbox.com/geocoding/v5/mapbox.places/${encodeURIComponent(full)}.json?country=US&limit=1&access_token=${MAPBOX_TOKEN}`;
  try {
    const res = await fetch(url);
    const data = await res.json();
    if (data.features && data.features.length > 0) {
      const [lng, lat] = data.features[0].center;
      return { lat, lng };
    }
  } catch (e) {
    console.log(`  [geocode error] ${address}: ${e.message}`);
  }
  return null;
}

async function update(id, lat, lng) {
  const res = await fetch(
    `${SUPABASE_URL}/rest/v1/tabs_projects?id=eq.${encodeURIComponent(id)}`,
    {
      method: "PATCH",
      headers: {
        apikey: SUPABASE_KEY,
        Authorization: `Bearer ${SUPABASE_KEY}`,
        "Content-Type": "application/json",
        Prefer: "return=minimal",
      },
      body: JSON.stringify({
        latitude: lat,
        longitude: lng,
        geocoded_at: new Date().toISOString(),
        geocode_failed: false,
      }),
    }
  );
  return res.ok;
}

(async () => {
  console.log("TexasBuild Intel — Geocode Cleanup");
  console.log("─".repeat(50));
  if (!SUPABASE_KEY || !MAPBOX_TOKEN) {
    console.error("Missing TEXBUILD_SUPABASE_KEY or MAPBOX_TOKEN");
    process.exit(1);
  }

  let geocoded = 0, failed = 0, offset = 0, more = true;

  while (more) {
    const rows = await getUngeocoded(offset);
    if (!rows || rows.length === 0) { more = false; break; }
    console.log(`Processing ${rows.length} (offset ${offset})...`);

    for (const r of rows) {
      const c = await geocode(r.address, r.county);
      if (c) {
        if (await update(r.id, c.lat, c.lng)) {
          geocoded++;
          if (geocoded % 100 === 0) console.log(`  [progress] ${geocoded} geocoded`);
        }
      } else {
        failed++;
      }
      await new Promise(res => setTimeout(res, DELAY_MS));
    }
    offset += PAGE_SIZE;
    if (rows.length < PAGE_SIZE) more = false;
  }

  console.log(`\n✓ Done — Geocoded: ${geocoded} | Failed: ${failed}`);
})();
