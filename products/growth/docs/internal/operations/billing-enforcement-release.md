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
- The legacy `dev-client` webhook cannot be removed in the current Paystack account and is accepted as a monitored residual. It must not be treated as the billing authority.
- Hosted dashboards and alerts for billing and AI denial events.
- Agents DB-backed analytics and seat-boundary tests remain open. The local PostgreSQL has pgvector 0.8.6; the Agents schema requires 0.8.7, so those suites cannot run locally.

## Managed AI usage policy (10 November 2026)

```text
Change: Managed AI usage debits the plan allowance at provider list price; bring-your-own provider keys bypass the allowance; paid managed models are exposed on paid plans.
Owner: iamenochchirima
Risk: high
Affected services and user surfaces: Agents API, worker and web model picker; Growth API and billing usage panel; central billing service and worker; plan comparison copy.
Platform release version or release ID: pending live publication with the existing billing gate.
API/schema/migration changes: billing migration 007_ai_cost_meters; Agents schema 141_ai_usage_cost, 142_managed_model_allowlist and 143_usage_forward_skip. No plan version is created or republished.
Feature flag or rollout method: migration 007 must run before the Agents and Growth code. Meter prices live in billing.capabilities, so rollback is a price change, not a deploy reversal.
Analytics events and success metrics: not applicable; no new product analytics contract event. Success is a managed turn whose credit debit equals its settled model cost, and a BYO turn that debits nothing.
Logs, metrics, dashboards, and alerts: billing usage events carry the meter and unit; the Agents worker already reports billing_usage_forward_failed. Hosted dashboards remain a release-process gap.
User, API, internal, and operational documentation: central-billing.md, the feature map and the production rollout runbook are updated in this change.
Validation evidence: see below.
Rollback or disable plan: set agent_ai_cost and growth_ai_cost to 0 and agent_tokens and growth_agent_tokens back to 2. The attribution columns stay and are ignored.
Post-release review date: 14 days after live publication.
```

### What changed

- The flat 2 micro-USD per token charge is replaced by cost-based debits on the `agent_ai_cost`
  and `growth_ai_cost` meters, priced at 1 credit per micro-USD.
- Token meters remain for analytics and are priced at zero.
- Root settlement attributes managed model cost into `usage_ledger.managed_cost_micros`. Operations
  on customer-supplied connections contribute zero.
- An unresolved operation bills its reserved upper bound.
- A platform-managed connection exposes an allowlist in `managed_model_ids`, defaulting to the
  curated `defaultManagedModelIds` set.
- Free plans keep the free managed models; paid models are hidden from the picker and rejected at
  admission with `MODEL_PLAN_REQUIRED`. Customer provider keys require a paid plan.
- A managed task's model cost is capped at the remaining credit balance, and a capped failure
  returns `BILLING_AI_ALLOWANCE_EXHAUSTED` instead of `MODEL_COST_LIMIT`.
- The usage forwarder records `account_not_linked` instead of blocking the queue behind a tenant
  that can never settle.

### Validation evidence

- Cost attribution fixture on the local Agents database: one managed settled reservation of 4,200
  micro-USD, one BYO compaction reservation of 9,999 and one managed unknown reservation with a
  1,000 upper bound produced 5,200 micro-USD. BYO cost was excluded.
- The same fixture forwarded one `agent_ai_cost` event for 5,200 credits and one `agent_tokens`
  event for 0 credits; the billing balance moved by exactly 5,200.
- Managed catalogue on the local workspace: six allowlisted models with live OpenRouter pricing;
  the free picker projection returned only the free model.
- Targeted Agents tests: 40 passed across billing access, model admission, model accounting, model
  dispatch, connected model view and the allowlist helper.
- Typecheck: Agents API, Growth API and the billing service.
- `pnpm verify:boundaries`: passed for 2,757 source and script files.
- Local runtime limitation: the Restate server is not running (Docker is unavailable), so a live
  model turn could not be executed. Execution dispatch failed with `RUNTIME_DISPATCH_FAILED`; the
  cost, forwarding and debit path was verified with the fixture above instead.

### Rollout order

1. Run billing migration 007.
2. Apply Agents schema 141, 142 and 143.
3. Deploy the Agents API and worker, then the Growth API.
4. Confirm a managed turn debits its settled cost and a BYO turn debits nothing.
5. Publish the plan comparison copy.

### Open items

- Live model-turn verification once the local Restate runtime is available.
- The `BillingUsageOutbox.quantity` column is an integer, so a single Growth task above roughly
  USD 2,147 would not fit. Per-task cost is far below that today.
- Concurrent managed tasks admitted against the same balance can each reserve the full remainder.
  The last burst can overspend by at most the number of concurrent roots, and the debit still stops
  at the available balance.
