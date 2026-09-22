// =============================================================================
// Call Console — card on file lookup / manager  (Vercel serverless function)
//
//   POST /api/card-on-file  { action: "lookup", email }
//     -> { ok, found, cards:[{brand,last4,expiration}], description }
//   POST /api/card-on-file  { action: "open", email, mode?: "manage"|"add" }
//     -> { ok, token, action, mode }            (show the hosted page)
//
// Lets the SOHO team check what card an existing customer has on file with
// Authorize.Net, then update it or add a new one — without an Authorize.Net
// login and without the card number ever touching the Call Console:
//   - lookup: find the customer profile by email (masked summaries only —
//             brand, last 4, expiry — exactly what Authorize.Net returns)
//   - open:   profile exists  -> hosted "manage payment methods" page token
//             (mode "manage": view / edit in place / add / delete) or the
//             single "add a card" page (mode "add")
//             no profile yet   -> create one and return the "add" page token
//
// This is the successor of the retired protection-plan tool (api/protection-plan.js,
// removed 2026-08-12). The RepairShopr sync and the duplicate-profile deleter
// were NOT carried over: duplicates are reported so the team can clean them up
// in Authorize.Net → Manage Customers, nothing here deletes anything.
//
// Not gated (decision 2026-09-22): the lookup only ever returns Authorize.Net's
// masked values, and card entry/edit happens on the hosted page. The console
// URL itself is the access control.
// Env vars: ANET_API_LOGIN_ID, ANET_TRANSACTION_KEY (see _anet.js)
// Optional: ANET_COMM_ORIGIN
// =============================================================================

const anet = require("./_anet.js");

function maskedCards(list) {
  return (list || []).map(c => ({
    brand: c.brand || "Card",
    last4: c.last4 || "",
    expiration: c.expiration || ""
  }));
}

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
  try {
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = {}; } }
    body = body || {};

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
        cards: maskedCards(found.cards)
      });
      return;
    }

    if (action === "open") {
      const origin = process.env.ANET_COMM_ORIGIN || anet.requestOrigin(req);
      if (!origin) { res.status(200).json({ ok: false, error: "no_origin" }); return; }

      const found = await anet.getCustomerProfileByEmail({ email });
      if (!found.ok) { res.status(200).json({ ok: false, error: found.error, detail: found.detail }); return; }

      let customerProfileId = found.found ? found.customerProfileId : "";
      let mode = String(body.mode || "") === "add" ? "add" : "manage";
      if (!customerProfileId) {
        // No profile yet — create one, then open the add-card page.
        // merchantCustomerId just needs to be unique (<=20 chars).
        const created = await anet.createCustomerProfile({
          requestId: "COF" + Date.now().toString(36),
          description: "SOHO customer — card on file",
          email
        });
        if (!created.ok) { res.status(200).json({ ok: false, error: created.error, detail: created.detail }); return; }
        customerProfileId = created.customerProfileId;
        mode = "add";
      } else if (!(found.cards || []).length) {
        mode = "add";   // nothing to manage yet
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

    res.status(400).json({ ok: false, error: "bad_action" });
  } catch (e) {
    const code = (e && e.code) === "anet_not_configured" ? "anet_not_configured" : "server_error";
    res.status(200).json({ ok: false, error: code, detail: String((e && e.message) || e) });
  }
};
