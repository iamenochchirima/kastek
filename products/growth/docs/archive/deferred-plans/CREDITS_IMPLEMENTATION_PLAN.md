---
title: KasiTek Credits Implementation Plan
slug: /architecture/credits-implementation-plan
sidebar_position: 7
---

# KasiTek Credits Implementation Plan

**Status:** Active

This root-level document is the canonical implementation checklist for the credit system.

**Owner:** Product and Engineering

**Last updated:** 2026-08-25

## Objective

Introduce one organization/workspace-level credit system that can measure and enforce
variable usage across KasiTek's direct product, agent platform, and white-label platform.

The system must support:

- monthly plan allowances;
- trial and referral awards;
- optional one-time credit purchases;
- AI usage based on actual model consumption;
- messaging, voice, media, campaign, and other billable operations;
- reservations for asynchronous or uncertain operations;
- refunds, expiry, reconciliation, and idempotent retries;
- clear usage reporting without presenting credits as withdrawable money.

Success means that every billable operation has one authoritative pricing and ledger path,
while ordinary configuration and read-only product use remains available without unnecessary
micro-charges.

## Scope

### Included

- `server/kasitek-core` billing, organization accounts, Paystack payment confirmation, and
  direct KasiTek product APIs;
- `server/kasitek-tenants` workspace usage and white-label usage reporting;
- `agents` model execution, model-cost recording, agent runs, and internal core integration;
- client billing, balance, usage history, low-balance, and blocked-action states;
- plan credit grants, referral grants, trial grants, purchased credit packs, and expiry rules;
- pricing rules, provider-cost capture, reservations, settlement, refunds, and reconciliation;
- migration from the existing monthly usage meters without double charging.

### Excluded from the first launch

- using credits to reduce or settle recurring Paystack subscription invoices;
- cash withdrawal, transfer, resale, or customer-to-customer credit transfers;
- charging every read, page view, draft, setting change, or navigation action;
- retroactively repricing historical usage;
- automatic top-up without an explicit product and payment decision;
- collapsing the direct and white-label identity or database boundaries.

## Current implementation baseline

- Direct billing is organization-scoped in
  [`client/packages/database/prisma/schema.prisma`](../../../client/packages/database/prisma/schema.prisma).
- `ProductPlan` and `PlanEntitlement` currently control plan access and limits.
- `UsageEvent` is append-only and idempotent, but it is not a debit/credit ledger and does not
  support reservations, grant expiry, settlement, or refunds.
- Current core meters are `agent_deployments`, `campaign_recipients`, `social_publishes`, and
  `public_api_requests` in
  [`server/kasitek-core/src/services/billing.rs`](../../../server/kasitek-core/src/services/billing.rs).
- WhatsApp campaigns currently check a recipient meter before launch and record usage after an
  accepted recipient send.
- Social publishing currently records a publish meter after successful publication.
- The agent platform already records provider, model, funding source, input tokens, output
  tokens, total tokens, and estimated provider cost through
  [`agents/src/model/types.ts`](../../../agents/src/model/types.ts) and its model-call analytics.
- The white-label backend currently reports monthly request, token, and conversation usage from
  `workspace_usage_events` and `workspace_usage_limits`.
- Subscription plan prices currently live directly on `ProductPlan`; multi-currency pricing will
  require a separate price-book decision before broadening payment support.

## Settled design direction

### Customer-facing model

- One visible credit balance per organization or white-label workspace.
- Credits are integer usage units, not currency and not redeemable for cash.
- Detailed usage is grouped by action category, such as AI, messaging, campaigns, voice, and
  media.
- Credits are consumed from the grant that expires soonest.
- Monthly included credits expire at the end of their period by default.
- Referral and trial grants have explicit expiry dates.
- Purchased credit expiry remains an open product decision.
- No silent overdraft. A billable operation is rejected before its external side effect when the
  organization cannot reserve enough credits.

### Billing boundary

Entitlements answer **whether a feature is available**. Credits answer **how much variable usage
is available**. They must not be merged into one opaque limit system.

The central credit authority belongs with the existing core billing boundary. The agent platform,
campaign workers, website chat, public API, and white-label runtime must use that authority rather
than maintaining independent balances.

### Billable-action rule

Charge only an operation that consumes a variable provider/resource cost, creates an external
effect, or has a clearly understood usage value. Keep workspace configuration, reads, drafts,
analytics viewing, and ordinary management actions free unless a later product decision says
otherwise.

## Feature metering matrix

This matrix is a starting point. The price and enforcement columns must be approved before each
feature is enabled for credit consumption.

| Feature family | Initial metering decision | Settlement point | Notes |
| --- | --- | --- | --- |
| Workspace, team, settings, connections | No credits | None | Controlled by access and role entitlements. |
| Inbox reads and conversation history | No credits | None | Inbound receipt is not itself a billable customer action. |
| AI social ideas and captions | AI model usage | Successful model response | Core `services/ai.rs` must return usage metadata before charging. |
| Agent model calls using KasiTek funding | Input/output tokens and model | Completed provider response | Use provider/model pricing version and an internal margin. |
| Agent model calls using BYOK | No provider-cost debit initially | None or platform-run fee if later approved | Preserve `fundingSource = user`; do not charge KasiTek provider cost twice. |
| Agent read tools | No credits initially | None | Tool effects may be billed separately. |
| Agent outbound tool effects | Action-specific | Accepted external effect | Use channel, provider, and destination pricing where required. |
| Website chat | AI response usage | Completed model response | Reserve before the agent-platform call; protect against anonymous abuse. |
| WhatsApp campaign recipients | Per accepted recipient/message | Provider accepts send | Release blocked and pre-send failures. Reconcile uncertain provider results. |
| WhatsApp, SMS, and email replies | Per accepted outbound message where applicable | Provider accepts send | Separate provider cost from platform credit price. |
| Social drafts, calendar, analytics reads | No credits | None | Do not charge ordinary content management. |
| Social publishing | Existing monthly meter first | Successful publication | Convert to fixed credits only after usage economics and customer value are validated. |
| Voice agents and calls | Per minute or provider unit | Completed/accepted call duration | Implement when the voice path is production-ready. |
| Bookings and booking administration | No credits | None | Reminder and notification delivery may consume messaging credits. |
| Public API reads | No credits initially | None | Keep rate limits separate from credits. |
| Expensive public API actions | Action-specific | Successful action | Reuse the same credit service as dashboard requests. |
| Media storage and transformations | Quota or processing-unit decision | Completed processing | Storage should not become a hidden per-request debit. |
| Analytics views | No credits | None | Expensive exports or generated reports may be priced later. |
| White-label client/workspace usage | Same credit contract, workspace-owned account | Action-specific | Preserve the separate tenant database and identity boundary. |

## Target data model checklist

### Schema and migration

- [x] Add a `CreditAccount` owned by an organization or white-label workspace.
- [x] Add grant lots for plan, trial, referral, purchase, manual, migration, and promotional
      sources.
- [x] Add immutable ledger entries for grants, debits, refunds, releases, expiry, and manual
      adjustments.
- [x] Add reservation storage with `RESERVED`, `CAPTURED`, `RELEASED`, and `EXPIRED` states.
- [ ] Add versioned action pricing rules.
- [x] Add billable usage records that preserve action, quantity, credits, provider data, and
      pricing version.
- [x] Add unique idempotency constraints for grant, reservation, settlement, webhook, and debit
      operations.
- [x] Add indexes for organization/workspace balance, active grants, expiry, ledger history, and
      reconciliation queries.
- [ ] Keep the current `UsageEvent` model during migration; define its compatibility relationship
      with the new credit usage records.
- [ ] Decide whether direct and white-label records share a physical schema or use separate
      implementations behind one contract.
- [ ] Add stable migration/backfill behavior for existing subscriptions and active trials.

### Accounting invariants

- [ ] Ledger entries are append-only; corrections use compensating entries.
- [ ] A debit cannot make an account negative unless an explicit, separately approved grace rule
      exists.
- [ ] A reservation cannot be captured or released twice.
- [ ] Retried requests and provider webhooks cannot duplicate a grant or debit.
- [ ] Expired grants cannot be consumed.
- [ ] Every debit identifies its action, source operation, pricing version, and organization.
- [ ] Cached balances can be rebuilt from the ledger and periodically reconciled.

## Credit service and API checklist

- [x] Define a central credit-service module in `kasitek-core`.
- [x] Implement `get_balance` and grant breakdown.
- [ ] Implement `quote(action, input)` without mutating state.
- [x] Implement `reserve(action, estimate, idempotency_key)`.
- [x] Implement `capture(reservation, actual_usage)`.
- [x] Implement `release(reservation, reason)`.
- [ ] Implement `refund(source_debit, reason)` through a compensating ledger entry.
- [x] Implement system grants for paid plans, trials, and referrals; purchased credits remain
      pending until credit-pack products exist.
- [x] Implement expiry processing and an auditable expiry reason at credit read, grant, and
      reservation boundaries.
- [x] Implement internal agent-platform endpoints for reservation and settlement.
- [ ] Ensure internal endpoints validate organization scope and service authentication.
- [ ] Return stable insufficient-credit errors containing required and available credits without
      exposing sensitive provider-cost details.
- [x] Add customer-facing balance and usage-history endpoints.
- [ ] Add admin endpoints for pricing rules, grant inspection, ledger inspection, and
      reconciliation.
- [ ] Add a dry-run quote endpoint for product UI and preflight confirmation.

## Admin credit-control checklist

Credit balances are owned by an organization or white-label workspace. An administrator may
search by user, but the operation must clearly identify the organization/workspace whose shared
balance is being changed. A user-level wallet should only be introduced as a separate product
decision.

### Supported admin operations

- [x] Search core organizations by name, ID, owner email, and balance.
- [x] View current balance, active grants, and recent ledger entries for a core organization.
- [ ] Add expired grants, reservations, refunds, and reconciliation views.
- [x] Manually grant a specific number of credits to one core organization.
- [ ] Manually grant credits to a selected group of organizations/workspaces.
- [ ] Grant credits to all organizations/workspaces only through an explicit filtered bulk
      operation with a preview and confirmation step.
- [x] Add a promotional, support, referral-correction, migration, or compensation grant with an
      explicit source and expiry date.
- [ ] Reset a current-period plan grant without deleting ledger history.
- [ ] Expire or revoke an unspent manual/promotional grant through a compensating ledger entry.
- [ ] Refund credits for a specific debit or failed provider operation.
- [x] Adjust a balance to a target amount only by calculating and recording the required grant or
      compensating debit; never overwrite the ledger or silently mutate the balance.
- [ ] Cancel or release stale reservations after an operational timeout.
- [ ] Preview the effect of an operation before applying it, including target count, total credits,
      expiry, and estimated balance changes.
- [ ] Export an auditable result for bulk operations with per-target success/failure status.

### Admin safety and authorization

- [ ] Define separate admin permissions for viewing, granting, refunding, expiring, resetting,
      and performing bulk operations.
- [x] Require a reason and optional support/finance reference for every core manual adjustment.
- [ ] Require a stronger confirmation or second approval above a configurable credit threshold.
- [ ] Require a custom application confirmation dialog for destructive or bulk operations; never
      use native browser confirmation dialogs.
- [x] Require an idempotency key for every core credit mutation.
- [ ] Add bounded batch sizes, rate limits, resumable execution, and retry-safe processing.
- [ ] Show an immutable preview before an all-user or cohort-wide grant is executed.
- [ ] Prevent administrators from granting credits to an unintended tenant or organization due to
      ambiguous search results.
- [ ] Enforce organization/workspace isolation in every admin query and mutation.
- [ ] Add step-up authentication for high-risk operations if the admin surface supports it.

### Audit and reconciliation

- [ ] Record the acting admin, target organization/workspace, operation type, amount, grant source,
      reason, reference, expiry, before/after balance, request ID, and result.
- [ ] Link every admin operation to the resulting ledger entry or compensating entries.
- [ ] Keep admin audit records immutable and separate from customer-visible usage history.
- [ ] Provide an admin history view with filters for actor, target, operation, date, amount, and
      status.
- [ ] Support rollback through a new compensating operation rather than editing history.
- [ ] Alert or queue review for unusually large grants, repeated resets, and broad bulk operations.
- [ ] Reconcile cached balances against ledger totals after bulk operations and on a scheduled
      basis.

## Pricing and unit-economics checklist

- [ ] Define stable action keys, for example `ai.model_call`, `reach.message`,
      `voice.minute`, and `content.publish`.
- [ ] Define the unit and rounding rule for every action.
- [ ] Define the internal provider-cost basis and margin policy.
- [ ] Store provider/model/channel pricing outside feature handlers.
- [ ] Version every pricing change and record the version on every debit.
- [ ] Decide whether AI prices use actual provider cost, a fixed action price, or a hybrid model.
- [ ] Define model fallback charging: charge each actual successful model call, not an abstract
      run total that hides fallback consumption.
- [ ] Define provider failure, timeout, retry, and unknown-result charging rules.
- [ ] Define destination/category rules for messaging providers where costs vary.
- [ ] Define minimum and maximum credit charges for token and duration calculations.
- [ ] Produce a cost simulation using representative AI, messaging, campaign, voice, and media
      workloads before publishing plan quantities.
- [ ] Approve initial plan credit grants and top-up pack sizes.
- [ ] Approve whether purchased credits expire and whether rollover exists.

## Feature integration checklist

### Core and direct product

- [ ] Replace direct debit decisions in feature handlers with calls to the central credit service.
- [ ] Update WhatsApp campaign launch to reserve the full batch or a bounded batch before send.
- [ ] Settle campaign credits from provider-accepted recipient outcomes.
- [ ] Add compensation for uncertain provider outcomes and webhook reconciliation.
- [ ] Instrument social AI generation with token usage and idempotency.
- [ ] Decide whether successful social publishing remains a plan meter or becomes a credit action.
- [ ] Apply credits to website chat AI responses through the internal agent boundary.
- [ ] Apply credits to outbound inbox/agent messages only where the selected policy requires it.
- [ ] Keep booking administration free; meter reminders and external notifications by channel.
- [ ] Add action-level charging to public API endpoints only after classifying reads and effects.

### Agent platform

- [x] Add a credit reservation before each KasiTek-funded model call or approved run-level
      reservation strategy.
- [x] Capture actual input/output tokens, model, provider, funding source, and pricing version.
- [x] Settle after successful model responses, including multiple loop iterations and fallbacks.
- [x] Release unused reservations when token limits are not reached.
- [ ] Release or refund failed calls according to the failure policy.
- [x] Do not charge provider cost for BYOK calls.
- [ ] Add platform execution charging only if the separate BYOK policy is approved.
- [ ] Attach agent run, model-call, tool, and correlation identifiers to billable records.
- [ ] Ensure Temporal retries and replayed activities remain idempotent.

### White-label platform

- [ ] Define whether a tenant workspace receives credits directly or inherits an agency-level
      allocation.
- [ ] Map `workspace_usage_events` to the shared action and usage contract.
- [ ] Preserve tenant staff/client authorization rules for balances and usage history.
- [ ] Add workspace-level reservation and settlement access without exposing other workspaces.
- [ ] Decide whether tenant admins can allocate sub-budgets to client accounts.

## Plans, referrals, and payments checklist

- [x] Add plan credit grants that activate with a verified subscription/trial period.
- [x] Grant period credits on verified activation/renewal and make renewal idempotent.
- [x] Add referral grant source and referral qualification state.
- [x] Prevent self-referrals, duplicate rewards, and rewards for unqualified accounts.
- [ ] Add expiry and reversal behavior for refunds, chargebacks, cancelled referrals, and abuse.
- [ ] Add one-time credit-pack products independently from recurring subscription plans.
- [ ] Create purchased credits only after verified Paystack webhook/transaction confirmation.
- [ ] Make payment return pages informational; never treat browser return as payment proof.
- [ ] Keep subscription plan currency/pricing separate from currency-neutral credits.
- [x] Record recurring Paystack charges as idempotent invoices with provider identifiers and
      subscription-period boundaries, and retry failed webhook processing.
- [ ] Apply credits to reduce recurring invoice monetary balances; this remains deferred until
      invoice balance/application and provider reconciliation rules are approved.

### Recommended trial and top-up policy

- [x] Create a separate `TRIAL` credit grant with a fixed configured amount and an expiry equal
      to the configured trial end date.
- [ ] Size trial credits to cover the intended evaluation journey, not unlimited platform usage.
- [ ] Do not allow trial users to buy top-ups initially; when trial credits are exhausted, block
      billable actions and present upgrade options.
- [ ] Keep read-only access, existing data, configuration, and billing access available after trial
      credit exhaustion where the product policy allows it.
- [x] Activate the selected paid plan's configured credit grant only after subscription/payment
      verification succeeds.
- [x] Treat a paid "month" as the subscription billing period, not the calendar month.
- [ ] If a user upgrades during the trial, preserve remaining trial credits only until the
      original trial expiry; do not convert them into cash or extend their expiry.
- [ ] When paid-plan credits run out before the billing period ends, offer an optional one-time
      top-up pack rather than silently charging the recurring subscription.
- [ ] Keep purchased top-up credits in a separate grant lot and consume expiring included credits
      before them.
- [ ] Block billable actions again when both included and purchased credits are exhausted.
- [ ] Do not enable automatic top-up in the first release unless separately approved and explicitly
      consented to by the customer.
- [ ] Define refund, chargeback, cancellation, and subscription-failure behavior for unused
      purchased and included credits.

## Client experience checklist

- [x] Show the organization/workspace credit balance in billing and relevant product surfaces.
- [x] Show included, referral, trial, and purchased grant breakdowns.
- [x] Show credits used by category and recent billable operations.
- [x] Show expiry dates for expiring grants.
- [ ] Show a quote before a high-cost or large-batch operation where practical.
- [ ] Show low-balance thresholds and a clear action to upgrade or buy credits if enabled.
- [ ] Show insufficient-credit errors inline, with required and available credit counts.
- [ ] Keep UI copy focused on credits and usage, not cash value.
- [ ] Make mobile billing, usage tables, dialogs, and blocked states responsive.
- [ ] Use application dialogs/toasts for purchase, grant, refund, and adjustment feedback; do not
      use native browser dialogs.

## Customer upgrade page checklist

The upgrade page is the customer-facing entry point for choosing a paid plan. It must use the
server catalog and the existing Paystack checkout path; plan prices and credit allowances must
never be hardcoded in the client.

- [x] Add an authenticated `/upgrade` route.
- [x] Load all active plans from `/api/billing/plans` and show price, interval, checkout state,
      and credits per billing period.
- [x] Show the current subscription context and clearly identify the available upgrade action.
- [x] Reuse the existing idempotent Paystack checkout flow for every checkout button.
- [x] Link locked feature navigation and billing upgrade actions to `/upgrade`.
- [x] Keep the page responsive at desktop, tablet, and mobile widths.
- [x] Add route, catalog, TypeScript, lint, and production-build verification.
- [x] Complete an authenticated local upgrade-page walkthrough with a disposable catalog plan.
- [x] Verify checkout failure handling when the billing provider is unavailable.
- [x] Verify forged-signature rejection, signed failed-payment handling, subscription transition to
      `PAST_DUE`, and duplicate webhook delivery in a local Paystack-mode process.
- [ ] Complete a real Paystack test-mode checkout and provider webhook walkthrough with a merchant
      test secret, real test plan code, and a reachable webhook URL before enabling public upgrades.

## Rollout phases

### Phase 0 — Product and economics decision

- [ ] Approve the billable-action matrix.
- [ ] Approve credit expiry, rollover, BYOK, referral, and top-up policies.
- [ ] Measure representative provider costs and model usage.
- [ ] Approve initial action prices and plan credit grants.
- [ ] Define customer-support and refund rules.

### Phase 1 — Ledger foundation

- [x] Add schema and migrations.
- [x] Implement ledger, grant, reservation, and settlement primitives.
- [x] Implement grant expiry processing; full ledger rebuild and scheduled reconciliation remain
      pending.
- [x] Add initial unit tests for credit validation; database transaction tests remain pending.
- [ ] Add admin inspection and repair tooling.
- [ ] Add admin credit operations, bulk-operation previews, audit history, and reconciliation
      workflows.
- [x] Add read-only balance and usage APIs.

### Phase 2 — AI metering

- [ ] Add usage capture to core content AI.
- [x] Add agent-platform reservation and settlement.
- [ ] Add model pricing catalogue and versioning.
- [ ] Add website chat enforcement.
- [ ] Validate retries, fallbacks, BYOK, anonymous traffic, and insufficient balance behavior.

### Phase 3 — Messaging and external effects

- [ ] Add WhatsApp campaign reservation and settlement.
- [ ] Add outbound message policy for inbox, agents, email, and SMS.
- [ ] Add provider webhook reconciliation and compensation.
- [ ] Add voice and media pricing when those features are production-ready.

### Phase 4 — Plans, referrals, top-ups, and client UX

- [x] Add monthly plan grants.
- [x] Add fixed, expiring trial grants and issue them at organization creation.
- [x] Add referral attribution and two-sided awards after verified paid activation.
- [ ] Add one-time credit packs and paid-period exhaustion top-up flow if approved.
- [x] Add balance, breakdown, history, and expiry UI; low-balance and purchase UI remain pending.
- [ ] Add multi-currency plan/pack price-book support where the payment provider supports it.

### Phase 5 — Migration and optimization

- [ ] Run the credit system in shadow mode against existing meters.
- [ ] Compare expected debits with current usage events.
- [ ] Migrate feature-by-feature without double charging.
- [ ] Keep compatibility reporting for historical monthly meters.
- [ ] Enable enforcement gradually by organization/workspace cohort.
- [ ] Review pricing and margin using real usage data.

## Verification checklist

- [ ] Fresh database migration succeeds.
- [ ] Existing subscription, entitlement, checkout, and invoice flows remain functional.
- [ ] Duplicate requests do not duplicate reservations, captures, grants, or refunds.
- [ ] Concurrent reservations cannot overspend an account.
- [ ] Provider retries and webhook replays remain idempotent.
- [ ] Failed, timed-out, blocked, and unknown external operations follow the approved policy.
- [ ] Token rounding and model pricing calculations are deterministic.
- [ ] Historical debits retain their original pricing version.
- [ ] Organization and white-label workspace isolation is tested.
- [ ] Agent-platform Temporal retries do not double charge.
- [ ] Balances reconcile from ledger entries.
- [ ] Referral abuse and chargeback reversal paths are tested.
- [ ] Core Rust tests pass.
- [ ] Agent TypeScript tests pass.
- [ ] Client type checks and relevant builds pass.
- [ ] Critical dashboard, campaign, AI, website chat, and payment flows receive targeted runtime
      checks.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Customer unit | One universal organization/workspace credit balance with typed action keys underneath | Product/Engineering | Agreed direction |
| Monetary meaning | Credits are not cash and do not have withdrawal value | Product | Agreed direction |
| AI conversion | KasiTek-funded model usage converts configured provider cost to credits using a versioned internal scale; the scale is not shown as cash value | Product/Engineering | Initial implementation |
| AI billing rollout | `disabled` by default, then `shadow`, then `enforced` after pricing and reconciliation checks | Product/Engineering | Initial implementation |
| Trial credits | Fixed `TRIAL` grant sized for evaluation and expiring at trial end | Product | Agreed direction |
| Trial exhaustion | Block billable actions and require upgrade; do not offer trial top-ups initially | Product | Agreed direction |
| Upgrade during trial | Preserve remaining trial credits only until the original expiry; add paid-period grant after verified activation | Product | Agreed direction |
| Paid exhaustion | Offer optional one-time top-up packs before the billing period ends | Product/Finance | Agreed direction |
| Automatic top-up | Disabled initially; require explicit later approval and consent | Product/Finance | Agreed direction |
| Monthly rollover | Monthly plan credits expire at period end by default | Product | Agreed direction |
| Purchased credit expiry | Use a 12-month expiry for initial top-up grants | Product | Agreed direction |
| BYOK | No provider-cost debit; use plan/run limits initially and revisit platform execution fees later | Product/Engineering | Agreed direction |
| Social publishing | Keep existing monthly meter initially; later evaluate fixed credits | Product | Proposed |
| Recurring invoice credits | Defer until recurring invoice application and reconciliation are complete | Product/Engineering | Agreed direction |
| Referral qualification | Attribute once per referred workspace; qualify only on verified paid activation; award referrer and referee with idempotent expiring grants | Product/Engineering | Initial implementation |
| Plan credit allowance | Store a currency-neutral `creditsPerPeriod` on each plan; recurring grants follow the provider subscription period | Product/Engineering | Initial implementation |
| White-label ownership | One wallet per billable organization/workspace; agency allocations can follow later | Product/Engineering | Agreed direction |
| Credit grant quantities | Trial target is 10–20% of the entry plan; exact quantities require cost simulation | Product/Finance | In progress |
| Action prices | Fixed, provider-cost-based, or hybrid per feature? | Product/Finance | Open |
| Payment providers | Which currencies and providers should be supported for packs and plans? | Product/Finance | Open |
| Top-up pack sizes | Start with packs around 25%, 100%, and 300% of the plan allowance | Product/Finance | Agreed direction |
| Grace policy | Hard stop at zero or approved bounded grace for selected operations? | Product/Engineering | Open |

## Progress log

| Date | Update |
| --- | --- |
| 2026-08-24 | Created the initial implementation plan from the current core billing, agent-platform, and white-label usage boundaries. |
| 2026-08-24 | Added administrator credit controls for individual targets, filtered and bulk grants, resets, refunds, expiry, audit, approvals, and reconciliation. |
| 2026-08-24 | Added the proposed fixed trial grant, trial exhaustion, paid-period grant, and optional top-up policy. |
| 2026-08-25 | Approved the initial commercial defaults: 14-day trial, no trial top-ups, paid-period grants, no self-serve rollover, manual top-ups, no automatic top-up, 12-month top-up expiry, and organization/workspace wallets. |
| 2026-08-25 | Implemented the first core credit foundation: PostgreSQL/Prisma ledger schema, idempotent admin grants and target-balance adjustments, organization search, and admin billing controls. |
| 2026-08-25 | Added reserved-balance accounting and idempotent reservation, capture, and release primitives with insufficient-balance and settlement unit tests. Database-backed concurrency tests and feature integrations remain pending. |
| 2026-08-25 | Exposed the reservation lifecycle through the authenticated, organization-scoped agent-platform boundary and added typed client methods plus request-contract tests. |
| 2026-08-25 | Added configuration-driven AI credit pricing, BYOK exclusion, per-model-call reservation/capture/release across loop iterations, fallbacks, and workflows, plus token/provider usage records and client/runtime tests. Charging remains disabled until rollout configuration is enabled. |
| 2026-08-25 | Added configurable trial grants at organization creation, per-plan paid-period allowances with idempotent Paystack renewal grants, expiring-lot processing, referral-code attribution, and two-sided referral rewards after verified paid activation. |
| 2026-08-25 | Added the customer billing credit endpoint and billing/settings UI for available, reserved, and total balance, grant expiry, recent usage, per-plan credit allowances, and copyable referral codes. |
| 2026-08-25 | Hardened Paystack processing: failed webhook events can be reclaimed, completed checkouts retry missing credit/referral finalization, and recurring charges create idempotent period-bound invoices before granting plan credits. |
| 2026-08-25 | Implemented the authenticated `/upgrade` route with server-catalog plan cards, current-plan context, responsive layout, Paystack checkout reuse, billing links, and locked-feature redirects. Targeted client checks pass; live Paystack checkout and failure-state verification remain before public enablement. |
| 2026-08-25 | Recovered the local Prisma migration state, deployed the credit and recurring-billing migrations, verified the upgrade page and provider-unavailable checkout path, and exercised forged-signature, failed-payment, and duplicate-webhook handling with an isolated local Paystack-mode secret. A real Paystack merchant test key and plan code are still required for provider checkout sign-off. |
| 2026-08-25 | Configured the server-only Paystack test mode in the ignored local environment, restarted core, confirmed the test key against Paystack, and verified the public webhook endpoint rejects unsigned requests. Paystack test plan creation and one real checkout remain. |

## Working rules

- Update this document when a product or technical decision is settled.
- Mark a checklist item complete only after implementation and its required verification exist.
- Record scope changes in the relevant phase instead of silently expanding feature handlers.
- Keep pricing changes versioned and preserve historical billing evidence.
- Link implementation PRs, migrations, tests, and operational runbooks from the relevant checklist
  item as work begins.
