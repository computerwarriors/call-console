// =============================================================================
// Call Console — business check bypass  (Vercel serverless function)
//
//   POST /api/payment-bypass  { requestId, note }
//     -> { ok, released, checkReview, status }
//     -> { ok:false, error }   (bad_id | note_required | unknown_request |
//                               not_awaiting | bridge_unreachable | ...)
//
// Releases a new-customer support request WITHOUT a card on file, flagged for
// manual dispatch review (business-check customers). Server-side gates:
//   - the intake must exist and still be awaiting_payment
//   - a real note is required; it lands on the Autotask ticket's billing note
//     and in the Teams alert to the dispatching team
// The n8n intake workflow marks the request released_check_review, forwards
// the original payload with PaymentSecured:false + CheckReviewNote, and posts
// a Teams alert so dispatch confirms eligibility BEFORE scheduling anyone.
//
// Env vars: INTAKE_SYNC_KEY.
// Optional: N8N_INTAKE_STATUS_URL, N8N_INTAKE_UPDATE_URL
// =============================================================================

const N8N_INTAKE_STATUS_URL = process.env.N8N_INTAKE_STATUS_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-intake-status";
const N8N_INTAKE_UPDATE_URL = process.env.N8N_INTAKE_UPDATE_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-intake-update";

async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  try {
    const r = await fetch(url, Object.assign({ signal: ctrl.signal }, opts || {}));
    return await r.json().catch(() => null);
  } finally { clearTimeout(timer); }
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};
    const requestId = String(body.requestId || "").trim();
    if (!/^[A-Za-z0-9_-]{1,64}$/.test(requestId)) { res.status(400).json({ ok: false, error: "bad_id" }); return; }
    const note = String(body.note || "").trim();
    if (note.length < 10 || note.length > 900) { res.status(400).json({ ok: false, error: "note_required" }); return; }

    // Server-side state check — bypass only applies to a held new-customer intake.
    const state = await fetchJson(N8N_INTAKE_STATUS_URL + "?id=" + encodeURIComponent(requestId));
    if (!state) { res.status(200).json({ ok: false, error: "bridge_unreachable" }); return; }
    if (!state.ok || !state.status) { res.status(200).json({ ok: false, error: "unknown_request" }); return; }
    if (state.status !== "awaiting_payment") {
      res.status(200).json({ ok: false, error: "not_awaiting", status: state.status });
      return;
    }

    const result = await fetchJson(N8N_INTAKE_UPDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        syncKey: process.env.INTAKE_SYNC_KEY || "",
        requestId,
        bypass: true,
        note
      })
    });
    if (!result) { res.status(200).json({ ok: false, error: "bridge_unreachable" }); return; }
    res.status(200).json({
      ok: !!result.ok,
      released: !!result.released,
      checkReview: !!result.checkReview,
      status: result.status || null,
      error: result.ok ? null : (result.error || "bypass_failed")
    });
  } catch (e) {
    res.status(200).json({ ok: false, error: "server_error", detail: String((e && e.message) || e) });
  }
};
