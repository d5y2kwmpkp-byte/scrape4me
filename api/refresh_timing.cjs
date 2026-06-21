const SUPABASE_URL = "https://ewmtownoxnaghhlobeci.supabase.co";
const SUPABASE_KEY = process.env.SUPABASE_SECRET_KEY || "";

(async () => {
  const res = await fetch(`${SUPABASE_URL}/rest/v1/rpc/refresh_timing`, {
    method: "POST",
    headers: {
      apikey: SUPABASE_KEY,
      Authorization: `Bearer ${SUPABASE_KEY}`,
      "Content-Type": "application/json",
    },
    body: "{}",
  });

  if (!res.ok) {
    console.error("refresh_timing failed:", res.status, await res.text());
    process.exit(1);
  }
  const count = await res.json();
  console.log(`timing refresh complete — ${count} rows stamped`);
})();
