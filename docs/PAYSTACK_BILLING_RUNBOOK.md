# Paystack Billing Runbook

This document covers the direct Kasitek workspace billing integration. It does not apply to the separate white-label tenant platform.

## Required configuration

Set this only on `kasitek-core`:

```text
PAYSTACK_SECRET_KEY=<Paystack test or live secret key>
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

The browser callback is `${FRONTEND_URL}/billing?payment=complete`. It only shows payment status. It does not activate access.

## Processing rules

- Checkout creation requires an organisation owner or admin.
- A `BillingCheckout` record is created before Paystack is called.
- A signed `charge.success` event must reference that checkout.
- Processing locks the checkout and is safe to repeat.
- Existing active subscriptions for the same product are cancelled before the replacement is activated.
- Every signed event is retained in `PaystackWebhookEvent` with its processing outcome.
- Card details are never stored by Kasitek.

## Support checks

When payment appears successful but access is missing:

1. Find the `BillingCheckout` by the Paystack transaction reference.
2. Check whether its status is `PENDING`, `FAILED`, or `COMPLETED`.
3. Find the corresponding `PaystackWebhookEvent` and inspect `status` and `errorMessage`.
4. Confirm the internal plan still exists and its Paystack plan code matches the provider plan.
5. Do not add a manual grant without recording a reason and, where appropriate, an expiry.

Use Paystack test mode until successful payment, duplicate delivery, forged signature, failed payment, cancellation, and restoration paths have all been exercised.
