import { useState } from "react";

const API_URL = "/api/scrape"; // same domain on Vercel

const pizza = "🍕";

export default function App() {
  const [location, setLocation] = useState("");
  const [results, setResults] = useState(null);
  const [loading, setLoading] = useState(false);
  const [error, setError] = useState(null);
  const [queried, setQueried] = useState("");

  async function handleScrape() {
    if (!location.trim()) return;
    setLoading(true);
    setError(null);
    setResults(null);
    setQueried(location);

    try {
      const res = await fetch(
        `${API_URL}?location=${encodeURIComponent(location)}`
      );
      const data = await res.json();

      if (!data.success) throw new Error(data.error || "Scrape failed");
      setResults(data);
    } catch (err) {
      setError(err.message);
    } finally {
      setLoading(false);
    }
  }

  return (
    <div style={styles.root}>
      <div style={styles.grain} />

      <header style={styles.header}>
        <div style={styles.logo}>
          <span style={styles.logoIcon}>⬡</span>
          <span style={styles.logoText}>DOMISCRAPE</span>
        </div>
        <p style={styles.tagline}>Google Maps · Playwright · Vercel</p>
      </header>

      <main style={styles.main}>
        <div style={styles.searchBox}>
          <div style={styles.inputRow}>
            <input
              style={styles.input}
              type="text"
              placeholder="Enter city, zip, or address..."
              value={location}
              onChange={(e) => setLocation(e.target.value)}
              onKeyDown={(e) => e.key === "Enter" && handleScrape()}
            />
            <button
              style={{
                ...styles.button,
                ...(loading ? styles.buttonLoading : {}),
              }}
              onClick={handleScrape}
              disabled={loading}
            >
              {loading ? (
                <span style={styles.spinner}>◌</span>
              ) : (
                "SCRAPE"
              )}
            </button>
          </div>
          <p style={styles.hint}>
            Searches Google Maps for Domino's locations near your query
          </p>
        </div>

        {error && (
          <div style={styles.errorBox}>
            <span style={styles.errorIcon}>✕</span>
            <div>
              <strong>Scrape failed</strong>
              <p style={styles.errorMsg}>{error}</p>
            </div>
          </div>
        )}

        {loading && (
          <div style={styles.loadingBlock}>
            <div style={styles.loadingDots}>
              <span style={{ ...styles.dot, animationDelay: "0ms" }} />
              <span style={{ ...styles.dot, animationDelay: "150ms" }} />
              <span style={{ ...styles.dot, animationDelay: "300ms" }} />
            </div>
            <p style={styles.loadingText}>
              Launching browser · navigating Maps · extracting results...
            </p>
          </div>
        )}

        {results && (
          <div style={styles.results}>
            <div style={styles.resultsHeader}>
              <span style={styles.count}>{results.count}</span>
              <span style={styles.countLabel}>
                {results.count === 1 ? "location" : "locations"} near{" "}
                <strong>{queried}</strong>
              </span>
            </div>

            {results.count === 0 && (
              <div style={styles.empty}>
                {pizza} No Domino's found — try a broader location
              </div>
            )}

            <div style={styles.grid}>
              {results.locations.map((loc, i) => (
                <LocationCard key={i} loc={loc} index={i} />
              ))}
            </div>
          </div>
        )}
      </main>

      <style>{`
        @import url('https://fonts.googleapis.com/css2?family=Space+Mono:wght@400;700&family=Syne:wght@600;800&display=swap');

        * { box-sizing: border-box; margin: 0; padding: 0; }

        body { background: #0a0a0a; }

        @keyframes spin {
          to { transform: rotate(360deg); }
        }
        @keyframes pulse {
          0%, 100% { opacity: 0.2; transform: scale(0.8); }
          50% { opacity: 1; transform: scale(1); }
        }
        @keyframes fadeUp {
          from { opacity: 0; transform: translateY(12px); }
          to { opacity: 1; transform: translateY(0); }
        }
      `}</style>
    </div>
  );
}

function LocationCard({ loc, index }) {
  return (
    <div
      style={{
        ...styles.card,
        animationDelay: `${index * 60}ms`,
      }}
    >
      <div style={styles.cardTop}>
        <span style={styles.cardIndex}>
          {String(index + 1).padStart(2, "0")}
        </span>
        {loc.rating && (
          <span style={styles.rating}>★ {loc.rating}</span>
        )}
      </div>

      <h3 style={styles.cardName}>{loc.name}</h3>

      {loc.details?.length > 0 && (
        <div style={styles.cardDetails}>
          {loc.details.slice(0, 3).map((d, i) => (
            <span key={i} style={styles.detail}>
              {d}
            </span>
          ))}
        </div>
      )}

      {loc.hours && (
        <div style={styles.hours}>{loc.hours}</div>
      )}

      {loc.link && (
        <a
          href={loc.link}
          target="_blank"
          rel="noopener noreferrer"
          style={styles.mapLink}
        >
          Open in Maps ↗
        </a>
      )}
    </div>
  );
}

const styles = {
  root: {
    minHeight: "100vh",
    background: "#0a0a0a",
    color: "#f0ece4",
    fontFamily: "'Space Mono', monospace",
    position: "relative",
    overflow: "hidden",
  },
  grain: {
    position: "fixed",
    inset: 0,
    backgroundImage: `url("data:image/svg+xml,%3Csvg viewBox='0 0 256 256' xmlns='http://www.w3.org/2000/svg'%3E%3Cfilter id='noise'%3E%3CfeTurbulence type='fractalNoise' baseFrequency='0.9' numOctaves='4' stitchTiles='stitch'/%3E%3C/filter%3E%3Crect width='100%25' height='100%25' filter='url(%23noise)' opacity='0.04'/%3E%3C/svg%3E")`,
    backgroundRepeat: "repeat",
    backgroundSize: "128px",
    pointerEvents: "none",
    zIndex: 0,
  },
  header: {
    padding: "48px 32px 24px",
    position: "relative",
    zIndex: 1,
    borderBottom: "1px solid #1e1e1e",
  },
  logo: {
    display: "flex",
    alignItems: "center",
    gap: "10px",
  },
  logoIcon: {
    fontSize: "22px",
    color: "#e8441a",
    lineHeight: 1,
  },
  logoText: {
    fontFamily: "'Syne', sans-serif",
    fontSize: "24px",
    fontWeight: 800,
    letterSpacing: "0.12em",
    color: "#f0ece4",
  },
  tagline: {
    marginTop: "6px",
    fontSize: "11px",
    color: "#555",
    letterSpacing: "0.08em",
  },
  main: {
    maxWidth: "760px",
    margin: "0 auto",
    padding: "48px 24px",
    position: "relative",
    zIndex: 1,
  },
  searchBox: {
    marginBottom: "40px",
  },
  inputRow: {
    display: "flex",
    gap: "12px",
  },
  input: {
    flex: 1,
    background: "#111",
    border: "1px solid #2a2a2a",
    borderRadius: "4px",
    padding: "14px 16px",
    color: "#f0ece4",
    fontFamily: "'Space Mono', monospace",
    fontSize: "14px",
    outline: "none",
    transition: "border-color 0.2s",
  },
  button: {
    background: "#e8441a",
    border: "none",
    borderRadius: "4px",
    padding: "14px 24px",
    color: "#fff",
    fontFamily: "'Syne', sans-serif",
    fontWeight: 700,
    fontSize: "13px",
    letterSpacing: "0.1em",
    cursor: "pointer",
    minWidth: "100px",
    transition: "background 0.2s",
  },
  buttonLoading: {
    background: "#333",
    cursor: "not-allowed",
  },
  spinner: {
    display: "inline-block",
    animation: "spin 1s linear infinite",
    fontSize: "18px",
  },
  hint: {
    marginTop: "10px",
    fontSize: "11px",
    color: "#444",
    letterSpacing: "0.04em",
  },
  errorBox: {
    display: "flex",
    gap: "14px",
    alignItems: "flex-start",
    background: "#1a0a0a",
    border: "1px solid #5a1a1a",
    borderRadius: "4px",
    padding: "16px 20px",
    marginBottom: "24px",
  },
  errorIcon: {
    color: "#e8441a",
    fontWeight: 700,
    fontSize: "16px",
    marginTop: "1px",
  },
  errorMsg: {
    marginTop: "4px",
    fontSize: "12px",
    color: "#888",
    fontFamily: "'Space Mono', monospace",
  },
  loadingBlock: {
    textAlign: "center",
    padding: "60px 0",
  },
  loadingDots: {
    display: "flex",
    justifyContent: "center",
    gap: "8px",
    marginBottom: "20px",
  },
  dot: {
    width: "8px",
    height: "8px",
    borderRadius: "50%",
    background: "#e8441a",
    display: "inline-block",
    animation: "pulse 1.2s ease-in-out infinite",
  },
  loadingText: {
    fontSize: "11px",
    color: "#555",
    letterSpacing: "0.06em",
  },
  results: {
    animation: "fadeUp 0.4s ease forwards",
  },
  resultsHeader: {
    display: "flex",
    alignItems: "baseline",
    gap: "10px",
    marginBottom: "24px",
    paddingBottom: "16px",
    borderBottom: "1px solid #1e1e1e",
  },
  count: {
    fontFamily: "'Syne', sans-serif",
    fontSize: "36px",
    fontWeight: 800,
    color: "#e8441a",
    lineHeight: 1,
  },
  countLabel: {
    fontSize: "13px",
    color: "#666",
  },
  empty: {
    textAlign: "center",
    padding: "60px 0",
    color: "#555",
    fontSize: "14px",
  },
  grid: {
    display: "flex",
    flexDirection: "column",
    gap: "12px",
  },
  card: {
    background: "#111",
    border: "1px solid #1e1e1e",
    borderRadius: "4px",
    padding: "20px 24px",
    animation: "fadeUp 0.4s ease forwards",
    opacity: 0,
  },
  cardTop: {
    display: "flex",
    justifyContent: "space-between",
    alignItems: "center",
    marginBottom: "10px",
  },
  cardIndex: {
    fontSize: "11px",
    color: "#333",
    fontWeight: 700,
    letterSpacing: "0.1em",
  },
  rating: {
    fontSize: "12px",
    color: "#e8a21a",
    fontWeight: 700,
  },
  cardName: {
    fontFamily: "'Syne', sans-serif",
    fontSize: "17px",
    fontWeight: 700,
    color: "#f0ece4",
    marginBottom: "10px",
    lineHeight: 1.3,
  },
  cardDetails: {
    display: "flex",
    flexWrap: "wrap",
    gap: "6px",
    marginBottom: "10px",
  },
  detail: {
    fontSize: "11px",
    color: "#666",
    background: "#181818",
    padding: "3px 8px",
    borderRadius: "2px",
  },
  hours: {
    fontSize: "12px",
    color: "#5a9e6f",
    marginBottom: "12px",
  },
  mapLink: {
    fontSize: "11px",
    color: "#e8441a",
    textDecoration: "none",
    letterSpacing: "0.04em",
  },
};
