// =============================================================================
// Call Console — Authorize.Net helpers (shared by payment-token / payment-verify)
//
// NOT an endpoint: Vercel ignores underscore-prefixed files inside api/.
//
// All Authorize.Net calls happen here, server-side only. The API Login ID and
// Transaction Key come from Vercel environment variables and never reach the
// browser, the repo, n8n, or any log line. Raw card data NEVER passes through
// this code — card entry happens on Authorize.Net's hosted page (Accept
// Customer), and the only card info we ever read back is the masked number
// (XXXX1111) and brand that getCustomerProfile returns.
//
// Required env vars (Vercel → Project → Settings → Environment Variables):
//   ANET_API_LOGIN_ID     Authorize.Net API Login ID
//   ANET_TRANSACTION_KEY  Authorize.Net Transaction Key
// Optional:
//   ANET_ENV              "production" (default) or "sandbox"
// =============================================================================

const ANET_ENV = (process.env.ANET_ENV || "production").toLowerCase();

const API_URL = ANET_ENV === "sandbox"
  ? "https://apitest.authorize.net/xml/v1/request.api"
  : "https://api.authorize.net/xml/v1/request.api";

// Where the hosted Accept Customer form lives (the browser POSTs the token here)
const ACCEPT_BASE = ANET_ENV === "sandbox"
  ? "https://test.authorize.net"
  : "https://accept.authorize.net";

function merchantAuthentication() {
  const name = process.env.ANET_API_LOGIN_ID;
  const transactionKey = process.env.ANET_TRANSACTION_KEY;
  if (!name || !transactionKey) {
    const err = new Error("anet_not_configured");
    err.code = "anet_not_configured";
    throw err;
  }
  return { name, transactionKey };
}

// Authorize.Net's JSON API is order-sensitive: merchantAuthentication must be
// the first property of the request object. Object literals below preserve
// insertion order, so keep merchantAuthentication first in every request.
async function anetCall(requestKey, payload) {
  const body = { [requestKey]: payload };
  const ctrl = new AbortController();
  const timer = setTimeout(() => ctrl.abort(), 12000);
  let r;
  try {
    r = await fetch(API_URL, {
      method: "POST",
      headers: { "Content-Type": "application/json" },
      body: JSON.stringify(body),
      signal: ctrl.signal
    });
  } finally { clearTimeout(timer); }
  const text = await r.text();
  // Authorize.Net prefixes responses with a UTF-8 BOM — strip before parsing.
  const json = JSON.parse(text.replace(/^﻿/, ""));
  const msg = (json.messages && json.messages.message && json.messages.message[0]) || {};
  return { ok: json.messages && json.messages.resultCode === "Ok", code: msg.code || "", text: msg.text || "", json };
}

// Create a customer profile (no payment data). Idempotent per requestId:
// merchantCustomerId is the opaque intake requestId, so a duplicate create
// returns error E00039 whose text contains the existing profile ID.
async function createCustomerProfile({ requestId, description, email }) {
  const res = await anetCall("createCustomerProfileRequest", {
    merchantAuthentication: merchantAuthentication(),
    profile: {
      merchantCustomerId: String(requestId).slice(0, 20),
      description: String(description || "").slice(0, 255) || undefined,
      email: /.+@.+\..+/.test(String(email || "")) ? String(email).slice(0, 255) : undefined
    }
  });
  if (res.ok && res.json.customerProfileId) {
    return { ok: true, customerProfileId: String(res.json.customerProfileId) };
  }
  if (res.code === "E00039") {
    const m = String(res.text).match(/(\d{4,})/);
    if (m) return { ok: true, customerProfileId: m[1], duplicate: true };
  }
  return { ok: false, error: res.code || "anet_error", detail: res.text };
}

// Token for a hosted Accept Customer page (valid ~15 minutes).
// page: "addPayment" (default) opens the single add-card form; "manage" opens
// the payment-method manager (view / edit / add / delete) for the profile.
// communicatorUrl must be a page on the SAME origin as the Call Console so the
// hosted iframe can message the app (resize / successfulSave / cancel).
async function getHostedProfileToken({ customerProfileId, communicatorUrl, page }) {
  const manage = page === "manage";
  const setting = [
    { settingName: "hostedProfileIFrameCommunicatorUrl", settingValue: communicatorUrl },
    { settingName: "hostedProfilePageBorderVisible", settingValue: "false" },
    { settingName: "hostedProfileValidationMode", settingValue: "liveMode" },
    { settingName: "hostedProfileBillingAddressRequired", settingValue: "true" },
    { settingName: "hostedProfileCardCodeRequired", settingValue: "true" }
  ];
  if (manage) setting.push({ settingName: "hostedProfileManageOptions", settingValue: "showPayment" });
  const res = await anetCall("getHostedProfilePageRequest", {
    merchantAuthentication: merchantAuthentication(),
    customerProfileId: String(customerProfileId),
    hostedProfileSettings: { setting }
  });
  if (res.ok && res.json.token) {
    return { ok: true, token: res.json.token, action: ACCEPT_BASE + "/customer/" + (manage ? "manage" : "addPayment") };
  }
  return { ok: false, error: res.code || "anet_error", detail: res.text };
}

// Find a customer profile by email (E00040 = no profile with that email).
// Returns the profile ID plus the masked summary of each stored payment method
// — never anything beyond Authorize.Net's own masked values.
async function getCustomerProfileByEmail({ email }) {
  const res = await anetCall("getCustomerProfileRequest", {
    merchantAuthentication: merchantAuthentication(),
    email: String(email).slice(0, 255),
    unmaskExpirationDate: "true",
    includeIssuerInfo: "false"
  });
  if (!res.ok) {
    if (res.code === "E00040") return { ok: true, found: false };
    return { ok: false, error: res.code || "anet_error", detail: res.text };
  }
  const prof = res.json.profile || {};
  const cards = (prof.paymentProfiles || []).map(p => {
    const cc = p.payment && p.payment.creditCard;
    const ba = p.payment && p.payment.bankAccount;
    let brand = "", last4 = "";
    if (cc) {
      brand = cc.cardType || "Card";
      const m = String(cc.cardNumber || "").match(/(\d{4})\s*$/);
      last4 = m ? m[1] : "";
    } else if (ba) {
      brand = "Bank account";
      const m = String(ba.accountNumber || "").match(/(\d{4})\s*$/);
      last4 = m ? m[1] : "";
    }
    return {
      brand, last4,
      paymentProfileId: String(p.customerPaymentProfileId || ""),
      expiration: (cc && cc.expirationDate) || ""   // "YYYY-MM" (unmasked) or "XXXX"
    };
  });
  return {
    ok: true, found: true,
    customerProfileId: String(prof.customerProfileId || ""),
    description: prof.description || "",
    cards
  };
}

// Does the profile have at least one stored payment method? Returns the masked
// summary of the newest one (e.g. brand "Visa", last4 "1111") — never anything
// more than Authorize.Net's own masked value.
async function getPaymentProfileSummary({ customerProfileId }) {
  const res = await anetCall("getCustomerProfileRequest", {
    merchantAuthentication: merchantAuthentication(),
    customerProfileId: String(customerProfileId),
    includeIssuerInfo: "false"
  });
  if (!res.ok) return { ok: false, error: res.code || "anet_error", detail: res.text };
  const profiles = (res.json.profile && res.json.profile.paymentProfiles) || [];
  if (!profiles.length) return { ok: true, hasPayment: false };
  const p = profiles[profiles.length - 1];
  let brand = "", last4 = "";
  const cc = p.payment && p.payment.creditCard;
  const ba = p.payment && p.payment.bankAccount;
  if (cc) {
    brand = cc.cardType || "Card";
    const m = String(cc.cardNumber || "").match(/(\d{4})\s*$/);
    last4 = m ? m[1] : "";
  } else if (ba) {
    brand = "Bank account";
    const m = String(ba.accountNumber || "").match(/(\d{4})\s*$/);
    last4 = m ? m[1] : "";
  }
  return { ok: true, hasPayment: true, brand, last4, paymentProfileId: String(p.customerPaymentProfileId || "") };
}

// Origin of the page being served — used for the iframe communicator URL.
// On Vercel, x-forwarded-host is set by the platform to the serving domain.
function requestOrigin(req) {
  const host = (req.headers && (req.headers["x-forwarded-host"] || req.headers.host)) || "";
  return host ? ("https://" + String(host).split(",")[0].trim()) : "";
}

module.exports = { createCustomerProfile, getHostedProfileToken, getPaymentProfileSummary, getCustomerProfileByEmail, requestOrigin, ANET_ENV };
