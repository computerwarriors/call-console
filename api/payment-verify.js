// =============================================================================
// Call Console — verify vaulted payment method & release the request
//
//   POST /api/payment-verify  { requestId }
//     -> { ok:true, secured:true, brand, last4 }   card is vaulted; ticket released
//     -> { ok:true, secured:false }                no payment method saved yet
//     -> { ok:false, error }
//
// Called after the Authorize.Net hosted form reports "successfulSave" (and by
// the retry / refresh paths). The client message is treated ONLY as a hint:
// this endpoint asks Authorize.Net directly whether a payment profile actually
// exists on the customer profile. Only when Authorize.Net confirms it do we
// tell n8n to mark the intake payment_secured and release the held support
// request into the normal new-customer workflow.
//
// Idempotent: verifying an already-released intake just reports its state.
//
// Env vars: ANET_API_LOGIN_ID, ANET_TRANSACTION_KEY, INTAKE_SYNC_KEY
// Optional: N8N_INTAKE_STATUS_URL, N8N_INTAKE_UPDATE_URL
// =============================================================================

const anet = require("./_anet.js");

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

    const state = await fetchJson(N8N_INTAKE_STATUS_URL + "?id=" + encodeURIComponent(requestId) + "&full=1");
    if (!state) { res.status(200).json({ ok: false, error: "bridge_unreachable" }); return; }
    if (!state.ok || !state.status) { res.status(200).json({ ok: false, error: "unknown_request" }); return; }

    // Already fully released — idempotent success (covers refresh & retry).
    if (state.status === "released") {
      res.status(200).json({ ok: true, secured: true, alreadySecured: true, cardSummary: state.cardSummary || null });
      return;
    }

    // Card already vaulted but the release to the ticket workflow didn't
    // complete (n8n or the legacy webhook was down) — retry the release only.
    if (state.status === "payment_secured" || state.status === "forward_failed") {
      const retried = await fetchJson(N8N_INTAKE_UPDATE_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syncKey: process.env.INTAKE_SYNC_KEY || "",
          requestId,
          status: "payment_secured",
          release: true
        })
      });
      if (retried && retried.ok) {
        res.status(200).json({ ok: true, secured: true, cardSummary: state.cardSummary || null });
      } else {
        res.status(200).json({ ok: false, error: "release_failed", secured: true, cardSummary: state.cardSummary || null });
      }
      return;
    }

    if (state.status !== "awaiting_payment") {
      res.status(200).json({ ok: false, error: "not_awaiting", status: state.status });
      return;
    }
    if (!state.customerProfileId) {
      res.status(200).json({ ok: true, secured: false, reason: "no_profile_yet" });
      return;
    }

    // The source of truth: does Authorize.Net actually hold a payment method?
    const summary = await anet.getPaymentProfileSummary({ customerProfileId: state.customerProfileId });
    if (!summary.ok) { res.status(200).json({ ok: false, error: summary.error, detail: summary.detail }); return; }
    if (!summary.hasPayment) { res.status(200).json({ ok: true, secured: false }); return; }

    const cardSummary = [summary.brand, summary.last4 ? "•••• " + summary.last4 : ""].filter(Boolean).join(" ");

    // Confirmed — mark secured and release the held workflow via n8n.
    const released = await fetchJson(N8N_INTAKE_UPDATE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify({
        syncKey: process.env.INTAKE_SYNC_KEY || "",
        requestId,
        status: "payment_secured",
        cardSummary,
        release: true
      })
    });
    if (!released || !released.ok) {
      // Card IS vaulted but the release didn't go through — surface that
      // clearly so the front desk doesn't re-enter the card.
      res.status(200).json({ ok: false, error: "release_failed", secured: true, brand: summary.brand, last4: summary.last4 });
      return;
    }

    res.status(200).json({ ok: true, secured: true, brand: summary.brand, last4: summary.last4 });
  } catch (e) {
    const code = (e && e.code) === "anet_not_configured" ? "anet_not_configured" : "server_error";
    res.status(200).json({ ok: false, error: code, detail: String((e && e.message) || e) });
  }
};
