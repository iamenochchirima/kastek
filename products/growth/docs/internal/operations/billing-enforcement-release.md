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
- Live managed turns after the cache-write pricing fix: `openai/gpt-5.6-luna` settled 1,040
  micro-USD on 4,043 accounted tokens, and `google/gemini-2.5-flash` settled 1,135 micro-USD on
  3,700 tokens. Each forwarded one `agent_ai_cost` event and one zero-priced token event, and the
  balance moved by the settled amount.
- Without the fix, the same turn settled as `unknown` and billed the 44,237 micro-USD upper bound,
  because discovery dropped OpenRouter's `input_cache_write` price. `discovery.ts` now maps it into
  `cacheWriteMicrosPerMillionTokens`.
- Typecheck: Agents API, Growth API and the billing service.
- `pnpm verify:boundaries`: passed for 2,757 source and script files.
- Local runtime limitation: the Restate runtime is not managed by Docker here; a native
  `restate-server` 1.7.13 was run on `18080`/`19070` and the worker registered at
  `http://127.0.0.1:9080` to complete the live turns.

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

## Growth payment verification (11 November 2026)

Local end-to-end verification of Growth payments, entitlements and AI usage. No schema migration
was required. Commits remain local until the owner pushes.

### What changed

- `d3a6b0b13` — Agents exposes `POST /internal/v1/products/growth/usage`; the Growth billing
  worker pulls settled usage with a microsecond text cursor. Billing no longer depends on a client
  opening the task.
- `304b3d136` — meter limits compare decimal snapshot values. `BigInt("50.000000")` previously
  threw and returned a 500 at a metered limit.
- `556f82785` — billing panel handles the lower-case subscription statuses returned by the API, so
  renewal controls render, past-due and grace labels are correct, and cancellation asks for
  confirmation.
- `f9b28aa46` — the first billing summary retries after lazily creating the account, so a new
  workspace no longer gets a 404 from the invoice and account reads racing account creation.
- Local billing configuration now allows the Growth return origins `http://localhost:3001` and
  `http://localhost:3002`.

### Validation evidence

- Usage panel matched `/api/billing/summary`: 46,221 tokens, 1,234 micro-USD synthetic managed
  cost, 1,000 campaign recipients, 50 publishes, 10,000 API requests, renewal date 11 December.
  A Free workspace showed no AI, campaign or publish meter rows.
- Starter entitlements: 3 seats (fourth invitation 403), 2 connected channels (third 403), 1,001
  campaign recipients blocked at launch (403), 50 publishes reached (403), 10,000 public API
  requests reached (403). Agents bootstrap and gated reads succeeded.
- Free workspace: agents, campaigns, content and analytics endpoints returned 403 with the
  feature name; seat invitation returned 403. After purchase the same endpoints returned 200.
- Cancel and resume through the Growth billing panel: `cancel_at_period_end` moved true then
  false in `billing.subscriptions`; access continued while canceled and a free-model agent turn
  completed.
- Purchase on a fresh workspace through Paystack test mode: Free subscription canceled, Starter
  active, invoice `KS-2026-000022` paid at R350, 10,000,000 micro-USD granted, features enabled.
  Prior Free subscription `sub_272d9e5a…` canceled; new subscription `sub_0bda5233…`.
- Renewal `charge.success`: period moved to 1–31 December 2026, invoice `KS-2026-000023` paid, a
  new 10,000,000 micro-USD grant was created. A duplicate delivery returned `duplicate: true` and
  created nothing.
- `invoice.payment_failed`: status `past_due`, `grace_ends_at` seven days out. During grace,
  agents and campaigns returned 403 `forbidden` with “read-only while billing is past due”;
  analytics reads still reached the downstream service.
- Recovery `charge.success` on the already-invoiced period cleared grace without creating an
  invoice.
- Full refund of `ks_036c81225a1c4756b064519e344b3723`: invoice `KS-2026-000022` refunded,
  subscription canceled, both Growth grants reduced to zero and the Growth balance fell to zero.
  No Agents subscription was canceled and Agents balances were unchanged.
- Grant expiry: a synthetic expired grant of 5,000 was removed by `expireCreditGrants`, leaving a
  zero balance and an `expiry` ledger entry.
- Checks: Growth API typecheck, Growth web typecheck and build, focused billing guard test, and
  `pnpm verify:boundaries`.

### Product limits and errors

The implementation returns bounded 403 responses rather than the speculative codes used in the
verification plan: `forbidden` with a specific message for feature, seat, channel and meter
limits, `ai_allowance_exhausted` for zero AI balance, and 503 `billing_unavailable` when the
billing service rejects checkout. There are no `BILLING_LIMIT_REACHED`, `BILLING_READ_ONLY` or
`BILLING_CHECKOUT_REJECTED` codes in Growth.

### Explicitly not applicable

- Analytics events: no new product analytics were added; existing billing and usage events cover
  the behavior.
- Version or release identity: no package or API version changed.
- Migration and rollback: no schema change; rollback is the previous code revision.
- Live Paystack rollout: remains the owner-approved final step.

### Open items

- The Paystack test checkout did not offer the declined simulation on the plan-change checkout, so
  a provider decline was not exercised through the browser. Checkout rejection was observed as a
  bounded 503 before the return-origin configuration was corrected.
- Meter expiry and grace expiry run in the billing worker; the local worker was not left running.
  The verification called `expireCreditGrants` directly.

## Production API availability hotfix (13 November 2026)

```text
Change: Keep the Growth API available when central billing is not configured.
Owner: iamenochchirima
Risk: medium
Affected services and user surfaces: Growth API, background workers, billing enforcement, usage outbox.
Platform release version or release ID: pending production deployment.
Hotfix commit: 8f4875414.
Tracker: KAS-301.
API/schema/migration changes: none.
Feature flag or rollout method: billing enforcement follows BILLING_SERVICE_URL, BILLING_SERVICE_SECRET and BILLING_SNAPSHOT_SECRET. Absent configuration disables enforcement.
Analytics events and success metrics: no new events; success is `/health` 200 and the API worker group staying up.
Logs, metrics, dashboards, and alerts: `worker.disabled` with `reason=billing_not_configured`; existing worker logs.
User, API, internal, and operational documentation: this record.
Validation evidence: Growth API full suite 113/113, including billing guards and process modes; Growth API typecheck.
Rollback or disable plan: redeploy the previous Growth API image or configure central billing and redeploy.
Post-release review date: 14 days after deployment.
```

### What changed

- `billing_usage_forwarder` no longer throws when central billing is not configured. It logs
  `worker.disabled` with `reason=billing_not_configured` and returns without aborting the other
  API workers.
- Billing guards (`requireCapability`, `resourceLimit`, `meterLimit`, `requireMeterAvailable`)
  become no-ops when central billing is not configured, matching the existing
  `billingEnforcementEnabled` behaviour already used by AI credits and public API metering.
- `recordMeterUsage` still writes to `BillingUsageOutbox`, but skips immediate forwarding when
  billing is not configured. Rows remain pending for the forwarder once billing is enabled.
- Billing summary and admin billing endpoints still return 503 while central billing is absent.

### Why

The production `growth-api` crash-looped because `billing_usage_forwarder` required billing
configuration the service did not have. The worker failure aborted the API worker group and
terminated the process, so `/health` returned 502. This change prevents an optional integration
from taking down the API.

### Impact and limits

- Until central billing is deployed and `BILLING_*` is configured, Growth feature and limit
  enforcement is skipped. This is intended for the hotfix window only.
- AI credit admission already skipped enforcement when billing was absent; this change makes the
  other guards consistent.
- Usage rows accumulate in `BillingUsageOutbox` and must be forwarded after billing is configured.
- The billing page and billing summary endpoints remain unavailable.

### Validation

- Growth API test suite: 113/113 passed, including the no-billing billing guard path and the
  process-mode test.
- Growth API typecheck passed.
- Local API started on port 4010 with `BILLING_*` empty: `/health` returned 200, the process
  stayed up, and the log showed `worker.disabled` with `reason=billing_not_configured`.
- Local API with `BILLING_*` configured logs `worker.started` for
  `billing_usage_forwarder`.
- With `BILLING_*` configured, confirm the forwarder forwards pending rows.

### Rollout

1. Build the Growth API image from the hotfix commit.
2. Deploy it to the production `growth-api` service.
3. Verify `https://api.kasitek.co.za/health` returns 200.
4. Verify the process stays up for at least one worker interval and logs `worker.disabled`, not
   `worker.failed`.
5. Verify Growth web loads and a WhatsApp connection can be created and linked.

### Rollback

- Redeploy the previous Growth API image. Billing remains unavailable and the crash loop returns.
- If central billing is configured first, remove this hotfix only after the forwarder starts
  successfully with billing enabled.

### Follow-up

- Deploy the central billing service to production and set `BILLING_SERVICE_URL`,
  `BILLING_SERVICE_SECRET` and `BILLING_SNAPSHOT_SECRET`.
- Confirm `BillingUsageOutbox` drains and billing enforcement resumes.
- Connect a WhatsApp number in the production KasiTek organization and link it to the production
  Growth assistant.
