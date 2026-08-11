# Call Console — Authorize.Net Card-on-File (SOHO / Immediate Need)

New-customer support requests are held until a payment method is vaulted with
**Authorize.Net (Accept Customer hosted form)**. Existing-customer requests flow
through the current n8n workflow completely unchanged.

**Card data never touches** the Call Console, Vercel, n8n, Cognito, email, or
this repo. The card is typed into Authorize.Net's own hosted page; our systems
only ever see the masked summary Authorize.Net returns (e.g. `Visa •••• 4242`).

---

## Architecture

```
Cognito intake (iframe in Call Console)
  └─ Post JSON → n8n /webhook/cw-support-intake        ["Call Console — Support Intake & Payment State"]
       ├─ Does The Company Exist? = Yes → forward payload UNCHANGED to the
       │    existing "SOHO Support Request Form Submitted" webhook → done
       └─ No → store intake as awaiting_payment (SupportIntake data table), hold ticket
  └─ Cognito redirect (inside the iframe) → /payment-bridge.html?request=SOHO-[Entry Number]
       └─ postMessage → Call Console swaps the pane to the payment step

Call Console → /api/payment-token  (Vercel fn, ANET_* env vars)
   1. checks n8n state == awaiting_payment          (server-side gate)
   2. createCustomerProfileRequest (idempotent; E00039 duplicate → reuse ID)
   3. stores customerProfileId back in n8n (sync-key protected webhook)
   4. getHostedProfilePageRequest → short-lived token (~15 min)
Call Console → POSTs token to https://accept.authorize.net/customer/addPayment in an iframe
   employee types the card into AUTHORIZE.NET's form
   iframe events (resize / successfulSave / cancel) arrive via /anet-communicator.html

Call Console → /api/payment-verify
   1. asks Authorize.Net directly: does the profile have a payment profile?  (client is never trusted)
   2. yes → n8n marks payment_secured → forwards the HELD payload (+ PaymentSecured,
      AuthorizeNetCustomerProfileId, CardOnFileSummary fields) to the legacy webhook → released
   3. Call Console shows "Payment Method Secured — Visa •••• 4242 — [Finish]"
```

State machine (SupportIntake data table, n8n):
`awaiting_payment → payment_secured → released` (new) · `released` (existing) ·
`forward_failed` (legacy webhook was down — Verify retries the release only, never the card).

## Files in this repo

| File | Role |
|---|---|
| `index.html` | Call Console app — payment pane in SOHO → Immediate Need |
| `payment-bridge.html` | Cognito redirect target inside the iframe; hands the request ID to the app |
| `anet-communicator.html` | Authorize.Net iframe communicator (UI events only) |
| `api/_anet.js` | Authorize.Net API helpers (server-side only; not an endpoint) |
| `api/payment-token.js` | POST — state check, create profile, hosted-form token |
| `api/payment-verify.js` | POST — verify vaulted method with Authorize.Net, release ticket |
| `api/support-intake.js` | GET — intake status for the console (whitelisted fields only) |

## One-time setup

### 1. Vercel environment variables (Project → Settings → Environment Variables)

| Variable | Value |
|---|---|
| `ANET_API_LOGIN_ID` | Authorize.Net API Login ID |
| `ANET_TRANSACTION_KEY` | Authorize.Net Transaction Key |
| `INTAKE_SYNC_KEY` | Copy from the **Auth Update** code node in the n8n workflow "Call Console — Support Intake & Payment State" |
| `ANET_ENV` | *(optional)* `production` (default) or `sandbox` for testing |

The Signature Key and Public Client Key are **not** needed for this flow.
Redeploy after setting the variables.

### 2. n8n — "Call Console — Support Intake & Payment State"

1. Open the workflow (Computer Warriors project). It is saved as a **draft — press Publish**.
2. In **both** `Intake Config` and `Update Config` Set nodes, replace
   `PASTE_LEGACY_WEBHOOK_URL_HERE` with the production webhook URL of the
   existing **"SOHO Support Request Form Submitted"** workflow — copy it from
   Cognito's current *Post JSON Data to a Website* endpoint **before** step 3.
   That legacy workflow itself needs **zero changes**.
3. The `SupportIntake` data table holds the intake state (a test row
   `SOHO-9101` from validation can be deleted).

### 3. Cognito form (SOHO Support Request)

1. **Delete the raw card fields**: Card Number, Expiration Date, CVV. Update the
   card-authorization text so it no longer implies the form stores a card, e.g.:
   *"For new customers, a card is securely stored with our payment processor
   (Authorize.Net) before the request is dispatched. Card details are collected
   on the processor's secure form — never on this form or by email."*
2. Keep the single **Submit** button and the **"Does The Company Exist?"** field
   — it is the routing condition.
3. *Submission Settings → Post JSON Data to a Website*: change the endpoint to
   `https://thecomputerwarriors.app.n8n.cloud/webhook/cw-support-intake`
4. *Confirmation → Redirect to an external website*, URL:
   `https://<your-call-console-domain>/payment-bridge.html?request=SOHO-[Entry Number]`
   (insert the Entry Number merge field with Insert Field). Recommended: redirect
   **all** submissions — the console shows the right card either way (existing
   customers get a "Request submitted" confirmation, new customers get the
   payment step). If you prefer, make it conditional with a Calculation field so
   only `Does The Company Exist? = No` redirects; existing customers then keep
   Cognito's own confirmation message.

### 4. Deploy

Merge the `authorize-net-cof` branch to `main` (Vercel auto-deploys). Do the
Cognito repoint (step 3.3) **after** the deploy and after n8n is published.

## Test plan

Use `ANET_ENV=sandbox` + sandbox credentials first if you want a dry run, then production.

1. **Existing customer**: submit with *Does The Company Exist? = Yes* → normal
   flow fires exactly as before (ticket/email from the legacy workflow), console
   shows the submitted confirmation. No payment step.
2. **New customer**: submit with *No* → console swaps to **Secure Payment
   Method** with the customer's name → *Add Card on File* → Authorize.Net form
   loads inside the pane → enter a card (sandbox: `4111 1111 1111 1111`, any
   future expiry, any CVV) → **✓ Payment Method Secured · Visa •••• 1111** →
   ticket releases (legacy workflow fires with `PaymentSecured: true`).
3. In Authorize.Net → **Customer Information Manager → Manage Customers**: the
   profile appears with description `CW support intake SOHO-<n> — <name>`;
   billing charges it manually after the work, then applies the payment to the
   QuickBooks invoice as usual.
4. **Cancel mid-entry** → console returns to the payment card, "No card was
   saved." → *Add Card on File* works again (fresh token).
5. **Refresh during payment** → reopen SOHO → Immediate Need → the pending
   payment step resumes automatically (request ID is kept in sessionStorage;
   there's also a "load it" link under the intake form as a fallback).
6. **Skip attempt**: there is no client path to release a new-customer ticket —
   release happens only in n8n after `/api/payment-verify` confirms the payment
   profile with Authorize.Net.
7. **Verify pressed without a saved card** → "The card wasn't saved yet" and the
   request stays held.

## Edge cases handled

- **Authorize.Net down / not configured** → clear error card with Retry; intake stays `awaiting_payment`.
- **Duplicate profile** (double submission, retry) → E00039 parsed, existing profile reused.
- **Token expiry (~15 min)** → every *Add Card on File* click fetches a fresh token.
- **Card saved but release failed** (n8n/legacy webhook down) → console says the card **was** saved,
  do **not** re-enter it; *Verify* retries the release only (idempotent).
- **Duplicate Cognito POST** of the same entry → upsert on `requestId` (SOHO-<entry number>), no duplicate rows.
- **Abandoned request** → row stays `awaiting_payment` in the SupportIntake table for follow-up;
  it never creates a ticket.

## Notes

- `api/index.html` in this repo looks like an accidental duplicate of the root
  `index.html` — it isn't referenced by anything and can be deleted.
- The n8n status webhook returns name/status only; the public `/api/support-intake`
  endpoint whitelists further (no email, no profile ID).
- To retire the flow, point Cognito's Post JSON endpoint back at the legacy webhook.
