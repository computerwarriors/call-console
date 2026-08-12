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

    res.status(400).json({ ok: false, error: "bad_action" });
  } catch (e) {
    const code = (e && e.code) === "anet_not_configured" ? "anet_not_configured" : "server_error";
    res.status(200).json({ ok: false, error: code, detail: String((e && e.message) || e) });
  }
};
