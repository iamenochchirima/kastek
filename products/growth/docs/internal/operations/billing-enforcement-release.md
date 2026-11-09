# Billing enforcement and rollout release record

Status: pre-live. Enforcement, checkout and webhook verification are complete in sandbox. Live
catalog publication is the final gate and has not been executed.

## Release record

```text
Change: Make Growth and Agents plan features, limits and AI allowances real; verify checkout and webhooks; prepare the live catalog.
Owner: iamenochchirima
Risk: high
Affected services and user surfaces: Growth API and web, Agents API and web, central billing service and worker, Paystack checkout and webhooks, public pricing pages.
Platform release version or release ID: pending live publication.
API/schema/migration changes: no new billing schema migration in this release; existing billing migrations 001 and 002 are required.
Feature flag or rollout method: product enforcement follows the billing snapshot; live publication is gated by PAYSTACK_MODE=live and new plan versions.
Analytics events and success metrics: no new Analytics contract events; success is a paid checkout, correct entitlement snapshot, a delivered webhook and zero AI usage beyond the credit balance.
Logs, metrics, dashboards, and alerts: billing.webhook_events records processed/ignored/failed deliveries; API denials use bounded error codes. Hosted dashboards and alerts remain a release-process gap.
User, API, internal, and operational documentation: updated in this change.
Validation evidence: see below.
Rollback or disable plan: retire the active plan versions, republish the prior versions, restore plan codes and webhook settings.
Post-release review date: 14 days after live publication.
```

## What changed

- Growth content, analytics and AI operations are gated by plan capabilities and the AI credit
  balance.
- Agents inbox analytics, team seats and AI task admission are gated by plan capabilities and the
  AI credit balance.
- AI usage warns at 80% and stops at zero. No overage billing.
- Agents plan versions no longer grant `limit.agent_tokens`; the dollar credit balance is the
  enforced allowance.
- Checkout stores the real Paystack subscription code and disables the previous Paystack
  subscription after a plan change.
- Public plan endpoints return active, customer-visible data only, with canonical pricing URLs and
  sitemaps.

## Validation evidence

- Growth API: 113/113 tests, including public plan filtering.
- Agents API: public plan tests and billing-access tests; DB-backed suites still skip without
  `AGENTS_TEST_DATABASE_URL`.
- Billing: 21/21 integration tests against a disposable PostgreSQL database.
- Sandbox checkout: all seven paid tiers produced a paid invoice, 15% VAT split, active
  subscription, pinned plan version, correct AI credit and correct entitlement snapshot.
- Upgrade/downgrade, pinned subscribers, cancel-at-period-end, admin trial start/extend/end.
- Webhooks: renewal, duplicate, failed renewal, grace expiry, refund, dispute and invalid
  signature. Real Paystack `refund.pending` and `refund.processed` deliveries reached
  `https://billing-dev.kasitek.co.za/webhooks/paystack`.
- Public pricing: both pages verified for canonical metadata, mouse and keyboard selection, and
  mobile overflow at 390px.
- Boundaries pass; full `pnpm typecheck:all` passes; affected builds and Labs lint/build pass.

## Analytics and logging

- Growth denial code: `ai_allowance_exhausted`.
- Agents denial code: `BILLING_AI_ALLOWANCE_EXHAUSTED`.
- Plan feature and limit denials use the existing bounded billing error codes.
- Webhook outcomes are recorded in `billing.webhook_events` with event key, type, status, error
  message and timestamps.
- Request logs include route, status and timing. No card data, tokens or message bodies are
  recorded.
- No new Analytics contract events were added; `not applicable` for a new product analytics event.

## Rollout

1. Finish public pricing and release-record checks.
2. Provision the live billing host and live Paystack key.
3. Create live plans and record their codes.
4. Apply and publish live plan versions.
5. Register `https://billing.kasitek.co.za/webhooks/paystack` and remove the legacy webhook.
6. Run the live verification in the production rollout runbook.
7. Owner approval is required before enabling live checkout.

## Rollback

- Disable live checkout by retiring the new plan versions.
- Republish the prior active version for each plan and currency.
- Restore the prior Paystack plan codes if a code changed.
- Restore the prior webhook URL if webhook delivery is faulty.
- Restore the prior billing deployment image and database backup if the service is unhealthy.
- Existing subscribers remain pinned and do not need migration.

## Explicitly not applicable

- Agency paid plans, partner billing and client-workspace checkout remain deferred.
- Annual billing, referrals, auto top-ups and bundles are not part of this release.
- No new public API contract version is introduced.

## Open items

- Live Paystack key, live plan codes and live billing host.
- Owner approval for live mode and any real-money smoke purchase.
- Removal of the legacy `dev-client` webhook.
- Hosted dashboards and alerts for billing and AI denial events.
