// =============================================================================
// Call Console — support intake  (Vercel serverless function)
//
//   GET  /api/support-intake?id=SOHO-123   -> { ok, requestId, status, customer, cardSummary }
//   GET  /api/support-intake?latest=1      -> most recent awaiting_payment intake (last 30 min)
//   POST /api/support-intake  {intake}     -> { ok, requestId, path:'existing'|'new' }
//
// Thin proxy to the n8n "Call Console — Support Intake & Payment State"
// workflow, same pattern as /api/config and /api/parts. n8n owns the intake
// state (data table); the GET returns only non-sensitive fields — never card
// data, never the full payload.
//
// The POST is used by the console's native SOHO form (the Autotask-backed one).
// It forwards the submission to the same /webhook/cw-support-intake endpoint
// Cognito posts to, in the same field shape, so n8n routes it identically:
// existing customers go straight to the ticket workflow, new customers are
// held as awaiting_payment until a card is on file.
//
// Optional env vars: N8N_INTAKE_STATUS_URL, N8N_INTAKE_SUBMIT_URL.
// =============================================================================

const N8N_INTAKE_STATUS_URL = process.env.N8N_INTAKE_STATUS_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-intake-status";
const N8N_INTAKE_SUBMIT_URL = process.env.N8N_INTAKE_SUBMIT_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-support-intake";

async function handleSubmit(req, res) {
  let body = req.body;
  if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
  if (!body || typeof body !== "object") { res.status(400).json({ ok: false, error: "bad_body" }); return; }

  // Minimal server-side sanity check — the real validation lives in the form
  // and the n8n workflow; this just refuses obviously empty submissions.
  const desc = String(body.TicketDescription || "").trim();
  const hasCompany = body.DoesTheCompanyExist === true
    ? !!(body.CompanyID && String(body.CompanyID.Label || "").trim())
    : !!(body.Name && String(body.Name.FirstAndLast || "").trim());
  if (!desc || !hasCompany) { res.status(400).json({ ok: false, error: "incomplete" }); return; }
  if (JSON.stringify(body).length > 60000) { res.status(400).json({ ok: false, error: "too_large" }); return; }

  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 25000);
  const r = await fetch(N8N_INTAKE_SUBMIT_URL, {
    method: "POST",
    headers: { "Content-Type": "application/json", "Accept": "application/json" },
    body: JSON.stringify(body),
    signal: ctrl.signal
  });
  clearTimeout(timer);
  const data = await r.json().catch(() => null);
  if (!data) { res.status(200).json({ ok: false, error: "bridge_unreachable" }); return; }
  res.status(200).json({ ok: !!data.ok, requestId: data.requestId || null, path: data.path || null, error: data.error || null });
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method === "POST") { await handleSubmit(req, res); return; }

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
      phone: data.phone || null,
      address: data.address || null,
      cardSummary: data.cardSummary || null,
      error: data.error || null
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
