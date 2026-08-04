// =============================================================================
// Call Console — script config store  (Vercel serverless function)
//
//   GET  /api/config            -> { ok, config }   (script overrides for the app)
//   POST /api/config  {pin,config} -> { ok, saved } or { ok:false, error }
//
// Thin proxy to the n8n "Call Console — Config" webhook, which stores the
// overrides and checks the admin PIN server-side. Keeping this same-origin
// avoids any browser CORS issues, exactly like /api/parts.
//
// Optional env var: N8N_CONFIG_URL (defaults to the webhook below).
// The admin PIN lives in the n8n Config Handler node (ADMIN_PIN), not here.
// =============================================================================

const N8N_CONFIG_URL = process.env.N8N_CONFIG_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-config";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") {
      let body = req.body;
      if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
      body = body || {};
      const r = await fetch(N8N_CONFIG_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ pin: body.pin, config: body.config || {} })
      });
      const data = await r.json().catch(() => ({ ok: false }));
      res.status(200).json(data);
      return;
    }

    // GET — return the current overrides
    const r = await fetch(N8N_CONFIG_URL, { headers: { "Accept": "application/json" } });
    const data = await r.json().catch(() => ({ ok: false, config: {} }));
    res.status(200).json({ ok: !!data.ok, config: (data && data.config) || {} });
  } catch (e) {
    res.status(200).json({ ok: false, config: {}, error: String((e && e.message) || e) });
  }
};
