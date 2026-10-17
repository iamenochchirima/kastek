---
title: Credit billing coverage
owner: product-and-engineering
last_reviewed: 2026-09-10
---

# Credit billing coverage

This document records the source audit of credit charging and the gap between that implementation
and the intended product-wide credit model. Its behavior conclusions date from 2026-09-10; the
links below point to the local TypeScript counterparts, but this is not a post-migration parity
audit, pricing approval, or claim that the TypeScript service has been deployed.

## Agents reset impact

The 2026-09-10 findings below describe the retired Agents implementation. The platform reset
removed its Temporal worker and Growth credit calls. The new Agents product owns bounded
execution reservations and usage accounting independently of Growth; commercial integration
remains separate work. See the [current Agents implementation](../../../../agents/docs/source-boundary.md).
Growth still owns its existing credit ledger operations in
[`credits.ts`](../../../api/src/services/credits.ts). Their presence alone does not establish
active customer-usage charging.

## Historical charging audit, 2026-09-10

| Functionality | What the code does today | Credit status |
| --- | --- | --- |
| Agents model calls using KasiTek funding | Reserves before the provider call and captures actual input/output usage after a successful response. Pricing uses provider, model, and a versioned internal conversion scale. | **Charged** when billing mode is `enforced`. |
| Agents model calls using BYOK | Preserves `fundingSource = user` and skips the KasiTek credit reservation. | **Not charged by design.** |
| Agent read tools | No direct credit reservation or capture. | **Not charged.** |
| Agent outbound tool effects | The tool itself does not use the credit ledger. A downstream action may use a separate meter or provider-specific policy. | **No general credit charge.** |
| Core social ideas and captions | Core calls OpenRouter directly from [`ai.ts`](../../../api/src/services/ai.ts). No credit reserve, capture, or provider-usage settlement is present in that path. | **Not charged. This is an implementation gap.** |
| Website chat | The intended plan says to charge AI response usage through the Agent boundary, but the credit implementation checklist still marks website-chat enforcement incomplete. | **Not confirmed as a complete credit contract.** Platform-funded model calls may be charged after reaching the worker; anonymous and end-to-end behavior need explicit tests. |
| WhatsApp campaign recipients | Checks and records the monthly `campaign_recipients` meter around accepted sends. | **Not charged as credits.** Uses a separate monthly meter. |
| Social publishing | Records the monthly `social_publishes` meter after successful publication. | **Not charged as credits.** |
| Public API requests | Records `public_api_requests` usage events. | **Not charged as credits.** Reads and effects still need separate classification. |
| Audio transcription | Runs through the Agent Platform, but no credit reservation or capture was found. The architecture document lists credit treatment as a release gate. | **Not charged; policy is open.** |
| Embeddings and memory-provider work | Provider calls exist in the Agent Platform, but no credit reservation or capture boundary was found. | **Not charged; pricing policy is missing.** |
| Voice, SMS, email, and media processing | The credit plan describes these as future action-specific pricing areas. | **No current credit settlement found.** |
| Settings, connections, team management, reads, drafts, calendar, and analytics views | Access or ordinary product operations; no credit debit. | **Free by the current design.** |
| Plan, trial, referral, and promotional credits | These create or revoke grants. They are balance changes, not usage charges. | **Grant/adjustment, not consumption.** |

The source code also contains an `agent_deployments` meter definition, but this audit did not find a
current writer for that meter. It should be verified before it is presented as an active charge or
limit.

## Credit ledger versus monthly meters

These are separate systems and should not be described as if they were the same charge:

| System | Purpose | Examples from the historical audit |
| --- | --- | --- |
| Credit ledger | Variable usage balance with reservations, captures, releases, grant lots, and debits. | Agents platform-funded model calls. |
| Monthly usage meter | Plan or feature limit enforced with `require_meter_available` and recorded with `record_meter_usage`. It writes `UsageEvent`; it does not debit the credit ledger. | Campaign recipients and social publishes. |
| Capability or entitlement | Answers whether a feature is available. | Campaign access, content publishing, bookings, and other feature permissions. |

The [workspace access and billing document](../access-control.md) documents capabilities and
meters, but does not provide a credit-debit matrix. A meter event is not evidence that credits were
consumed.

## What documentation exists

The main existing document is `docs/archive/deferred-plans/CREDITS_IMPLEMENTATION_PLAN.md`. It
contains the intended feature metering matrix and says that Core, the Agent Platform, campaign
workers, website chat, public API, and white-label runtime should use one central credit authority.
It also explicitly says that ordinary reads, drafts, settings, and navigation should not be
charged.

That plan is not yet a current-state contract:

- It is stored under `archive/deferred-plans` while declaring itself active and canonical.
- Core content-AI metering, website-chat enforcement, WhatsApp reservation and settlement, public
  API action-level charging, voice, and media pricing remain unchecked.
- Pricing action keys, units, provider-cost rules, versioning, failure behavior, and reconciliation
  are still open or incomplete.
- The plan still describes AI billing rollout as `disabled`, then `shadow`, then `enforced`, while
  the retired Agents worker defaulted to `enforced`. That worker has since been removed.

The retired Agents recovery notes no longer describe the platform. The
[audio transcription architecture](./audio-transcription.md) also requires review before
reconnecting Growth to the replacement execution service.

## Intended target policy already present in the plan

The existing plan provides a reasonable starting boundary:

- Charge variable provider/resource usage or an external side effect.
- Keep workspace configuration, reads, drafts, analytics viewing, and ordinary management free.
- Charge AI by actual provider usage where KasiTek funds the provider call.
- Charge messaging by an accepted outbound provider action where the product policy requires it.
- Keep rate limits and feature access separate from credits.
- Use one central Core credit service for direct product, Agent Platform, website chat, public API
  effects, and white-label usage.

If the new product decision is to charge “almost every functionality,” that is broader than the
current agreed direction. It requires an explicit action catalogue, prices, units, and customer
communication before enforcement. It should not be inferred from the existing monthly meters.

## Implementation gaps to close

1. Establish one versioned action catalogue, including unit, rounding, provider-cost basis, margin,
   minimum charge, and settlement point for every billable action.
2. Route Core social ideas and captions through a credit-aware provider boundary, or add an
   equivalent reserve/capture path that records provider usage and idempotency keys.
3. Decide and implement website-chat charging, including anonymous traffic, insufficient balance,
   retries, fallbacks, and provider-unknown outcomes.
4. Decide whether campaign recipients and social publishing remain monthly meters or migrate to
   credits. Do not run both systems for the same operation without an explicit migration rule.
5. Define policies for audio transcription, embeddings, voice, SMS, email, media processing, and
   outbound inbox actions.
6. Add end-to-end tests that prove every billable action has a reserve/capture/release or an
   intentionally documented non-credit meter path.
7. Add shadow-mode comparison and reconciliation before migrating existing meters to credits.

## Release record for this audit

| Field | Decision |
| --- | --- |
| Change | Add the current credit-billing coverage audit and source map. |
| Owner | Product and Engineering |
| Risk | Low; documentation only. |
| Affected services and user surfaces | Billing documentation, Core credit ledger, Agents worker, product billing decisions. No runtime behavior changed by this document. |
| Platform release version or release ID | Not applicable. |
| API/schema/migration changes | Not applicable. |
| Feature flag or rollout method | Not applicable. |
| Analytics, logs, metrics, dashboards, and alerts | Not applicable for this documentation audit. Required when individual billing gaps are implemented. |
| Validation evidence | Source audit of credit call sites, meter call sites, existing implementation plan, and operational runbooks. |
| Rollback or disable plan | Revert the documentation change; runtime billing flags remain independently controlled. |
| Post-release review date | Review when the first product-wide billing action catalogue is approved. |
