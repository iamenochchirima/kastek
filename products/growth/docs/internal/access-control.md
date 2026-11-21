# Workspace access and billing

Growth access is derived from a signed entitlement snapshot issued by the central billing
service. Growth does not keep a local plan catalog, subscription table, AI usage ledger, or
entitlement table.

## Product boundary

- `services/billing/` owns billing accounts, plans, prices, subscriptions, invoices, AI usage,
  usage, Paystack, and reconciliation.
- Growth owns the meaning of its capability keys, its product permissions, and the code paths
  that enforce them.
- Growth links an organization to a billing account through the billing service's
  `(product='growth', tenant_id=<orgId>)` link.

See the [central billing architecture](./architecture/central-billing.md) and
[billing support runbook](./runbooks/billing-support.md).

## Capability registry

Growth's canonical registry is `api/src/services/billing.ts`:

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

A backend operation calls `requireCapability`. The signed snapshot answers whether the current
plan includes the key. Frontend navigation reads the same snapshot through the billing summary;
it is guidance, not authorization.

## Meters

Growth meters are `agent_deployments`, `campaign_recipients`, `social_publishes`, and
`public_api_requests`. Plan limits use `limit.<meter>`. Growth writes usage to
`BillingUsageOutbox`; the `billing-usage-forwarder` worker sends it to central billing.

## Resolution order

The billing service merges active plan entitlements and account grants. Boolean access is ORed;
numeric limits use the largest active value. Growth caches the signed snapshot for at most 60
seconds and invalidates it after checkout, subscription actions, and usage writes.

## Adding paid access

1. Add a stable capability constant in Growth's registry.
2. Guard the backend operation with `requireCapability`.
3. Add the capability to the relevant plan in central billing.
4. Expose the same key to frontend controls when useful.
5. Add a meter only when usage is limited or billable.
6. Test both allowed and denied backend paths.

Do not infer access from a plan name, a browser payment return, or a local database row.
