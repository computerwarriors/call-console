// =============================================================================
// Call Console — address autocomplete / verification  (Vercel serverless function)
//
//   GET /api/address?q=123 main&session=abc   -> { ok, suggestions:[{id, main, secondary}] }
//   GET /api/address?place=<placeId>&session=abc -> { ok, address:{line1,line2,city,state,stateCode,zip,formatted} }
//
// Proxy to Google Places API (New). The key lives in the Vercel env var
// GOOGLE_MAPS_KEY and never reaches the browser. Suggestions are biased to a
// ~30-mile circle around the two shops (Wilmington / Jacksonville NC) and
// limited to the US. The `session` token groups the typing + the final pick
// into one billed Autocomplete session (Google's pricing model).
//
// Without GOOGLE_MAPS_KEY the function answers { ok:false, error:"not_configured" }
// and the form quietly falls back to manual entry.
// =============================================================================

const KEY = process.env.GOOGLE_MAPS_KEY || "";
const BIAS = { circle: { center: { latitude: 34.45, longitude: -77.65 }, radius: 50000 } };   // midpoint between Wilmington and Jacksonville (Google caps bias radius at 50 km)

function comp(components, type, long) {
  const c = (components || []).find(x => Array.isArray(x.types) && x.types.includes(type));
  return c ? (long ? c.longText : c.shortText) || "" : "";
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    let q = "", place = "", session = "";
    try {
      const u = new URL(req.url, "http://x");
      q = (req.query && req.query.q) || u.searchParams.get("q") || "";
      place = (req.query && req.query.place) || u.searchParams.get("place") || "";
      session = (req.query && req.query.session) || u.searchParams.get("session") || "";
    } catch (_) {}
    q = String(q).trim().slice(0, 120); place = String(place).trim().slice(0, 300); session = String(session).trim().slice(0, 64);
    if (!/^[A-Za-z0-9_-]*$/.test(session)) session = "";
    if (!KEY) { res.status(200).json({ ok: false, error: "not_configured" }); return; }

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 8000);

    if (place) {
      if (!/^[A-Za-z0-9_-]+$/.test(place)) { res.status(400).json({ ok: false, error: "bad_place" }); return; }
      const r = await fetch("https://places.googleapis.com/v1/places/" + encodeURIComponent(place) + (session ? "?sessionToken=" + encodeURIComponent(session) : ""), {
        headers: { "X-Goog-Api-Key": KEY, "X-Goog-FieldMask": "formattedAddress,addressComponents" },
        signal: ctrl.signal
      });
      clearTimeout(timer);
      const d = await r.json().catch(() => null);
      if (!r.ok || !d) { res.status(200).json({ ok: false, error: "google_" + r.status, detail: d && d.error && d.error.message }); return; }
      const ac = d.addressComponents || [];
      const number = comp(ac, "street_number", false), route = comp(ac, "route", true);
      const line1 = [number, route].filter(Boolean).join(" ");
      const unit = comp(ac, "subpremise", true);
      const city = comp(ac, "locality", true) || comp(ac, "sublocality", true) || comp(ac, "postal_town", true) || comp(ac, "administrative_area_level_3", true);
      res.status(200).json({ ok: true, address: {
        line1, line2: unit ? (/^\d+$/.test(unit) ? "Unit " + unit : unit) : "",
        city, state: comp(ac, "administrative_area_level_1", true), stateCode: comp(ac, "administrative_area_level_1", false),
        zip: comp(ac, "postal_code", false), formatted: d.formattedAddress || ""
      } });
      return;
    }

    if (q.length < 3) { res.status(200).json({ ok: true, suggestions: [] }); return; }
    const body = { input: q, includedRegionCodes: ["us"], locationBias: BIAS, languageCode: "en" };
    if (session) body.sessionToken = session;
    const r = await fetch("https://places.googleapis.com/v1/places:autocomplete", {
      method: "POST",
      headers: { "Content-Type": "application/json", "X-Goog-Api-Key": KEY },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const d = await r.json().catch(() => null);
    if (!r.ok || !d) { res.status(200).json({ ok: false, error: "google_" + r.status, detail: d && d.error && d.error.message }); return; }
    const suggestions = (d.suggestions || [])
      .map(s => s.placePrediction).filter(Boolean)
      .map(p => ({ id: p.placeId, main: (p.structuredFormat && p.structuredFormat.mainText && p.structuredFormat.mainText.text) || (p.text && p.text.text) || "",
                   secondary: (p.structuredFormat && p.structuredFormat.secondaryText && p.structuredFormat.secondaryText.text) || "" }))
      .slice(0, 6);
    res.status(200).json({ ok: true, suggestions });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
