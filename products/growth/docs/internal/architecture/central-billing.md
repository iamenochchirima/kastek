---
id: central-billing
title: Central billing service
sidebar_position: 4
owner: platform-engineering
last_reviewed: 2026-11-07
---

# Central billing service

`services/billing/` is the system of record for money and commercial access. Growth, Agents, and
Agency keep their own databases, identities, and feature definitions. They link a tenant to a
billing account and receive a signed entitlement snapshot from the billing service.

## What the service owns

- Billing accounts and tenant links.
- Catalog products, plans, plan versions, prices, and Paystack plan codes.
- Paystack checkout, verified transactions, signed webhooks, refunds, and disputes.
- Subscriptions, periods, cancellation, past-due state, and grace.
- Invoices, invoice lines, VAT breakdown, and sequential invoice numbers.
- Credit accounts, grants, ledger entries, expiry, and usage debits.
- Usage events and reconciliation issues.
- Admin audit records for catalog and account changes.

Products own what each capability key means and where it is enforced. The billing service stores
the plan-to-capability mapping but does not decide whether a campaign send or an inbox read is a
write.

## Product authentication

Product servers sign every request with `BILLING_INTERNAL_SECRET` using
`@kasitek-labs/server-support/billing-authority`. The assertion binds the product, HTTP method,
path, body digest, issue time, expiry, and a one-time nonce. Billing rejects a replayed nonce.

Admin requests use the existing `KASITEK_ADMIN_SERVICE_SECRET` and admin authority with audience
`billing`. Admin writes are recorded in `billing.audit`.

## Entitlement snapshots

`GET /internal/entitlements?product=growth&tenantId=<id>` returns a signed snapshot:

- access state: `active`, `trialing`, `grace`, `read_only`, or `none`;
- plan and subscription identity;
- boolean features;
- numeric limits;
- current-month meter usage;
- credit balance;
- account revision;
- an expiry timestamp.

Products verify the snapshot with `BILLING_SNAPSHOT_SECRET` and cache it briefly. Growth caches for
at most 60 seconds and invalidates the cache after checkout, subscription actions, and usage
writes. The service remains authoritative.

## Currency, tax, and Paystack

The service charges in the plan currency. ZAR is the default. Monthly billing is the only
supported interval.

A plan version declares whether its list price is VAT-inclusive or VAT-exclusive:

- **VAT-inclusive:** `amountMinor` is the gross amount the customer pays. The invoice calculates
  the 15% VAT component inside that amount. Example: R350.00 gross, R304.35 net, R45.65 VAT.
- **VAT-exclusive:** `amountMinor` is the net amount. The invoice adds 15% VAT, and Paystack is
  initialized with the gross total. Example: R350.00 net, R52.50 VAT, R402.50 charged.

Paystack always receives the gross total in minor units. The invoice stores subtotal, tax, and
total separately. A B2B plan can therefore be priced net while an SMB plan is displayed
VAT-inclusive without changing checkout code.

No annual interval is enabled. No multi-currency conversion is performed. The currency on the
plan is the currency charged.

## Plans and current catalog state

The seed command creates:

- `growth-free`: active, R0, inbox/contacts/bookings, zero campaign/social/agent allowance,
  and 1,000 public API requests per month.
- `growth-entry`: draft, R350/month, 5,000 credits, no entitlements yet, no Paystack plan code.

The draft entry plan is intentional. Feature entitlements and the Paystack plan code are assigned
through the admin API after the packaging decision. The catalog structure does not depend on the
final feature set; plan entitlements are arbitrary `feature.*` and `limit.*` keys.

## Free plan, trial, and grace

- A new Growth billing account is assigned `growth-free` from `BILLING_FREE_PLANS_JSON`.
- A 14-day trial is created through the admin assignment endpoint with status `trialing`; it has
  no provider subscription and no card.
- A failed Paystack payment moves the subscription to `past_due` with `grace_ends_at` seven days
  later. The snapshot reports `grace`; products treat write capabilities as read-only.
- After grace, the worker cancels the subscription and the snapshot reports `none`.
- Credit top-ups are not self-serve. Admin grants are the only purchase path until a top-up
  checkout is implemented.

## Endpoints

Product-facing:

| Endpoint | Purpose |
| --- | --- |
| `POST /internal/accounts/ensure` | Create or resolve the billing account for a product tenant. |
| `GET` or `POST /internal/entitlements` | Return the signed entitlement snapshot. |
| `POST /internal/usage` | Record idempotent product usage and debit credits. |
| `GET /internal/usage` | Current-month meter totals and recent events. |
| `GET /internal/plans` | Active plans for the authenticated product. |
| `GET /internal/plans/:planKey` | Current plan version and entitlements. |
| `POST /internal/checkout` | Create a Paystack checkout. |
| `POST /internal/checkout/:reference/verify` | Verify and activate a checkout. |
| `POST /internal/subscriptions/:id/cancel` | Disable renewal at Paystack and keep access to period end. |
| `POST /internal/subscriptions/:id/reactivate` | Re-enable renewal. |
| `GET /internal/account` | Account, links, subscriptions, and credits. |
| `GET /internal/invoices` | All invoices, including recurring invoices. |
| `GET /internal/credits` | Credit balance and ledger. |

Public webhook: `POST /webhooks/paystack` with the raw body and `x-paystack-signature`.

Admin: `/admin/catalog`, `/admin/products`, `/admin/capabilities`, `/admin/plans`,
`/admin/plans/:key/versions`, `/admin/plan-versions/:id/entitlements`, `/admin/accounts`,
account links, grants, credits, plan assignment, invoices, reconciliation issues, audit, and
metrics.

## Growth cutover

Set these Growth API variables to move Growth off the legacy billing implementation:

```text
BILLING_SERVICE_URL=http://127.0.0.1:4500
BILLING_SERVICE_SECRET=<shared product authority secret>
BILLING_SNAPSHOT_SECRET=<shared snapshot secret>
BILLING_SERVICE_TIMEOUT_MS=3000
```

With the service configured:

- Growth customer billing routes delegate to the service.
- Growth feature and meter guards read the signed snapshot.
- Growth records local usage and mirrors it to the service.
- Growth no longer registers the Paystack webhook; the billing service does.

Without these variables, the legacy Growth billing code remains active. That fallback is for
migration and local development, not the target architecture.

## Operating the service

```sh
pnpm install
pnpm build:shared
pnpm build:billing
BILLING_DATABASE_URL=... pnpm migrate:billing
BILLING_DATABASE_URL=... pnpm seed:billing
pnpm start:billing
pnpm start:billing-worker
```

The API and worker use the same build artifact. The worker holds a PostgreSQL advisory lock so
only one reconciliation loop runs per database. It retries failed webhooks, checks pending
checkouts, reconciles provider subscriptions, expires credit grants, and transitions expired
trials and grace periods.

## Release record

| Field | Decision |
| --- | --- |
| Change | Add the central billing service and Growth cutover bridge. |
| Owner | Platform engineering. |
| Risk | High: money, access, signed webhooks, and subscription state. |
| Affected surfaces | Growth billing routes, entitlement guards, usage outbox, central billing API/worker, Admin billing pages, Agents admission/usage forwarding, Agency agent execution. |
| Migration | New `billing` schema; Growth migration removes local billing tables and adds `BillingUsageOutbox`; Agents schema 135 adds billing usage forwarding. |
| Rollout | Run the service in Paystack test mode, configure Growth, verify checkout/webhook/renewal/refund/grace, then switch live keys. |
| Rollback | Remove the Growth billing service variables; the legacy implementation remains available. Billing data remains in the service database. |
| Analytics and logs | Structured worker and request logs; no card data or full webhook payloads in logs. |
| Documentation | This page and `services/billing/README.md`. |
| Validation | Billing typecheck/build and 8/8 Paystack fixture tests; Growth typecheck/build/tests; Agents and Agency typecheck/build; Growth migration applied on a fresh database; boundary check passed. |
| Open decisions | Final Growth entry entitlements, Agents and Agency paid plans, credit cost per action, self-serve top-ups, live Paystack configuration, and manual custom-work invoice migration. |
