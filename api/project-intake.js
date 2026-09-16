// =============================================================================
// Call Console — project request intake  (Vercel serverless function)
//
//   POST /api/project-intake  {intake}  -> { ok, requestId }
//
// Used by the console's native Project Request form. Forwards the submission
// to the n8n "SOHO Team: Opportunity Submission Form" webhook — the same one
// the Cognito project form posted to, in the same field shape — so the
// workflow runs unchanged: creates the company/contact if needed, opens an
// Autotask opportunity, and posts to the SOHO Project Lead Teams chat.
//
// No payment hold on this path (project requests are quoted first).
//
// Optional env var: N8N_PROJECT_INTAKE_URL (defaults to the webhook below).
// =============================================================================

const N8N_PROJECT_INTAKE_URL = process.env.N8N_PROJECT_INTAKE_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/5f56982d-8aa2-461b-8e25-b83f6d2c3d30";

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  try {
    if (req.method !== "POST") { res.status(405).json({ ok: false, error: "method_not_allowed" }); return; }
    let body = req.body;
    if (typeof body === "string") { try { body = JSON.parse(body); } catch (_) { body = null; } }
    if (!body || typeof body !== "object") { res.status(400).json({ ok: false, error: "bad_body" }); return; }

    const detail = String(body.WhatIsBeingRequestedProvideAsMuchDetailAsPossible || "").trim();
    const hasCompany = body.DoesTheCompanyOrResidentialCustomerExist === true
      ? !!(body.CompanyID && String(body.CompanyID.Label || "").trim())
      : !!(body.Name && String(body.Name.FirstAndLast || "").trim());
    if (!detail || !hasCompany) { res.status(400).json({ ok: false, error: "incomplete" }); return; }
    if (JSON.stringify(body).length > 60000) { res.status(400).json({ ok: false, error: "too_large" }); return; }

    const requestId = "PROJ-" + String((body.Entry && body.Entry.Number) || Date.now().toString(36).toUpperCase());

    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 25000);
    const r = await fetch(N8N_PROJECT_INTAKE_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json", "Accept": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
    clearTimeout(timer);
    // The workflow responds "Workflow got started." (text) as soon as it accepts the payload.
    if (!r.ok) { res.status(200).json({ ok: false, error: "n8n_" + r.status }); return; }
    res.status(200).json({ ok: true, requestId });
  } catch (e) {
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
