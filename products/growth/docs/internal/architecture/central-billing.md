---
id: central-billing
title: Central billing service
sidebar_position: 4
owner: platform-engineering
last_reviewed: 2026-11-10
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

Paystack can return a successful charge without a subscription code. Activation resolves the code
from the numeric customer ID and the plan, then stores it on the subscription. If resolution fails,
the `subscription.create` webhook remains the fallback that fills the code later.

One billing account can hold subscriptions for Growth, Agents, and Agency. Invoices remain
per subscription in v1 and are grouped by product in product billing surfaces.

## Cancellation

Cancelling a paid subscription disables renewal at Paystack and keeps local access until the end
of the paid period. Paystack rejects re-enabling a disabled subscription, so reactivation only
works while the provider still permits it. A customer who cancels and later wants to resume needs
a new checkout.

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
| Growth | Free | R0 | $0 | Inbox, contacts, calls, bookings and templates; one seat and channel |
| Growth | Starter | R350 | $10 | Campaigns, content, agents, 3 seats, 2 channels and 1,000 recipients |
| Growth | Growth | R999 | $25 | 10 seats, 5 channels, 5,000 recipients and workspace analytics |
| Growth | Scale | R1,999 | $60 | 25 seats, 15 channels, 25,000 recipients and onboarding |
| Agents | Free | R0 | $1 | One agent and one channel |
| Agents | Starter | R350 | $10 | Three agents, human handoff and 100 crawl pages |
| Agents | Growth | R999 | $25 | Ten agents, assignment, analytics and unbranded widgets |
| Agents | Scale | R1,999 | $60 | 25 agents, 10 channels and 2,000 crawl pages |
| Agents | Reseller | R4,999 | $150 | 50 agents, 25 channels, 5,000 crawl pages and dedicated support |
| Agency | Free | R0 | $0 | One client workspace |
| Agency | Partner | R2,999 | $50 | Ten client workspaces and five staff seats |

Growth seats, channels, campaign recipients, social publishes and public API requests are enforced.
Agents agents, channels, crawl pages, handoff, assignment, badge removal and team seats are enforced.
Agency limits remain `display_only` while Agency is deferred.

### Sandbox accounts and plans

Evaluation sandboxes use the same billing service and entitlement checks as customer workspaces. They
are not a billing bypass:

- `billing.accounts.environment` is `sandbox`; ordinary accounts default to `production`.
- `billing.plans.audience` is `sandbox`; ordinary plans default to `public`.
- `growth-sandbox-unlimited`, `agents-sandbox-unlimited`, and `agency-sandbox-unlimited` are active,
  zero-priced sandbox plans. They grant every current product feature, null internal limits, and
  `1,000,000,000,000` micro-USD of test credit.
- Sandbox plans are omitted from `GET /internal/plans`, `GET /internal/plans/:planKey`, and product
  plan lists. They remain visible in `GET /admin/catalog` for operators.
- A sandbox plan can only be assigned to a sandbox account. An ordinary account cannot be converted
  by attaching a sandbox plan.
- Product servers call `POST /internal/accounts/ensure` without an environment. Billing resolves an
  existing sandbox account normally, but explicit environment input must match the stored account.

`POST /internal/sandbox/entitlement` creates or resolves the sandbox customer and assigns the
product's sandbox plan. It requires `x-billing-sandbox-secret` matching `BILLING_SANDBOX_SECRET`,
records `sandbox.entitlement.assign` in `billing.audit`, and is unavailable when
`BILLING_ENVIRONMENT=production`. The evaluation provisioner records the resulting account,
subscription, plan key, and plan version on the sandbox runtime.

Null internal limits do not remove hard safety controls, provider rate limits, context limits,
storage limits, or real compute and model costs.

## AI usage credits

AI usage is denominated in USD internally. Ledger amounts are micro-USD: `$5.00` is stored as
`5,000,000`. Customers see dollar amounts, not an opaque credit count. Plan allowances, usage
prices, grants, balances, and refunds all use the same unit.

Two policies apply, chosen by who pays the model provider.

- **Managed models** debit the allowance at provider list price. A settled operation already records
  its exact cost in `agents_platform.model_cost_reservations.actual_micros`, quoted from the
  pricing captured in the task's admitted model route. Root settlement sums those costs where the
  connection custody is `platform_managed` into `usage_ledger.managed_cost_micros`. Standalone
  Agents forwards that figure as the `agent_ai_cost` meter; Growth forwards it as
  `growth_ai_cost`. Both meters are priced at 1 credit per micro-USD, so the debit equals the
  provider cost. There is no markup.
- **Customer-supplied keys** do not debit the allowance. Their operations contribute zero to
  `managed_cost_micros`. Tokens are still recorded, and `agent_tokens` and `growth_agent_tokens`
  remain as analytics meters priced at zero.

An operation whose provider usage stayed unknown settles as `unknown`. Billing charges its reserved
upper bound so an unresolved call is not free; the model usage report shows the same figure.

Growth does not wait for a client to open a task. Its billing worker pulls the settled-usage feed
`POST /internal/v1/products/growth/usage` from Agents every cycle. The feed is tenant-scoped,
returns ledger rows ordered by settlement time, and carries a microsecond text cursor so a row is
not replayed by millisecond truncation. Growth writes each row to `BillingUsageOutbox` once per
meter, keyed by task ID with `:cost` and `:tokens` suffixes. Standalone Agents forwards through
`billing_usage_forwarded`, keyed the same way on `agents:task:<id>`.

Usage events are idempotent and debit the account ledger. Products record local usage and forward
it through a durable outbox where available; the billing service is the settlement authority.
Credit top-ups are not self-serve in v1. Admin grants are the only purchase path.

## Managed model catalogue

A platform-managed connection stores its exposed models in
`agents_platform.model_provider_connections.managed_model_ids`. `managed_model_id` remains the
default model and the fallback for rows created before the allowlist existed.

`managedModelDefaultFromEnvironment` provisions the connection once per organization from the
curated list in `defaultManagedModelIds`, overridable with `AGENTS_DEFAULT_MODEL_IDS`. The allowlist
must include the default model, and a configured model that the provider no longer lists is marked
unavailable rather than silently dropped.

Free plans keep the free managed models. `ModelProviderStore.cachedModels` filters paid models for
them, and admission independently rejects them with `MODEL_PLAN_REQUIRED`; the picker filter is not
an authorization boundary. Customer-supplied provider keys are a paid-plan capability enforced in
`ModelProviderStore.create`.

AI usage stops when the available credit balance reaches zero. Growth checks the balance before
messages, task continuation, task instructions and review approval; Agents checks it at task
admission for platform-managed routes and caps a managed task's model cost at the remaining
balance. Customer-supplied connections keep running at zero because they never debit the allowance.
Both products return an upgrade-required error instead of starting new work, and their usage panels
warn at 80% and 100%.
A task already running may settle with a shortfall, which is not billed as overage. Concurrent
tasks admitted against the same balance can each reserve the full remainder, so the last burst can
overshoot by at most the number of concurrent roots. The dollar credit balance is the
customer-facing allowance; the Agents `limit.agent_tokens` limit is not granted by new plan versions
because the credit balance provides the stop.

## Free plan, trial, and grace

- A new account is assigned the product's configured free plan.
- A trial is created through the admin assignment endpoint or the product-facing
  `POST /internal/trials` endpoint; it has no provider subscription and no card. Growth uses the
  configured `growth-mid` plan for 14 days. A workspace gets one trial per product; a prior trial
  blocks a second one.
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
| `GET /internal/plans?currency=ZAR` | Active public plans for the authenticated product, filtered by currency. |
| `GET /internal/plans/:planKey?currency=ZAR` | Current plan version and customer-visible entitlements. |
| `POST /internal/sandbox/entitlement` | Attach a sandbox plan to a sandbox account for the evaluation provisioner. |
| `POST /internal/checkout` | Create a Paystack checkout using the account payer identity. |
| `POST /internal/checkout/:reference/verify` | Verify and activate a checkout. |
| `POST /internal/subscriptions/:id/cancel` | Disable renewal at Paystack and keep access to period end. |
| `POST /internal/subscriptions/:id/reactivate` | Re-enable renewal when Paystack still permits it. |
| `GET /internal/account` | Account, links, subscriptions, invoices, open issues, and AI usage. |
| `GET /internal/invoices` | All invoices, including recurring invoices. |
| `GET /internal/credits` | AI usage balance and ledger. |

Public webhook: `POST /webhooks/paystack` with the raw body and `x-paystack-signature`.
The service handles `charge.success`, `subscription.create`, `subscription.not_renew`,
`subscription.disable`, `invoice.payment_failed`, `refund.pending`, `refund.processed` and
`charge.dispute.create`. Event delivery is idempotent; failed or interrupted events are retried by
the worker. The development endpoint is `https://billing-dev.kasitek.co.za/webhooks/paystack`; the
live endpoint is recorded in the production rollout runbook.

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

- Growth shows plan pricing, AI usage, invoices, trial start, checkout, and renewal controls.
- Growth exposes `GET /api/public/plans` for the public `/pricing` page. It returns only active,
  customer-visible catalog plans and does not require a workspace session.
- Agents settings shows the current plan, AI usage, plan prices, checkout, invoices, and open
  billing issues.
- Agency Billing remains read-only while its paid plan stays draft.

Agency plan changes and payment method updates are not self-serve in this release.

## Public catalog

Each product exposes `GET /api/public/plans` for its public pricing page. The endpoint:

- returns only active plans and active versions, filtered to ZAR;
- includes only customer-visible entitlements;
- omits Paystack plan codes, internal costs, tenant identifiers and draft metadata;
- caches for 60 seconds at the browser and shared cache, with a 300-second stale window;
- returns an empty `configured: false` response rather than internal errors when billing is
  unavailable.

The canonical pricing hosts are `https://app.kasitek.co.za/pricing` for Growth and
`https://agents.kasitek.co.za/pricing` for Agents. The Labs `/pricing` page routes to those product
pages and contains no prices of its own. Each product pricing page is indexable and listed in its
own sitemap.

## Live publication gate

Live catalog publication is the final release step. Test and live plan codes are never mixed in one
deployment. Before live publication, the release owner must approve live mode, the billing service
must run with the live Paystack key and public webhook URL, and the release record must contain the
live plan-code matrix and rollback steps. Publishing new versions retires the previous active
version for the same plan and currency; existing subscribers remain pinned to their purchased
versions.

## Sandbox verification

On 2026-11-08 the original Growth plans were published against Paystack test mode:

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

A second sandbox check linked a Growth organization and an Agents organization through the same
owner identity and billing email. Agents Starter then completed for ZAR 499.00, producing invoice
`KS-2026-000002` and USD 10.00 of AI usage under the same billing account and Paystack customer.

On 2026-11-09 the catalog was repackaged into the current tiers. Active sandbox plan codes:

| Plan | Paystack sandbox plan code | Amount |
| --- | --- | --- |
| Growth Starter | `PLN_0szdbuzvvglr0xi` | R350 |
| Growth | `PLN_6j1bbb4kw4z3nnl` | R999 |
| Growth Scale | `PLN_x6m880cpcxqz8b8` | R1,999 |
| Agents Starter | `PLN_fj6pj1fx6zldscu` | R350 |
| Agents Growth | `PLN_lgemcs47h9pxhdz` | R999 |
| Agents Scale | `PLN_1409yztz8quozkl` | R1,999 |
| Agents Reseller | `PLN_l11l4imajo7mgjj` | R4,999 |

The active sandbox versions are Growth Starter version 2, Growth version 2 and Scale version 2;
Agents Free version 3, Starter version 4, Growth version 3, Scale version 3 and Reseller version 3.
Existing subscribers remain pinned to earlier versions.

All seven paid tiers completed a sandbox checkout on 2026-11-09 and 2026-11-10. Each produced a
paid invoice with a 15% VAT split, an active subscription, the expected pinned plan version, the
expected AI credit grant and the expected entitlement limits. Invoices `KS-2026-000003` through
`KS-2026-000009` cover the seven tiers. Upgrade, downgrade, cancel-at-period-end, pinned legacy
subscribers and admin trial start/extend/end were also checked.

The webhook endpoint is `https://billing-dev.kasitek.co.za/webhooks/paystack`, routed through the
development Cloudflare tunnel to the billing service. A real Paystack `refund.pending` and
`refund.processed` event reached it; duplicate delivery, invalid signature, renewal, failed renewal,
grace expiry and dispute handling were verified. The production sequence is in
[`billing-production-rollout.md`](../runbooks/billing-production-rollout.md).

No live checkout has been recorded. Live publication is the final gate described above.

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
| Validation | Billing typecheck/build and 24/24 integration tests, including sandbox plan visibility, environment guards, endpoint authorization, and a fresh sandbox entitlement; Growth typecheck/build and 180 passing tests; Agents, Agency, Admin, Growth web, Agents web, and Agency web typecheck/build; fresh billing migrate and seed; boundary check; Paystack sandbox plans published and Growth Starter checkout completed with paid invoice, active subscription and USD 10.00 AI usage. |
| Open decisions | Live Paystack keys and a public webhook URL, a USD-capable provider, self-serve top-ups, Agents and Agency product guards for currently display-only limits, and custom-work invoice migration. |
