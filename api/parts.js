// =============================================================================
// Call Console — part price lookup  (Vercel serverless function)
// GET /api/parts?q=iphone+12+screen
//
// Queries the supplier catalogs in priority order and returns the FIRST one
// that has results:   MobileSentrix  ->  PhoneLCDParts  ->  Injured Gadgets.
//
// All three run Magento, so the same search URL + HTML shape works for each.
// Prices are shown publicly (no login), and they are rendered in the server
// HTML, so a plain fetch + parse is enough — no headless browser needed.
//
// Response shape:
//   { supplier, supplierKey, query, searchUrl, results:[{name,url,price}], tried:[...] }
//   results is [] with searchLinks[] if nothing was found on any supplier.
// =============================================================================

const SUPPLIERS = [
  { key: "mobilesentrix",  name: "MobileSentrix",   base: "https://www.mobilesentrix.com" },
  { key: "phonelcdparts",  name: "PhoneLCDParts",   base: "https://www.phonelcdparts.com" },
  { key: "injuredgadgets", name: "Injured Gadgets", base: "https://www.injuredgadgets.com" }
];

// A real browser UA — some Magento hosts 403 obvious bots.
const UA = "Mozilla/5.0 (Windows NT 10.0; Win64; x64) AppleWebKit/537.36 " +
           "(KHTML, like Gecko) Chrome/125.0.0.0 Safari/537.36";

function searchUrlFor(base, q) {
  return base + "/catalogsearch/result/?q=" + encodeURIComponent(q);
}

function decodeEntities(s) {
  return String(s)
    .replace(/&amp;/g, "&").replace(/&#0?39;/g, "'").replace(/&quot;/g, '"')
    .replace(/&lt;/g, "<").replace(/&gt;/g, ">").replace(/&nbsp;/g, " ")
    .replace(/&#(\d+);/g, (_, n) => String.fromCharCode(+n))
    .replace(/&#x([0-9a-f]+);/gi, (_, h) => String.fromCharCode(parseInt(h, 16)));
}

// Pull {name, url, price} out of a Magento search-results page.
// Names come from <a class="product-item-link" href=...>NAME</a>;
// each price is the first data-price-amount that appears after its name.
function parseMagento(html) {
  const items = [];
  let m;
  const aRe = /<a\b[^>]*\bproduct-item-link\b[^>]*>([\s\S]*?)<\/a>/g;
  while ((m = aRe.exec(html))) {
    const href = (m[0].match(/href="([^"]+)"/) || [])[1] || "";
    const name = decodeEntities(m[1].replace(/<[^>]+>/g, "").replace(/\s+/g, " ").trim());
    if (name) items.push({ name, url: href, idx: m.index });
  }

  // Capture each price tag with whether it is Magento's finalPrice (the number
  // actually charged) vs an old/struck-through price on a sale item.
  const prices = [];
  let p;
  const pRe = /<[^>]*\bdata-price-amount="([0-9.]+)"[^>]*>/g;
  while ((p = pRe.exec(html))) {
    prices.push({ amt: parseFloat(p[1]), idx: p.index, final: /data-price-type="finalPrice"/.test(p[0]) });
  }

  const out = [];
  const seen = new Set();
  for (let i = 0; i < items.length; i++) {
    const it = items[i];
    const next = i + 1 < items.length ? items[i + 1].idx : Infinity;
    const inRange = prices.filter(x => x.idx > it.idx && x.idx < next && x.amt > 0);
    if (!inRange.length) continue;
    const finals = inRange.filter(x => x.final);
    const pr = (finals.length ? finals : inRange)[0];  // prefer finalPrice; else first
    const key = it.name.toLowerCase();
    if (seen.has(key)) continue;
    seen.add(key);
    out.push({ name: it.name, url: it.url, price: pr.amt });
  }
  return out;
}

async function fetchSupplier(s, q) {
  const url = searchUrlFor(s.base, q);
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 8000);
  try {
    const r = await fetch(url, {
      headers: { "User-Agent": UA, "Accept": "text/html,application/xhtml+xml", "Accept-Language": "en-US,en;q=0.9" },
      signal: ctrl.signal
    });
    if (!r.ok) return { ok: false, status: r.status, results: [], searchUrl: url };
    const html = await r.text();
    return { ok: true, status: 200, results: parseMagento(html).slice(0, 12), searchUrl: url };
  } catch (e) {
    return { ok: false, status: 0, error: String((e && e.message) || e), results: [], searchUrl: url };
  } finally {
    clearTimeout(timer);
  }
}

module.exports = async (req, res) => {
  let q = "";
  try {
    q = (req.query && req.query.q) || new URL(req.url, "http://x").searchParams.get("q") || "";
  } catch (_) { q = (req.query && req.query.q) || ""; }
  q = String(q).trim();

  res.setHeader("Cache-Control", "s-maxage=600, stale-while-revalidate=3600");
  if (!q) { res.status(400).json({ error: "missing q" }); return; }

  const tried = [];
  for (const s of SUPPLIERS) {
    const r = await fetchSupplier(s, q);
    tried.push({ supplier: s.name, ok: r.ok, status: r.status, count: r.results.length, error: r.error || null });
    if (r.ok && r.results.length) {
      res.status(200).json({
        supplier: s.name, supplierKey: s.key, query: q,
        searchUrl: r.searchUrl, results: r.results, tried
      });
      return;
    }
  }

  // Nothing usable anywhere — hand back pre-filled store links for the manual fallback.
  res.status(200).json({
    supplier: null, query: q, results: [], tried,
    searchLinks: SUPPLIERS.map(s => ({ name: s.name, url: searchUrlFor(s.base, q) }))
  });
};

// Exposed for local unit testing of the parser.
module.exports.parseMagento = parseMagento;
module.exports.searchUrlFor = searchUrlFor;
