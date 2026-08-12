// =============================================================================
// Call Console — protection plan payment manager  (REMOVED 2026-08-12)
//
// This tool was retired: RepairShopr silently pins a customer-level gateway
// token and ignores customer profile IDs sent through its public API, so a
// replaced Authorize.Net profile could not be reliably re-linked for
// recurring billing. Protection plan payment updates are handled directly in
// Authorize.Net / RepairShopr instead.
//
// The endpoint intentionally returns 410 Gone so any cached console build
// fails loudly rather than silently.
// =============================================================================

module.exports = async (req, res) => {
  res.setHeader("Cache-Control", "no-store");
  res.status(410).json({ ok: false, error: "feature_removed" });
};
