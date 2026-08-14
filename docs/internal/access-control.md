# Workspace access and billing

## Purpose

KasiTek sells workspace plans. Application code does not authorize users by product or plan
name. Plans can change without requiring every controller, worker, connection, and navigation
item to be renamed.

The access model has four separate concepts:

1. **Offering** — the internal checkout catalogue entry. The current offering key is
   `workspace`.
2. **Plan** — a price, billing interval, provider plan code, and a set of entitlements.
3. **Capability** — a boolean permission to use a workspace feature.
4. **Meter** — a monthly usage counter with an optional numeric limit.

`Product` and `ProductPlan` remain the database names during the compatibility period. They
represent offerings and plans; they are not authorization boundaries.

## Capability keys

Capability keys describe stable user actions:

- `feature.agents.manage`
- `feature.analytics.view`
- `feature.campaigns.manage`
- `feature.campaigns.send`
- `feature.bookings.access`
- `feature.contacts.access`
- `feature.content.manage`
- `feature.content.publish`
- `feature.inbox.access`
- `feature.templates.manage`

The canonical registry is in
`server/kasitek-core/src/services/billing.rs`. A new capability must be registered there before
it can be assigned to a plan or workspace.

Backend code calls `billing::require_capability`. The frontend reads
`BillingSummary.features`. Neither layer should inspect product keys, plan names, or payment
provider metadata to decide access.

## Meter keys

Meters are also independent of plans:

- `agent_deployments`
- `campaign_recipients`
- `social_publishes`

Limits use `limit.<meter>`, for example `limit.campaign_recipients`. New events are recorded
with `UsageEvent.productKey = 'workspace'` and the meter key in `metricKey`.

Code calls `require_meter_available` before the operation and `record_meter_usage` only after
the operation succeeds. Idempotency keys remain required for usage writes.

## Resolution order

Active manual organization grants and entitlements from active, trial, or grace-period
subscriptions are merged. Boolean access uses logical OR and numeric limits use the largest
active value.

During the migration window, the resolver falls back from a capability or meter to its old
product-scoped key. A direct value on the new key takes precedence. Migration
`20260728120000_refactor_feature_entitlements` copies old grants and plan entitlements to the
new keys, so this fallback can be removed after all deployed databases have migrated.

## Adding paid access

To introduce a paid feature:

1. Add a stable capability constant and registry entry.
2. Guard the backend operation with `require_capability`.
3. Add the capability to relevant plans in the billing catalogue.
4. Expose the same key to frontend navigation or controls when early feedback is useful.
5. Add a meter only when usage is billable or limited; a capability does not require a meter.
6. Test both allowed and denied backend paths. Frontend locks are guidance, not security.

Do not add `product.<name>.enabled` checks. Do not infer access from a plan name, payment
status in the browser, or the existence of a connected account.

## Base and paid features

A capability may be present in every plan. This is how base workspace access should be
represented when the platform begins enforcing it. Features that are currently free do not
need a guard until the base-plan provisioning path is in place.

This avoids silently locking existing workspaces while still giving paid features one
consistent authorization mechanism.
