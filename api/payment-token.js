// =============================================================================
// Call Console — start secure card capture  (Vercel serverless function)
//
//   POST /api/payment-token  { requestId }
//     -> { ok, token, action, requestId }        (show the hosted form)
//     -> { ok:false, error }                     (see error codes below)
//
// Flow (server-side only — the browser only ever receives the short-lived
// hosted-page token, never credentials, never card data):
//   1. Look up the intake in n8n. It must be a new-customer intake that is
//      awaiting a payment method (status awaiting_payment). This is what stops
//      an employee from opening a payment form for an arbitrary request.
//   2. Create the Authorize.Net Customer Profile if this intake doesn't have
//      one yet (idempotent — duplicates resolve to the existing profile).
//   3. Save the customerProfileId back onto the intake (n8n, with sync key).
//   4. Get an Accept Customer hosted-profile-page token and return it with the
//      form action URL. The card is typed straight into Authorize.Net's page.
//
// Error codes returned to the app:
//   unknown_request    no intake with that ID
//   not_awaiting       intake exists but doesn't need a payment method
//   anet_not_configured  missing ANET_* env vars
//   anet_error / E*    Authorize.Net rejected the call
//   bridge_unreachable n8n state store unreachable
//
// Env vars: ANET_API_LOGIN_ID, ANET_TRANSACTION_KEY (see _anet.js),
//   INTAKE_SYNC_KEY (shared secret for the n8n intake-update webhook)
// Optional: N8N_INTAKE_STATUS_URL, N8N_INTAKE_UPDATE_URL, ANET_COMM_ORIGIN
// =============================================================================

const anet = require("./_anet.js");

const N8N_INTAKE_STATUS_URL = process.env.N8N_INTAKE_STATUS_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-intake-status";
const N8N_INTAKE_UPDATE_URL = process.env.N8N_INTAKE_UPDATE_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-intake-update";

async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 9000);
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

    // 1. Server-side state check — never trust the client's idea of the state.
    const state = await fetchJson(N8N_INTAKE_STATUS_URL + "?id=" + encodeURIComponent(requestId) + "&full=1");
    if (!state) { res.status(200).json({ ok: false, error: "bridge_unreachable" }); return; }
    if (!state.ok || !state.status) { res.status(200).json({ ok: false, error: "unknown_request" }); return; }
    if (state.status !== "awaiting_payment") {
      res.status(200).json({ ok: false, error: "not_awaiting", status: state.status, cardSummary: state.cardSummary || null });
      return;
    }

    // 2. Ensure the Authorize.Net customer profile exists.
    let customerProfileId = state.customerProfileId || "";
    if (!customerProfileId) {
      const created = await anet.createCustomerProfile({
        requestId,
        description: ("CW support intake " + requestId + (state.customer ? " — " + state.customer : "")).slice(0, 255),
        email: state.customerEmail || ""
      });
      if (!created.ok) { res.status(200).json({ ok: false, error: created.error, detail: created.detail }); return; }
      customerProfileId = created.customerProfileId;

      // 3. Persist the profile ID on the intake record.
      await fetchJson(N8N_INTAKE_UPDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syncKey: process.env.INTAKE_SYNC_KEY || "",
          requestId,
          customerProfileId
        })
      });
    }

    // 4. Hosted page token. The communicator page must be on the same origin
    //    as the Call Console app that embeds the hosted form.
    const origin = process.env.ANET_COMM_ORIGIN || anet.requestOrigin(req);
    if (!origin) { res.status(200).json({ ok: false, error: "no_origin" }); return; }
    const hosted = await anet.getHostedProfileToken({
      customerProfileId,
      communicatorUrl: origin + "/anet-communicator.html"
    });
    if (!hosted.ok) { res.status(200).json({ ok: false, error: hosted.error, detail: hosted.detail }); return; }

    res.status(200).json({ ok: true, requestId, token: hosted.token, action: hosted.action });
  } catch (e) {
    const code = (e && e.code) === "anet_not_configured" ? "anet_not_configured" : "server_error";
    res.status(200).json({ ok: false, error: code, detail: String((e && e.message) || e) });
  }
};
