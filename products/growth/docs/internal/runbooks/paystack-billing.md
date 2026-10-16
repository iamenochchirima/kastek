---
title: Paystack Billing Runbook
owner: platform-ops
last_reviewed: 2026-10-02
---

# Paystack Billing Runbook

This document covers the direct Kasitek workspace billing integration. It does not apply to the separate white-label tenant platform.

The local Core runtime is now TypeScript. The hosted Railway topology remains a separate,
unverified state; check its running revision before changing a deployed worker.

## Required configuration

Set this only on `kasitek-core`:

```text
PAYSTACK_MODE=test
PAYSTACK_TEST_SECRET_KEY=<Paystack test secret key>
PAYSTACK_LIVE_SECRET_KEY=<Paystack live secret key>
PAYSTACK_API_BASE_URL=https://api.paystack.co
FRONTEND_URL=https://app.example.com
KASITEK_CORE_PUBLIC_URL=https://api.example.com
```

Do not expose the secret key through Next.js public variables. Product plans must have an active internal `ProductPlan` record and a matching `paystackPlanCode`. Prices and plan codes belong in database records, not application code.

`PAYSTACK_MODE` selects which key is loaded. It defaults to `test`. The legacy `PAYSTACK_SECRET_KEY` remains a fallback for local compatibility, but deployments should use the mode-specific variables so a test process cannot silently pick up the live key.

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

Pending checkout transactions older than 30 seconds and active provider subscriptions are rechecked by the billing reconciliation worker. In the API process this worker starts with the other background workers. It can also run as a separate process:

```text
KASITEK_PROCESS=billing-reconciliation-worker pnpm --dir api start
```

This starts the compiled TypeScript worker after the Core dependencies are installed and built.

The default interval is five minutes. Set `PAYSTACK_RECONCILIATION_INTERVAL_SECONDS` and `PAYSTACK_RECONCILIATION_BATCH_SIZE` to change it. The interval cannot be lower than 30 seconds.

An authenticated Kasitek admin can trigger the same bounded check with `POST /api/admin/billing/reconcile/paystack`. Provider errors, unknown states, disputes, partial refunds, and corrected state mismatches are stored in `BillingReconciliationIssue`. Admins can inspect them through `GET /api/admin/billing/reconciliation-issues?status=OPEN`. A non-zero failure or open-issue count is also logged.

## Catalogue administration

The internal admin application exposes Product Billing at `/billing`. It manages products, plan intervals and prices, Paystack plan codes, active/draft state, and typed plan entitlements. New plans should remain draft until their provider code and entitlements have been reviewed.

Workspace owners and admins can cancel or reactivate an active Paystack subscription from the workspace Billing page. These actions call Paystack using the subscription code and provider email token; the client does not toggle internal access directly.

## Local database verification

Run billing schema checks only against a disposable local database:

```text
BILLING_TEST_DATABASE_URL=postgresql://.../disposable_db api/scripts/test-billing-db.sh
```

The script refuses non-local database URLs. It checks organisation isolation, usage and checkout idempotency, plan entitlements, and reconciliation issue lifecycle inside a rolled-back transaction.

The repository now includes the historical client-schema baseline in
`database/prisma/migrations/20260301000000_initial_client_schema`.
Fresh disposable databases can use `prisma migrate deploy` before running the
integration SQL. Existing deployed databases already contain those baseline
tables; review migration status and backup before resolving that baseline as
applied once, as described in
[`client-database-migration-baseline.md`](../architecture/client-database-migration-baseline.md).

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
