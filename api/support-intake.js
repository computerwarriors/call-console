// =============================================================================
// Call Console — support intake status  (Vercel serverless function)
//
//   GET /api/support-intake?id=SOHO-123   -> { ok, requestId, status, customer, cardSummary }
//   GET /api/support-intake?latest=1      -> most recent awaiting_payment intake (last 30 min)
//
// Thin proxy to the n8n "Call Console — Support Intake" status webhook, same
// pattern as /api/config and /api/parts. n8n owns the intake state (data table);
// this endpoint returns only non-sensitive fields — never card data, never the
// full Cognito payload.
//
// Optional env var: N8N_INTAKE_STATUS_URL (defaults to the webhook below).
// =============================================================================

const N8N_INTAKE_STATUS_URL = process.env.N8N_INTAKE_STATUS_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-intake-status";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    let id = "", latest = "";
    try {
      const u = new URL(req.url, "http://x");
      id = (req.query && req.query.id) || u.searchParams.get("id") || "";
      latest = (req.query && req.query.latest) || u.searchParams.get("latest") || "";
    } catch (_) { id = (req.query && req.query.id) || ""; }

    id = String(id).trim();
    if (!id && !latest) { res.status(400).json({ ok: false, error: "missing_id" }); return; }
    if (id && !/^[A-Za-z0-9_-]{1,64}$/.test(id)) { res.status(400).json({ ok: false, error: "bad_id" }); return; }

    const qs = id ? ("?id=" + encodeURIComponent(id)) : "?latest=1";
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 9000);
    const r = await fetch(N8N_INTAKE_STATUS_URL + qs, {
      headers: { "Accept": "application/json" },
      signal: ctrl.signal
    });
    clearTimeout(timer);
    const data = await r.json().catch(() => null);
    if (!data) { res.status(200).json({ ok: false, error: "bridge_unreachable" }); return; }

    // Pass through only the whitelisted, non-sensitive fields.
    res.status(200).json({
      ok: !!data.ok,
      requestId: data.requestId || null,
      status: data.status || null,
      customer: data.customer || null,
      cardSummary: data.cardSummary || null,
      error: data.error || null
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
