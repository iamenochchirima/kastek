# Conversation ordering and admission plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Make the one-active-run-per-conversation rule a database-backed invariant and document how
backpressure, retries, cancellation, redelivery, and message sequencing behave across API replicas,
channel workers, and Temporal workers.

## Scope

- Database-enforced admission for conversation-bound runs.
- Transactional sequence allocation for inbound and outbound messages.
- Stable idempotency behavior for platform retries and channel redelivery.
- Admission, busy, retry, and redelivery telemetry.
- Recovery and operator guidance for queued or stale runs.

## Non-goals

- Replacing Temporal with a process-local lock.
- Allowing concurrent model runs to mutate one conversation.
- Introducing a separate message queue before its acknowledgement and promotion contract is defined.

## Implementation checklist

- [x] Add a partial unique index for non-terminal conversation runs.
- [x] Keep row locks and idempotency checks at every conversation-bound admission path.
- [x] Preserve sequence allocation under the conversation row lock.
- [x] Specify backpressure and channel redelivery behavior.
- [x] Add migration and integration coverage for concurrent admission and duplicate delivery.
- [x] Add bounded admission telemetry and update recovery guidance.
- [ ] Add worker-death and cancellation recovery tests across every non-terminal state.
- [ ] Decide whether a durable queued-message table is needed after measuring channel retry behavior.

## Release record

Change: Database-backed one-active-run admission and explicit conversation ordering behavior.

Owner: Agent Platform.

Risk: standard. The migration rejects legacy duplicate active runs rather than silently choosing a
winner; the application keeps the existing `conversation_busy` backpressure response.

Affected services and user surfaces: agents-api, agents-worker, Agents PostgreSQL, platform chat,
channel ingestion, handoff continuation, retry endpoints, and operator recovery views.

Platform release version or release ID: pending commit and deployment verification.

API/schema/migration changes: additive migration 088 adds a partial unique index on active
conversation-bound runs. Existing API response contracts remain unchanged.

Feature flag or rollout method: not applicable; the invariant is fail-closed at the database
boundary. Rollout requires checking for duplicate active rows before the index is created.

Analytics events and success metrics: bounded conversation admission outcomes, busy backpressure,
retry, and channel redelivery counts. No message bodies or provider credentials are recorded.

Logs, metrics, dashboards, and alerts: admission outcome metrics, existing queued-run age and stale
queue operator projections, and the Temporal recovery runbook. A durable stale-work alert remains
an open follow-up.

User, API, internal, and operational documentation: update the agent platform audit, conversation
ordering architecture note, and Temporal recovery runbook.

Validation evidence: pending migration, full suite, production migration, and deployment smoke
verification.

Rollback or disable plan: deploy the previous application artifact while retaining migration 088;
the index is additive and prevents unsafe duplicate admissions. Removing it requires a reviewed
duplicate-row audit and is not part of routine rollback.

Post-release review date: 2026-09-07 for busy responses, provider redelivery, queue age, and any
customer reports of out-of-order replies.
