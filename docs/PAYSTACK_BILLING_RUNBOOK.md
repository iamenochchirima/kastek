# Paystack Billing Runbook

This document covers the direct Kasitek workspace billing integration. It does not apply to the separate white-label tenant platform.

## Required configuration

Set this only on `kasitek-core`:

```text
PAYSTACK_SECRET_KEY=<Paystack test or live secret key>
PAYSTACK_API_BASE_URL=https://api.paystack.co
FRONTEND_URL=https://app.example.com
KASITEK_CORE_PUBLIC_URL=https://api.example.com
```

Do not expose the secret key through Next.js public variables. Product plans must have an active internal `ProductPlan` record and a matching `paystackPlanCode`. Prices and plan codes belong in database records, not application code.

## Webhook

Configure this URL in Paystack:

```text
https://api.example.com/api/webhooks/paystack
```

For local testing, expose the core server through a tunnel and use the same path. The handler verifies `x-paystack-signature` against the unmodified request body before parsing or storing the event.

The browser callback is `${FRONTEND_URL}/billing?payment=complete`. Paystack adds the transaction reference to this URL. The billing page sends that reference to the authenticated server verification endpoint. The browser does not decide whether access is granted.

## Processing rules

- Checkout creation requires an organisation owner or admin.
- A `BillingCheckout` record is created before Paystack is called.
- Checkout retries reuse the same provider checkout when the same idempotency key is supplied.
- A signed `charge.success` event must reference that checkout.
- A server-verified callback transaction can complete the same checkout if the webhook has not arrived yet.
- Processing locks the checkout and is safe to repeat.
- Existing active subscriptions for the same product are cancelled before the replacement is activated.
- Every signed event is retained in `PaystackWebhookEvent` with its processing outcome.
- Normalized verification results are retained on the checkout. Card data is not copied into the checkout record.
- Card details are never stored by Kasitek.

## Reconciliation

Pending checkout transactions older than 30 seconds are rechecked by the billing reconciliation worker. In the API process this worker starts with the other background workers. It can also run as a separate process:

```text
KASITEK_PROCESS=billing-reconciliation-worker cargo run -p kasitek-core
```

The default interval is five minutes. Set `PAYSTACK_RECONCILIATION_INTERVAL_SECONDS` and `PAYSTACK_RECONCILIATION_BATCH_SIZE` to change it. The interval cannot be lower than 30 seconds.

An authenticated Kasitek admin can trigger the same bounded check with `POST /api/admin/billing/reconcile/paystack`. A non-zero `failed` count is logged for operator review. Active subscription-state reconciliation is still pending and must be completed before live billing is enabled.

## Support checks

When payment appears successful but access is missing:

1. Find the `BillingCheckout` by the Paystack transaction reference.
2. Check whether its status is `PENDING`, `FAILED`, or `COMPLETED`.
3. Find the corresponding `PaystackWebhookEvent` and inspect `status` and `errorMessage`.
4. Inspect `providerResponse` on the checkout for the last normalized verification result.
5. Run the admin reconciliation endpoint if the checkout remains pending beyond the normal worker interval.
6. Confirm the internal plan still exists and its Paystack plan code matches the provider plan.
7. Do not add a manual grant without recording a reason and, where appropriate, an expiry.

Use Paystack test mode until successful payment, duplicate delivery, forged signature, failed payment, cancellation, and restoration paths have all been exercised.
