---
title: Billing Support
---

# Billing Support

> **Moved:** subscription billing support is owned by the central billing service.

Use the billing service admin API and database:

- `/admin/catalog`, `/admin/plans/:planKey`, and plan-version publish/retire
- `/admin/accounts` and `/admin/tenants/:product/:tenantId`
- `/admin/tenants/:product/:tenantId/credits` (AI usage balance)
- `/admin/reconciliation-issues`
- `/admin/audit`

Identify the billing account, tenant link, checkout reference, subscription, and provider
identifiers. Check the latest checkout, invoice, AI usage ledger, webhook, and reconciliation issue
before changing state.

Do not edit subscription state directly. Correct a provider mismatch through reconciliation or a
verified provider event. Full refunds revoke unspent plan AI usage; partial refunds remain a
reconciliation issue.

The canonical references are [`services/billing/README.md`](../../../../services/billing/README.md)
and the [central billing architecture](../architecture/central-billing.md).
