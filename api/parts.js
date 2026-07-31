// =============================================================================
// Call Console — part price lookup  (Vercel serverless function)
// GET /api/parts?q=iphone+12+screen
//
// MobileSentrix sits behind Cloudflare, which blocks server-to-server calls from
// datacenter IPs (Vercel) — but NOT from the shop's n8n cloud instance. So this
// function forwards the search to an n8n webhook, which signs the MobileSentrix
// REST API call (OAuth 1.0a) and returns clean results. All MobileSentrix
// credentials live in n8n; nothing secret lives here or in the repo.
//
// n8n workflow: "Call Console — Parts Lookup" (Computer Warriors project)
//   -> MobileSentrix API Request Helper -> /api/rest/searchproduct
//
// Optional env var:
//   N8N_PARTS_URL   override the bridge webhook URL (defaults to the one below)
//
// If MobileSentrix has no match (or the bridge is unreachable), the response
// returns store links (MobileSentrix, PhoneLCDParts) for the manual fallback.
// PhoneLCDParts' API is pending — it's a link for now.
// =============================================================================

const N8N_PARTS_URL = process.env.N8N_PARTS_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-parts";

const STORES = [
  { name: "MobileSentrix", base: "https://www.mobilesentrix.com" },
  { name: "PhoneLCDParts", base: "https://www.phonelcdparts.com" }
];

function frontSearchUrl(base, q) {
  return base + "/catalogsearch/result/?q=" + encodeURIComponent(q);
}

module.exports = async (req, res) => {
  let q = "";
  try { q = (req.query && req.query.q) || new URL(req.url, "http://x").searchParams.get("q") || ""; }
  catch (_) { q = (req.query && req.query.q) || ""; }
  q = String(q).trim();

  res.setHeader("Cache-Control", "s-maxage=300, stale-while-revalidate=3600");
  if (!q) { res.status(400).json({ error: "missing q" }); return; }

  const tried = [];
  try {
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(N8N_PARTS_URL + "?q=" + encodeURIComponent(q), {
      headers: { "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(timer);

    if (r.ok) {
      const data = await r.json();
      const results = Array.isArray(data && data.results) ? data.results : [];
      tried.push({ supplier: "MobileSentrix (via n8n)", ok: !!(data && data.ok), count: results.length });
      if (results.length) {
        res.status(200).json({
          supplier: data.supplier || "MobileSentrix",
          supplierKey: "mobilesentrix",
          query: q,
          results: results.slice(0, 12),
          tried
        });
        return;
      }
    } else {
      tried.push({ supplier: "MobileSentrix (via n8n)", ok: false, status: r.status });
    }
  } catch (e) {
    tried.push({ supplier: "MobileSentrix (via n8n)", ok: false, error: String((e && e.message) || e) });
  }

  // No match (or bridge unreachable) — hand back pre-filled store links.
  res.status(200).json({
    supplier: null, query: q, results: [], tried,
    searchLinks: STORES.map(s => ({ name: s.name, url: frontSearchUrl(s.base, q) }))
  });
};
