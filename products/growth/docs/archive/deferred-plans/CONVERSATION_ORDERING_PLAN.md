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

Platform release version or release ID: `c2b126d8` (agents-api, agents-worker, and MCP-Gateway).

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

Validation evidence: agents full non-DB suite `85 passed, 18 skipped`, `531 passed, 52 skipped`;
agents typecheck and build passed; migration tests passed (`23/23`); local migration 088 applied;
platform-chat integration passed (`11/11`) including concurrent admission and channel redelivery;
production migration 088 applied through the agents-db tunnel and recorded in `schema_migrations`.
Deployments `ff03df19-2e8a-4923-9a4b-f46b673c799d` (agents-worker),
`00dcdcc4-faa6-424a-ad1d-e0bd70be89e8` (agents-api), and
`e5052169-3b8b-4abf-ae5e-b35119f6639a` (MCP-Gateway) succeeded. Agents-api live/readiness and
MCP-Gateway health/readiness smoke checks returned 200.

Rollback or disable plan: deploy the previous application artifact while retaining migration 088;
the index is additive and prevents unsafe duplicate admissions. Removing it requires a reviewed
duplicate-row audit and is not part of routine rollback.

Post-release review date: 2026-09-07 for busy responses, provider redelivery, queue age, and any
customer reports of out-of-order replies.
