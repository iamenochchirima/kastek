---
title: Paystack Billing Runbook
sidebar_label: Paystack billing
---

# Paystack Billing Runbook

> **Moved:** Paystack checkout, webhooks, subscriptions, invoices, AI usage, and reconciliation now
> belong to [`services/billing/`](../../../../services/billing/README.md). Growth no longer handles
> Paystack callbacks or stores subscription billing tables.

The canonical operating guide is [`services/billing/README.md`](../../../../services/billing/README.md)
and the [central billing architecture](../architecture/central-billing.md).

Growth configuration:

```text
BILLING_SERVICE_URL=https://billing.example.com
BILLING_SERVICE_SECRET=<shared product authority secret>
BILLING_SNAPSHOT_SECRET=<shared snapshot secret>
```

Billing service configuration and Paystack keys live in `services/billing/.env`, not Growth.
Growth's process list exposes `billing-usage-forwarder`; it drains the Growth usage outbox.
