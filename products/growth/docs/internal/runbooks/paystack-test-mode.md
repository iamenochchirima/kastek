---
title: Paystack Test-Mode Validation
---

# Paystack Test-Mode Validation

> **Moved:** test-mode checkout and webhook validation now runs against the central billing
> service, not Growth.

Use a dedicated billing database and Paystack test keys in `services/billing/.env`:

```text
BILLING_DATABASE_URL=postgresql://.../kasitek_billing
PAYSTACK_MODE=test
PAYSTACK_TEST_SECRET_KEY=sk_test_...
BILLING_INTERNAL_SECRET=<32+ bytes>
BILLING_SNAPSHOT_SECRET=<32+ bytes>
KASITEK_ADMIN_SERVICE_SECRET=<32+ bytes>
BILLING_FREE_PLANS_JSON={"growth":"growth-free","agents":"agents-free","agency":"agency-free"}
```

Point Paystack's test webhook at `POST /webhooks/paystack` on the billing service. The browser
return URL must be in `BILLING_RETURN_ORIGINS`.

Validate one Growth checkout from a Growth workspace. Confirm:

1. One `billing.checkouts` row completes.
2. One `billing.invoices` row has the expected subtotal, VAT, and total.
3. Plan credits appear in `billing.credit_ledger`.
4. A renewal creates a second invoice visible through Growth billing.
5. A full refund cancels the subscription and revokes unspent plan credits.
6. The entitlement snapshot changes only after the server-side verification or webhook.
