// =============================================================================
// Call Console — protection plan payment manager  (Vercel serverless function)
//
//   POST /api/protection-plan  { action: "lookup", email, pin }
//     -> { ok, found, cards:[{brand,last4}], description }
//   POST /api/protection-plan  { action: "open", email, pin }
//     -> { ok, token, action, mode: "manage"|"add" }   (show the hosted page)
//
// Lets front-desk staff update a residential protection plan customer's card
// on file without an Authorize.Net login:
//   - lookup: find the customer profile by email (masked card summaries only)
//   - open:   profile exists  -> hosted "manage payment methods" page token
//             no profile yet  -> create one (description marks it as a
//             protection plan) and return the hosted "add payment" page token
//
// Card data never touches this function — entry/edit happens on Authorize.Net's
// hosted page, same as the support-intake flow.
//
// Because this endpoint can open the payment manager for ANY email, it is
// gated by a shared team code:
//   PROTECTION_PLAN_PIN   (required env var — endpoint refuses to work unset)
// Env vars: ANET_API_LOGIN_ID, ANET_TRANSACTION_KEY (see _anet.js)
// Optional: ANET_COMM_ORIGIN
// =============================================================================

const anet = require("./_anet.js");

// n8n workflow that links the Authorize.Net profile into RepairShopr
// (payment_profiles "Manual CIM" record) so recurring invoices charge the
// newest card. Gated by the same shared secret as the intake webhooks.
const N8N_PP_SYNC_URL = process.env.N8N_PP_SYNC_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-pp-rs-sync";

// Run fn over items with bounded concurrency (used for the profile sweep).
async function mapLimit(items, limit, fn) {
  const out = new Array(items.length);
  let i = 0;
  async function worker() {
    while (i < items.length) { const idx = i++; out[idx] = await fn(items[idx], idx); }
  }
  await Promise.all(Array.from({ length: Math.min(limit, items.length) || 1 }, worker));
  return out;
}

async function fetchJson(url, opts) {
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 15000);
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

    const PIN = process.env.PROTECTION_PLAN_PIN || "";
    if (!PIN) { res.status(200).json({ ok: false, error: "pin_not_configured" }); return; }
    const pin = String(body.pin || "");
    if (!pin) { res.status(200).json({ ok: false, error: "pin_required" }); return; }
    if (pin !== PIN) { res.status(200).json({ ok: false, error: "bad_pin" }); return; }

    const action = String(body.action || "").trim();
    const email = String(body.email || "").trim().toLowerCase();
    if (!/.+@.+\..+/.test(email) || email.length > 255) { res.status(400).json({ ok: false, error: "bad_email" }); return; }

    if (action === "lookup") {
      const found = await anet.getCustomerProfileByEmail({ email });
      if (!found.ok) { res.status(200).json({ ok: false, error: found.error, detail: found.detail }); return; }
      res.status(200).json({
        ok: true,
        found: !!found.found,
        description: found.description || "",
        cards: found.cards || []
      });
      return;
    }

    if (action === "open") {
      const origin = process.env.ANET_COMM_ORIGIN || anet.requestOrigin(req);
      if (!origin) { res.status(200).json({ ok: false, error: "no_origin" }); return; }

      const found = await anet.getCustomerProfileByEmail({ email });
      if (!found.ok) { res.status(200).json({ ok: false, error: found.error, detail: found.detail }); return; }

      let customerProfileId = found.found ? found.customerProfileId : "";
      let mode = "manage";
      if (!customerProfileId) {
        // No profile — create one tagged as a protection plan, then open the
        // add-card page. merchantCustomerId just needs to be unique (<=20 chars).
        const created = await anet.createCustomerProfile({
          requestId: "PP" + Date.now().toString(36),
          description: "Residential Protection Plan",
          email
        });
        if (!created.ok) { res.status(200).json({ ok: false, error: created.error, detail: created.detail }); return; }
        customerProfileId = created.customerProfileId;
        mode = "add";
      }

      const hosted = await anet.getHostedProfileToken({
        customerProfileId,
        communicatorUrl: origin + "/anet-communicator.html",
        page: mode === "manage" ? "manage" : "addPayment"
      });
      if (!hosted.ok) { res.status(200).json({ ok: false, error: hosted.error, detail: hosted.detail }); return; }

      res.status(200).json({ ok: true, token: hosted.token, action: hosted.action, mode });
      return;
    }

    if (action === "sync") {
      // Push the newest Authorize.Net payment method into RepairShopr so
      // recurring invoices charge it. Called by the console after a save.
      const found = await anet.getCustomerProfileByEmail({ email });
      if (!found.ok) { res.status(200).json({ ok: false, error: found.error, detail: found.detail }); return; }
      if (!found.found || !(found.cards || []).length) { res.status(200).json({ ok: false, error: "no_payment_method" }); return; }
      const newest = found.cards[found.cards.length - 1];
      let expiration = "";
      const m = String(newest.expiration || "").match(/^(\d{4})-(\d{2})$/);
      if (m) expiration = m[2] + "/" + m[1].slice(2);
      const rs = await fetchJson(N8N_PP_SYNC_URL, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({
          syncKey: process.env.INTAKE_SYNC_KEY || "",
          email,
          customerExternalId: found.customerProfileId,
          paymentProfileId: newest.paymentProfileId,
          lastFour: newest.last4 || "",
          expiration
        })
      });
      if (!rs) { res.status(200).json({ ok: false, error: "rs_sync_unreachable" }); return; }
      res.status(200).json({
        ok: !!rs.ok,
        error: rs.ok ? null : (rs.error || "rs_sync_failed"),
        customerId: rs.customerId || null,
        created: !!rs.created,
        updated: rs.updated || 0
      });
      return;
    }

    if (action === "duplicates") {
      // get-by-email refused (several profiles share the email) — sweep the
      // account's profile IDs and return every profile matching this email so
      // the console can offer a keep-one/delete-rest resolution.
      const idsRes = await anet.getCustomerProfileIds();
      if (!idsRes.ok) { res.status(200).json({ ok: false, error: idsRes.error, detail: idsRes.detail }); return; }
      const ids = idsRes.ids || [];
      if (ids.length > 1500) { res.status(200).json({ ok: false, error: "too_many_profiles", count: ids.length }); return; }
      const infos = await mapLimit(ids, 25, id =>
        anet.getCustomerProfileInfo({ customerProfileId: id }).catch(() => null));
      const matches = infos.filter(p => p && p.ok && String(p.email || "").toLowerCase() === email);
      res.status(200).json({
        ok: true,
        profiles: matches.map(p => ({
          profileId: p.profileId,
          description: p.description,
          merchantCustomerId: p.merchantCustomerId,
          cards: p.cards
        }))
      });
      return;
    }

    if (action === "resolve") {
      // Keep one profile, delete the listed others. Every deletion target is
      // re-verified server-side to belong to this email before it is deleted.
      const keepId = String(body.keepId || "");
      const deleteIds = Array.isArray(body.deleteIds) ? body.deleteIds.map(String) : [];
      if (!/^\d{4,}$/.test(keepId) || !deleteIds.length ||
          deleteIds.some(d => !/^\d{4,}$/.test(d)) || deleteIds.indexOf(keepId) !== -1) {
        res.status(400).json({ ok: false, error: "bad_request" }); return;
      }
      const deleted = [], failed = [];
      for (const id of deleteIds) {
        const info = await anet.getCustomerProfileInfo({ customerProfileId: id });
        if (!info.ok) { failed.push({ id, error: info.error }); continue; }
        if (String(info.email || "").toLowerCase() !== email) { failed.push({ id, error: "email_mismatch" }); continue; }
        const del = await anet.deleteCustomerProfile({ customerProfileId: id });
        if (del.ok) deleted.push(id); else failed.push({ id, error: del.error });
      }
      res.status(200).json({ ok: failed.length === 0, deleted, failed });
      return;
    }

    res.status(400).json({ ok: false, error: "bad_action" });
  } catch (e) {
    const code = (e && e.code) === "anet_not_configured" ? "anet_not_configured" : "server_error";
    res.status(200).json({ ok: false, error: code, detail: String((e && e.message) || e) });
  }
};

// The duplicate-profile sweep can take longer than the default limit.
module.exports.config = { maxDuration: 60 };
