# Channel-Native Agent Approvals

**Status:** Active
**Owner:** KasiTek agents platform
**Last updated:** 2026-08-22

## Objective

Make approval-gated agent actions usable from every supported conversation surface. A run that
pauses for approval must produce a clear prompt, expose safe Approve/Deny actions, resume the exact
paused run after a valid decision, and remain auditable and idempotent.

## Scope

### Included

- One shared approval-decision contract for dashboard and channel actions.
- Approval prompts for all hosted agents, not only KasiAi.
- WhatsApp reply-button prompts and inbound button handling.
- Telegram inline-keyboard prompts and callback-query handling.
- Dashboard compatibility with the same approval contract.
- Expiry, denial, duplicate clicks, stale actions, and delivery failures.
- A channel adapter boundary that can later support Discord and other providers.

### Excluded for this pass

- Discord provider implementation.
- Letting arbitrary customer messages approve consequential actions.
- Changing which tools require approval.
- Replacing the existing Temporal run state machine.

## Security decisions

- Approval decisions are bound to the organization, installation, run, approval record, argument
  hash, channel binding, and approver identity.
- Channel actions use short-lived, single-use signed tokens; raw approval IDs are not sufficient.
- Customer-service conversations do not grant approval authority to the customer by default.
- Personal paired KasiAi channels may be enabled as an owner approval surface after the shared
  path is complete.
- Every decision continues through the existing policy re-check, audit record, and Temporal signal.

## Checklist

### Foundation

- [x] Define the canonical approval prompt/action payload and compact, expiry-aware token claims.
- [x] Extract approval validation, persistence, audit, and Temporal signalling into a reusable
      service used by the dashboard and channels.
- [ ] Add approval prompt delivery state and idempotency so a run creates at most one active prompt
      per channel/binding.
- [x] Emit channel prompt delivered/skipped/failed events; existing approval lifecycle events remain
      the source for decision, resume, denial, and expiry transitions.

### Shared agent behavior

- [x] Ensure every approval-gated tool and workflow approval node reaches the same prompt path.
- [x] Keep the immutable resource preview and argument hash attached to the durable approval record.
- [x] Resume only the original run; never create a second run for a button click.
- [x] Return a safe approval result to the originating conversation; dashboard fallback remains available.

### WhatsApp

- [x] Add interactive reply-button sending with Approve and Deny actions.
- [x] Parse `interactive.button_reply.id` in webhook input.
- [x] Authenticate the sender against the eligible channel binding before deciding.
- [ ] Add a safe text fallback for supported clients without treating plain “approve” as proof.
- [x] Preserve normal text and customer-message routing for non-approval input.

### Telegram

- [x] Add inline keyboard markup to approval messages.
- [x] Subscribe to and normalize `callback_query` updates.
- [x] Answer callback queries and route the callback data through the shared decision service.
- [x] Preserve normal message routing and pairing behavior.

### Verification

- [x] Unit-test token signing, compact claims, expiry, tampering, and approval-id mismatch.
- [x] Test shared approve/deny behavior through the dashboard path and channel decision boundary coverage.
- [x] Test WhatsApp interactive extraction and Telegram callback fixtures.
- [ ] Test duplicate clicks, stale hashes, expired approvals, denied approvals, and delivery retry.
- [ ] Run agents typecheck/lint/tests and the relevant core Rust checks.

### Later: Discord and other channels

- [ ] Implement the same prompt/action adapter using Discord components/interactions.
- [ ] Add provider-specific delivery and webhook fixtures without changing approval semantics.

## Current implementation evidence

- Durable approval state and expiry already exist in `agents/src/db/repositories/approval-repository.ts`.
- Temporal pauses and resumes runs through `agent.approval` in `agents/src/temporal/workflows.ts`.
- Dashboard approval currently calls `POST /v1/runs/:runId/approval`.
- WhatsApp and Telegram now have provider-native approval transport; Discord remains an adapter-only
  follow-up and customer-facing bindings intentionally cannot approve by default.

## Verification log

- `pnpm exec tsc -p tsconfig.json --noEmit` — passed.
- Targeted Agent tests — 106 passed, including HTTP/conformance, token, Telegram, and adapter suites.
- Full Agent suite — 362 passed, 42 integration tests skipped by the repository configuration.
- `cargo check -p kasitek-core` — passed.
- Focused core tests — WhatsApp webhook 5 passed; inbox delivery 2 passed.
- Focused rustfmt checks for changed core files — passed. Repository-wide formatting remains blocked
  by the pre-existing missing `kasitek-analytics/src/rollout.rs` module and unrelated baseline diffs.
