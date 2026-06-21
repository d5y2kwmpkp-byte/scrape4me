const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

(async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refresh_maintenance`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!res.ok) {
    console.error("refresh_maintenance failed:", res.status, await res.text());
    process.exit(1);
  }
  const result = await res.json();
  console.log(`maintenance complete — timing: ${result.timing_stamped}, fips: ${result.fips_stamped}`);
})();
