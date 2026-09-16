// =============================================================================
// Call Console — Autotask lookups  (Vercel serverless function)
//
//   GET /api/autotask?kind=companies              -> { ok, count, companies:[{id,name,phone,type,address}] }
//   GET /api/autotask?kind=contacts&companyId=123 -> { ok, count, contacts:[{id,name,firstName,lastName,email,phone}] }
//   GET /api/autotask?kind=priorities             -> { ok, priorities:[{value,label,isDefault}] }
//
// Thin proxy to the n8n "Call Console — Autotask Lookup" webhook, same pattern
// as /api/config, /api/parts and /api/support-intake. n8n holds the Autotask
// credential; this function never sees it. Read-only — nothing here writes to
// Autotask. Company / priority lists are CDN-cached briefly (they change
// rarely); contacts are always fetched fresh so a contact added moments ago
// shows up.
//
// Optional env var: N8N_AUTOTASK_LOOKUP_URL (defaults to the webhook below).
// =============================================================================

const N8N_AUTOTASK_LOOKUP_URL = process.env.N8N_AUTOTASK_LOOKUP_URL ||
  "https://thecomputerwarriors.app.n8n.cloud/webhook/cw-autotask-lookup";

const CACHE = { companies: "public, s-maxage=300, stale-while-revalidate=900",
                priorities: "public, s-maxage=3600, stale-while-revalidate=86400",
                contacts: "no-store" };

module.exports = async (req, res) => {
  try {
    let kind = "", companyId = "";
    try {
      const u = new URL(req.url, "http://x");
      kind = (req.query && req.query.kind) || u.searchParams.get("kind") || "";
      companyId = (req.query && req.query.companyId) || u.searchParams.get("companyId") || "";
    } catch (_) { kind = (req.query && req.query.kind) || ""; companyId = (req.query && req.query.companyId) || ""; }

    kind = String(kind).trim().toLowerCase();
    companyId = String(companyId).trim();
    if (!CACHE[kind]) { res.setHeader("Cache-Control", "no-store"); res.status(400).json({ ok: false, error: "bad_kind" }); return; }
    if (kind === "contacts" && !/^\d{1,12}$/.test(companyId)) { res.setHeader("Cache-Control", "no-store"); res.status(400).json({ ok: false, error: "bad_company_id" }); return; }

    const qs = "?kind=" + encodeURIComponent(kind) + (kind === "contacts" ? "&companyId=" + encodeURIComponent(companyId) : "");
    const ctrl = new AbortController();
    const timer = setTimeout(() => ctrl.abort(), 45000);   // companies = ~1,000 rows over 3 Autotask pages (~5s)
    const r = await fetch(N8N_AUTOTASK_LOOKUP_URL + qs, { headers: { "Accept": "application/json" }, signal: ctrl.signal });
    clearTimeout(timer);
    const data = await r.json().catch(() => null);
    if (!data || !data.ok) {
      res.setHeader("Cache-Control", "no-store");
      res.status(200).json({ ok: false, error: (data && data.error) || "lookup_unreachable", detail: (data && data.detail) || undefined });
      return;
    }

    res.setHeader("Cache-Control", CACHE[kind]);
    if (kind === "companies") {
      // Drop the shop's own record (id 0) — never the customer on a ticket.
      const companies = (data.companies || []).filter(c => Number(c.id) > 0);
      res.status(200).json({ ok: true, count: companies.length, companies });
    } else if (kind === "contacts") {
      res.status(200).json({ ok: true, count: data.count || 0, contacts: data.contacts || [] });
    } else {
      res.status(200).json({ ok: true, priorities: data.priorities || [] });
    }
  } catch (e) {
    res.setHeader("Cache-Control", "no-store");
    res.status(200).json({ ok: false, error: String((e && e.message) || e) });
  }
};
