---
id: central-billing
title: Central billing service
sidebar_position: 4
owner: platform-engineering
last_reviewed: 2026-11-08
---

# Central billing service

`services/billing/` is the system of record for money and commercial access. Growth, Agents, and
Agency keep their own databases, identities, and feature definitions. They link a tenant to a
billing account and receive a signed entitlement snapshot from the billing service.

## What the service owns

- Billing accounts, payer identity, and tenant links.
- Catalog products, capabilities, plans, plan versions, prices, and Paystack plan codes.
- Paystack checkout, verified transactions, signed webhooks, refunds, and disputes.
- Subscriptions, periods, cancellation, past-due state, and grace.
- Invoices, invoice lines, VAT breakdown, and sequential invoice numbers.
- AI usage credit accounts, grants, ledger entries, expiry, and usage debits.
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
- AI usage balance;
- account revision;
- an expiry timestamp.

Products verify the snapshot with `BILLING_SNAPSHOT_SECRET` and cache it briefly. Growth caches for
at most 60 seconds and invalidates the cache after checkout, subscription actions, and usage
writes. The service remains authoritative.

## Payer identity

A billing account has one `billing_email`. Checkout uses that address, not whichever product user
started the upgrade. The first successful payment stores the Paystack customer code on the
account. If a later verified payment returns a different customer code, the payment still
activates the subscription and the service records a `provider_customer_mismatch` reconciliation
issue instead of silently replacing the payer.

One billing account can hold subscriptions for Growth, Agents, and Agency. Invoices remain
per subscription in v1 and are grouped by product in product billing surfaces.

## Account linking

A billing account links to one active product workspace per product. Growth and Agents can share
one payer account when both of these match:

- the workspace owner's shared OIDC issuer and subject;
- the normalized verified billing email.

When both match, `POST /internal/accounts/ensure` attaches the new product organization to the
existing account in the background and assigns that product's free plan if needed. A second
workspace for a product that is already linked to the account is rejected; it needs a different
billing email and account. Different identity or email means a separate account. Team members do
not create or link billing accounts; only the workspace owner's billing identity is used.

Agency workspace linking is deferred with the Agency commercial workstream.

## Currency, tax, and Paystack

The service charges in the plan version currency. ZAR is the default. Monthly billing is the only
supported interval.

A plan version declares whether its list price is VAT-inclusive or VAT-exclusive:

- **VAT-inclusive:** `amountMinor` is the gross amount the customer pays. The invoice calculates
  the 15% VAT component inside that amount. Example: R350.00 gross, R304.35 net, R45.65 VAT.
- **VAT-exclusive:** `amountMinor` is the net amount. The invoice adds 15% VAT, and Paystack is
  initialized with the gross total. Example: R350.00 net, R52.50 VAT, R402.50 charged.

Paystack always receives the gross total in minor units. The invoice stores subtotal, tax, and
total separately. No annual interval is enabled. The currency on the plan is the currency charged;
there is no conversion.

Paystack South Africa settles ZAR only. A USD plan version can be configured and priced, but
checkout needs a USD-capable provider before it can be activated. Product plan lists filter by the
billing account currency so customers do not see a currency that cannot be charged.

## Dynamic plan catalog

The catalog is admin-managed. Seeding creates defaults only when a plan key does not already exist;
it never overwrites later admin changes.

### Capabilities

A capability is a product-scoped definition used to build plan entitlements:

- `kind`: `feature`, `limit`, or `meter`;
- `value_type`: `boolean`, `integer`, `decimal`, or `string`;
- `unit`, display group, display order, and customer visibility;
- `implementation_status`: `implemented`, `product_pending`, or `display_only`;
- optional credit cost per unit and minimum charge for metered usage.

A limit with `implementation_status` other than `implemented` must be marked
`display_only` in the plan entitlement or have a product guard before the version can be
published. This prevents a plan from promising a limit that the product does not enforce.

### Plan versions

A plan can have multiple versions per currency. Each version moves through:

- `draft`: editable, not sold;
- `scheduled`: validated and waiting for its effective timestamp;
- `active`: sold and returned by product plan lists; immutable;
- `retired`: no longer sold; existing subscribers remain pinned.

Publishing a version retires the previous active version for the same plan and currency. Existing
subscriptions keep their `plan_version_id`, so entitlement changes only affect new checkouts until
an explicit migration is performed. A unique index enforces one active version per plan and
currency.

A price or currency change requires a new Paystack plan code. An entitlement-only change may reuse
the existing Paystack plan code for the same price and interval. The service rejects a publish that
maps one Paystack plan code to a different price, currency, or interval.

### Default plans

Seeded paid plans start as drafts because a paid plan cannot be published without its real Paystack
plan code. Free plans are active.

| Product | Plan | Price | AI usage | Notes |
| --- | --- | --- | --- | --- |
| Growth | Free | R0 | $0 | Inbox, contacts, bookings; one seat and channel |
| Growth | Growth | R350 | $5 | 3 seats, 1 channel, 500 campaign recipients |
| Growth | Growth Mid | R999 | $20 | Campaigns, social, analytics, workspace agents |
| Growth | Growth Scale | R1,999 | $50 | Higher limits and more channels |
| Agents | Free | R0 | $1 | One agent and a small monthly allowance |
| Agents | Starter | R499 | $10 | Three agents and two channels |
| Agents | Growth | R999 | $25 | Ten agents and five channels |
| Agency | Free | R0 | $0 | One client workspace |
| Agency | Partner | R2,999 | $50 | Ten client workspaces and five staff seats |

Agents and Agency limits that do not yet have product guards are seeded as `display_only`.

## AI usage credits

AI usage is denominated in USD internally. Growth workspace agents settle under the
`growth_agent_tokens` meter; standalone Agents settles under `agent_tokens`. Both use the same
micro-USD ledger and credit price of 2 micro-USD per accounted token. Growth forwards a terminal
agent task's accounted tokens through `BillingUsageOutbox` once, keyed by task ID. Ledger amounts are micro-USD: `$5.00` is stored as
`5,000,000`. Customers see dollar amounts, not an opaque credit count. Plan credit allowances,
usage prices, grants, balances, and refunds all use the same micro-USD unit.

Usage events are idempotent and debit the account ledger. Products record local usage and forward
it through a durable outbox where available; the billing service is the settlement authority.
Credit top-ups are not self-serve in v1. Admin grants are the only purchase path.

## Free plan, trial, and grace

- A new account is assigned the product's configured free plan.
- A trial is created through the admin assignment endpoint with status `trialing`; it has no
  provider subscription and no card. The default is 14 days on the selected plan.
- Admin can start a trial, extend it in place, or end it early. Ending a trial assigns the free
  plan, revokes unspent trial AI usage, and keeps subscription history. The trial UI is in
  Admin → Billing → Trials and subscriptions.
- A trial receives the selected plan's AI usage allowance for the trial period. Extending the
  trial extends the grant expiry. Converting or changing plans revokes unspent plan AI usage
  before granting the new plan.
- A failed Paystack payment moves the subscription to `past_due` with `grace_ends_at` seven days
  later. The snapshot reports `grace`; products treat write capabilities as read-only.
- After grace, the worker cancels the subscription and the snapshot reports `none`.

## Endpoints

Product-facing:

| Endpoint | Purpose |
| --- | --- |
| `POST /internal/accounts/ensure` | Create or resolve the billing account for a product tenant. |
| `GET` or `POST /internal/entitlements` | Return the signed entitlement snapshot. |
| `POST /internal/usage` | Record idempotent product usage and debit AI usage. |
| `GET /internal/usage` | Current-month meter totals and recent events. |
| `GET /internal/plans?currency=ZAR` | Active plans for the authenticated product, filtered by currency. |
| `GET /internal/plans/:planKey?currency=ZAR` | Current plan version and customer-visible entitlements. |
| `POST /internal/checkout` | Create a Paystack checkout using the account payer identity. |
| `POST /internal/checkout/:reference/verify` | Verify and activate a checkout. |
| `POST /internal/subscriptions/:id/cancel` | Disable renewal at Paystack and keep access to period end. |
| `POST /internal/subscriptions/:id/reactivate` | Re-enable renewal. |
| `GET /internal/account` | Account, links, subscriptions, invoices, open issues, and AI usage. |
| `GET /internal/invoices` | All invoices, including recurring invoices. |
| `GET /internal/credits` | AI usage balance and ledger. |

Public webhook: `POST /webhooks/paystack` with the raw body and `x-paystack-signature`.

Admin catalog endpoints:

- `GET /admin/catalog`: offerings, capabilities, plans, versions, entitlements, access definitions.
- `POST /admin/products`, `POST /admin/capabilities`.
- `POST /admin/plans`, `GET /admin/plans/:planKey`.
- `POST /admin/plans/:planKey/versions`, `PUT /admin/plan-versions/:id`.
- `PUT /admin/plan-versions/:id/entitlements`.
- `POST /admin/plan-versions/:id/schedule`, `POST /admin/plan-versions/:id/publish`,
  `POST /admin/plan-versions/:id/retire`.
- `POST /admin/plans/:planKey/clone`.

Trial administration:

- `POST /admin/accounts/:id/subscriptions/assign` with `status: "trialing"` and `trialDays`.
- `POST /admin/accounts/:id/subscriptions/:subscriptionId/trial/extend`.
- `POST /admin/accounts/:id/subscriptions/:subscriptionId/trial/end`.

Account, grant, credit, assignment, invoice, reconciliation, audit, and metrics endpoints remain
available for support operations.

## Product billing surfaces

- Growth shows plan pricing, AI usage, invoices, checkout, and renewal controls.
- Agents settings shows the current plan, AI usage, plan prices, invoices, and open billing issues.
- Agency Billing shows the current plan, AI usage, plan prices, invoices, and open billing issues.

Agents and Agency surfaces are read-only in v1. Plan changes and payment method updates are not
self-serve there.

## Sandbox verification

On 2026-11-08 the Growth plans were published against Paystack test mode:

| Plan | Paystack sandbox plan code | Amount |
| --- | --- | --- |
| Growth Entry | `PLN_938zqbi735rutu0` | R350 |
| Growth Mid | `PLN_6j1bbb4kw4z3nnl` | R999 |
| Growth Scale | `PLN_x6m880cpcxqz8b8` | R1,999 |

A sandbox checkout for Growth Entry completed with reference
`ks_4e922fb59906439bb5458c6f6133e998`. The billing service:

- stored provider customer `CUS_01w89fb1nkod36j` on the billing account;
- activated `growth-entry` version 1 and canceled the account's free subscription;
- created paid invoice `KS-2026-000001` for ZAR 350.00;
- granted USD 5.00 (`5,000,000` micro-USD) of AI usage;
- returned an active entitlement snapshot with 3 seats, 1 channel and 500 campaign recipients.

The sandbox payment was completed through the Paystack hosted checkout and verified with
`POST /internal/checkout/:reference/verify`. Webhook-driven renewal, refund and dispute paths were
not exercised because the local service has no public HTTPS callback URL.

## Growth cutover

Growth has no legacy billing implementation or local billing tables. These variables are required
for customer billing:

```text
BILLING_SERVICE_URL=http://127.0.0.1:4500
BILLING_SERVICE_SECRET=<shared product authority secret>
BILLING_SNAPSHOT_SECRET=<shared snapshot secret>
BILLING_SERVICE_TIMEOUT_MS=3000
```

Without them, Growth billing routes return `503 service_unavailable`; they do not fall back to a
local provider. Growth records usage in `BillingUsageOutbox` and the worker forwards it to billing.
Growth no longer registers a Paystack webhook.

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
checkouts, reconciles provider subscriptions, activates due scheduled plan versions, expires
credit grants, and transitions expired trials and grace periods. Agency usage outbox rows are drained by the Agency
`analytics-publisher` worker process and can also run under `billing-usage-worker`.

## Release record

| Field | Decision |
| --- | --- |
| Change | Central billing, Growth cutover, and dynamic plan catalog. |
| Owner | Platform engineering. |
| Risk | High: money, access, signed webhooks, subscription state, and catalog publication. |
| Affected surfaces | Growth billing routes and guards, central billing API/worker, Admin billing catalog and AI usage controls, Agents settings and admission, Agency billing and agent execution. |
| Migration | New `billing` schema, `002_dynamic_catalog.sql`, Growth billing cutover migration, Agents schema `135_billing_usage.sql`, Agency `20261108100000_billing_usage_outbox.sql`. |
| Rollout | Run the service in Paystack test mode, publish ZAR plans with real Paystack plan codes, verify checkout/webhook/renewal/refund/grace, then switch live keys. Publish new versions for catalog changes; do not mutate published versions. |
| Rollback | Disable checkout by retiring the affected plan versions. Restore the previous active version where a rollback is needed. Billing data remains in the service database. Removing product billing variables disables billing; it does not restore local billing. |
| Analytics and logs | Structured worker and request logs; no card data or full webhook payloads in logs. Usage forwarding failures remain in outboxes with retry state. |
| Documentation | This page, `services/billing/README.md`, `ARCHITECTURE.md`, and product billing support runbooks. |
| Validation | Billing typecheck/build and 15/15 integration tests; Growth typecheck/build and 180 passing tests; Agents, Agency, Admin, Growth web, Agents web, and Agency web typecheck/build; fresh billing migrate and seed; boundary check; Paystack sandbox plans published and Growth Entry checkout completed with paid invoice, active subscription and USD 5.00 AI usage. |
| Open decisions | Live Paystack keys and a public webhook URL, a USD-capable provider, self-serve top-ups, Agents and Agency product guards for currently display-only limits, and custom-work invoice migration. |
