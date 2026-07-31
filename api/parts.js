// =============================================================================
// Call Console — part price lookup  (Vercel serverless function)
// GET /api/parts?q=iphone+12+screen
//
// Source of prices: MobileSentrix OFFICIAL REST API (OAuth 1.0a).
// If MobileSentrix has no match, the response returns store links
// (MobileSentrix, PhoneLCDParts) so the tech can open one manually.
// PhoneLCDParts' API is pending — it's a link for now; when it's ready we add
// it here as a second automatic source.
//
// Response:
//   { supplier, supplierKey, query, searchUrl, results:[{name,url,price}], tried }
//   or  { supplier:null, results:[], searchLinks:[{name,url}], tried }  when empty.
//
// ---- Environment variables (set in the Vercel dashboard) --------------------
//   MS_CONSUMER_KEY        MobileSentrix OAuth consumer key
//   MS_CONSUMER_SECRET     MobileSentrix OAuth consumer secret
//   MS_ACCESS_TOKEN        MobileSentrix OAuth access token
//   MS_ACCESS_TOKEN_SECRET MobileSentrix OAuth access token secret
// Until all four are set, MobileSentrix is skipped and the app shows store links.
// =============================================================================

const crypto = require("crypto");

const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

const MS = {
  key:         process.env.MS_CONSUMER_KEY,
  secret:      process.env.MS_CONSUMER_SECRET,
  token:       process.env.MS_ACCESS_TOKEN,
  tokenSecret: process.env.MS_ACCESS_TOKEN_SECRET,
  base:        "https://www.mobilesentrix.com",
  path:        "/api/rest/searchproduct"
};

// Manual-fallback store links (priority order), shown when MobileSentrix is empty.
const STORES = [
  { name: "MobileSentrix", base: "https://www.mobilesentrix.com" },
  { name: "PhoneLCDParts", base: "https://www.phonelcdparts.com" }
];

function frontSearchUrl(base, q) {
  return base + "/catalogsearch/result/?q=" + encodeURIComponent(q);
}

// RFC 3986 percent-encoding (OAuth requires !*'() encoded too).
function pct(s) {
  return encodeURIComponent(String(s)).replace(/[!*'()]/g, c => "%" + c.charCodeAt(0).toString(16).toUpperCase());
}

// Build an OAuth 1.0a "Authorization: OAuth ..." header (HMAC-SHA1).
function oauthHeader(method, baseUrl, params, cfg, overrides) {
  const oauth = Object.assign({
    oauth_consumer_key: cfg.key,
    oauth_token: cfg.token,
    oauth_signature_method: "HMAC-SHA1",
    oauth_timestamp: String(Math.floor(Date.now() / 1000)),
    oauth_nonce: crypto.randomBytes(16).toString("hex"),
    oauth_version: "1.0"
  }, overrides || {});

  const all = Object.assign({}, params, oauth);
  const paramStr = Object.keys(all).sort()
    .map(k => pct(k) + "=" + pct(all[k])).join("&");
  const baseString = [method.toUpperCase(), pct(baseUrl), pct(paramStr)].join("&");
  const signingKey = pct(cfg.secret) + "&" + pct(cfg.tokenSecret);
  oauth.oauth_signature = crypto.createHmac("sha1", signingKey).update(baseString).digest("base64");

  return "OAuth " + Object.keys(oauth).sort()
    .map(k => pct(k) + '="' + pct(oauth[k]) + '"').join(", ");
}

async function fetchMobileSentrixApi(q) {
  if (!(MS.key && MS.secret && MS.token && MS.tokenSecret)) {
    return { ok: false, skipped: true, results: [] };
  }
  const baseUrl = MS.base + MS.path;
  const params = { q: q, max_results: "12" };
  const header = oauthHeader("GET", baseUrl, params, MS);
  const fullUrl = baseUrl + "?q=" + pct(q) + "&max_results=12";

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(fullUrl, {
      headers: { "Authorization": header, "Accept": "application/json", "User-Agent": UA },
      signal: ctrl.signal
    });
    if (!r.ok) {
      let snippet = "";
      try { snippet = (await r.text()).replace(/\s+/g, " ").trim().slice(0, 240); } catch (_) {}
      return {
        ok: false, status: r.status, results: [], searchUrl: frontSearchUrl(MS.base, q),
        debug: { server: r.headers.get("server"), cfRay: r.headers.get("cf-ray"), snippet }
      };
    }
    const json = await r.json();
    const items = (json && json.data && json.data.items) || [];
    const results = items
      .map(it => ({ name: (it.title || "").trim(), url: it.link || "", price: parseFloat(it.price) }))
      .filter(x => x.name && x.price > 0)
      .slice(0, 12);
    return { ok: true, status: 200, results, searchUrl: frontSearchUrl(MS.base, q) };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e), results: [], searchUrl: frontSearchUrl(MS.base, q) };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  let q = "";
  try { q = (req.query && req.query.q) || new URL(req.url, "http://x").searchParams.get("q") || ""; }
  catch (_) { q = (req.query && req.query.q) || ""; }
  q = String(q).trim();

  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  if (!q) { res.status(400).json({ error: "missing q" }); return; }

  const tried = [];
  const ms = await fetchMobileSentrixApi(q);
  if (!ms.skipped) tried.push({ supplier: "MobileSentrix (API)", ok: ms.ok, status: ms.status, count: ms.results.length, error: ms.error || null, debug: ms.debug || null });

  if (ms.ok && ms.results.length) {
    res.status(200).json({ supplier: "MobileSentrix", supplierKey: "mobilesentrix", query: q, searchUrl: ms.searchUrl, results: ms.results, tried });
    return;
  }

  // No match on MobileSentrix — hand back pre-filled store links to open manually.
  res.status(200).json({
    supplier: null, query: q, results: [], tried,
    searchLinks: STORES.map(s => ({ name: s.name, url: frontSearchUrl(s.base, q) }))
  });
};

// Exposed for local unit tests.
module.exports.oauthHeader = oauthHeader;
module.exports.pct = pct;
