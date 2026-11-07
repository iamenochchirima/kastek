# KasiTek Billing

Central billing service for Growth, Agents, and Agency. It owns payment provider integration,
billing accounts, the plan catalog, subscriptions, invoices, credits, usage records, and the
signed entitlement snapshots products use for access.

## Boundary

| Owner | Responsibility |
| --- | --- |
| Billing service | Money, Paystack, catalog prices, plan versions, subscriptions, invoices, credit ledger, usage events, reconciliation. |
| Product APIs | What a capability means, product permissions, write/read policy, local entitlement cache, product usage emission. |
| Product databases | Product organizations, memberships, resources, and product-local usage. |

Products do not read the billing database. They call the internal API with a signed product
authority and verify the signed entitlement snapshot.

## Local setup

```sh
cp .env.example .env
pnpm install
pnpm build:shared
pnpm migrate:billing
pnpm seed:billing
pnpm dev:billing
pnpm dev:billing-worker
```

The service uses a dedicated database URL. Do not point `BILLING_DATABASE_URL` at Growth, Agents,
Agency, Analytics, Operations, or Admin data.

`BILLING_INTERNAL_SECRET`, `BILLING_SNAPSHOT_SECRET`, and `KASITEK_ADMIN_SERVICE_SECRET` must be
at least 32 bytes. `PAYSTACK_MODE=live` fails closed if `PAYSTACK_LIVE_SECRET_KEY` is missing; it
never falls back to a test key.

## Money and tax

All amounts are integer minor units. ZAR is the default and monthly is the only enabled interval.

Plan versions declare `taxInclusive` and `taxRateBps` (1,500 = 15% VAT):

- inclusive: `amountMinor` is gross; the invoice extracts the VAT component from it.
- exclusive: `amountMinor` is net; the invoice adds VAT and Paystack charges the gross total.

Paystack receives the gross total. The invoice stores net, VAT, and gross separately. Invoice
numbers use the `billing.invoice_number_seq` sequence, not provider references.

## Product authority

Product servers create the header with
`@kasitek-labs/server-support/billing-authority`:

```ts
createBillingAuthority({
  secret: BILLING_SERVICE_SECRET,
  product: "growth",
  method: "POST",
  path: "/internal/usage",
  body: JSON.stringify(payload),
});
```

The assertion covers the product, method, path, body digest, issue time, expiry, and nonce.
Replays are rejected. Admin requests use the existing admin authority with audience `billing`.

## Entitlement snapshots

The snapshot includes access state, plan and subscription identity, boolean features, numeric
limits, current-month meter usage, credit balance, revision, and expiry. It is signed with
`BILLING_SNAPSHOT_SECRET`. Products cache it briefly and verify it before trusting a cached copy.

- `active`: full access.
- `trialing`: trial access.
- `grace`: read-only paid access after a failed payment.
- `read_only`: local provider state is not yet reconciled.
- `none`: no access.

## Tests

```sh
BILLING_TEST_DATABASE_URL=postgresql://.../kasitek_billing_test pnpm test:billing
```

The integration fixture covers signed product authority, free-plan assignment, checkout,
VAT invoice math, usage debit, recurring charge visibility, full-refund credit revocation,
amount mismatch reconciliation, and invalid webhook signatures. It uses a local fake Paystack
HTTP server; no real payment is made.
