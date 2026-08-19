# PCI DSS v4.0 — scope determination

**Merchant:** GODEYE. **Gateway:** Paystack. **Determination: SAQ A.**
**Findings addressed here:** S-8 (payment idempotency), D-1 (payment-path index).

This is a scope determination and a readiness note. It is **not** an Attestation
of Compliance, and nothing in this repository produces one — that requires a
completed SAQ signed by a merchant officer, and for some acquirers a scan by an
ASV.

---

## Why SAQ A

SAQ A applies to a card-not-present merchant who has **outsourced all cardholder
data functions** to a validated third-party provider, retaining no electronic
cardholder data.

| Question | GODEYE |
|---|---|
| Does any PAN reach our servers? | **No.** Checkout is `POST /billing/checkout`, which calls Paystack's `/transaction/initialize` and returns an `authorization_url`. The browser is redirected to Paystack. |
| Do we render a payment form? | **No.** No card field exists anywhere in `apps/web`. |
| Do we store, process or transmit cardholder data? | **No.** What is stored is a Paystack `customer_code`, a `subscription_code`, and a transaction `reference` — provider tokens, none of which is a PAN, expiry, CVV, or track data. |
| Do we handle 3-D Secure? | **No.** Paystack does, on its own page. |
| Is the payment page ours? | **No.** It is `checkout.paystack.com`. |

Verify the first row for yourself:

```bash
rg -n "card_number|cardNumber|cvv|cvc|expiry_month|pan\b" apps/ packages/   # expect no results
```

If a future change embeds Paystack Inline, or accepts a card field in our own
DOM, **the scope changes to SAQ A-EP** and this document is wrong until it is
rewritten. That is the single decision that would move us.

## Requirements that still apply under SAQ A

### Req 6.4.3 and 11.6.1 — script integrity on the payment page

Both requirements are about the page that *takes the card*. Ours does not exist:
the browser leaves for `checkout.paystack.com`, and script integrity there is
Paystack's obligation as a validated service provider.

What remains ours is the page that *initiates* the redirect
(`apps/web/src/app/(app)/billing/`). A script injected there could rewrite the
`authorization_url` and send the customer somewhere else. Current position:

- The Next.js app loads no third-party script on the billing route. Verify with
  `rg -n "<script|dangerouslySetInnerHTML" apps/web/src/app/\(app\)/billing/`.
- **Gap:** there is no Content-Security-Policy header, so this is a property of
  the current code rather than an enforced control. Tracked in
  [FINDINGS.md](../audit/FINDINGS.md); a CSP with `script-src 'self'` would make
  it enforced.

### Req 4 — TLS in transit

Railway and Cloudflare both terminate TLS 1.2+ and redirect HTTP. `Secure` is
set on the session cookie in production. Not independently verified from here;
see the operator checklist below.

### Req 12.8 — managing the service provider

Paystack's PCI DSS Level 1 attestation should be on file and re-checked
annually. Not something this repository can hold.

### Req 3 — do not store what you do not need

Nothing to do: no cardholder data is stored. The provider tokens that are stored
are useless without the secret key, which is in the environment and never in the
database.

## Payment correctness — beyond PCI, and the actual risk here

PCI is about card data. The finding that mattered on this path was about
**money**, and it is worth stating plainly next to the scope note.

`applyPayment` deduplicated with a read-then-write against `AuditLog`, with no
transaction and no unique constraint, while two callers race **by design** — the
Paystack webhook and the browser's `POST /billing/verify`. Between the
subscription upsert and the marker insert there was a window in which the second
caller found no marker but read the already-extended `currentPeriodEnd`, and
granted a second 31-day month for one payment. The marker write also carried
`.catch(() => undefined)`, so a transient database error silently removed the
correctness mechanism and Paystack's retry credited the customer again.

Now:

1. **Marker first, effect second, one transaction.** `PaymentApplication` is
   inserted before the subscription is touched. A unique violation means
   "already applied" and nothing after it runs.
2. **`@@unique([provider, reference])`**, plus `@@unique([provider, eventId])`
   so a replayed webhook is refused even under a different reference.
3. **Nothing swallowed.** A marker write that fails for any reason other than a
   duplicate propagates, and the subscription is not touched.
4. **Deterministic extension**, computed inside the transaction from the row the
   transaction itself read.
5. **Raw-body HMAC** over the exact bytes received, constant-time compared. Never
   over re-serialised JSON, which reorders keys and changes the digest.
6. **Daily reconciliation** (`BillingReconciliationService`) reads back
   Paystack's successful transactions and reports any with no local record. It
   **reports rather than repairs**: granting a plan from a transaction this
   system never processed is exactly the operation that should have a human in
   it.

## Operator checklist — the parts a repository cannot do

- [ ] Obtain and file Paystack's current PCI DSS AOC (Req 12.8).
- [ ] Complete and sign SAQ A for the merchant account.
- [ ] Confirm with the acquirer whether an ASV scan is required at this volume.
- [ ] Confirm TLS 1.2+ minimum and HSTS on both the API and the web edge.
- [ ] Add a CSP to the web app so Req 6.4.3's spirit is enforced rather than
      merely true today.
- [ ] Record who reviews the daily reconciliation report, and what they do when
      it is not clean.
