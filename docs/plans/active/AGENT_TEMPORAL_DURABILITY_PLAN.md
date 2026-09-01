# Agent Temporal durability plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Reduce duplicate provider work and make worker-loss recovery explicit while the existing
`executeLoop` activity is being decomposed into smaller Temporal activities.

## Implementation checklist

- [x] Inventory current activities, timeout policy, retry policy, and the remaining large
  `executeLoop` boundary.
- [x] Add a durable, operation-keyed model-call outcome ledger with completed-response replay and
  fail-closed handling for unknown outcomes (migration 084).
- [x] Persist model responses before budget and Core-credit settlement so a worker retry can replay
  a completed provider operation.
- [x] Mark stale model reservations unknown, expose bounded reconciliation diagnostics, and resolve
  them only through the dual-controlled operator command.
- [x] Add activity-attempt, budget-exhaustion, and reconciliation metrics plus the Temporal recovery
  runbook.
- [x] Add runtime and database-backed tests for replay, unknown operations, migration shape, and
  reconciliation projections.
- [x] Add workflow graph recovery contracts for crash-after-checkpoint replay and branch failure
  ([workflow-graph-recovery.test.ts](../../../agents/test/workflow-graph-recovery.test.ts)).
- [ ] Add worker-kill tests around every model, tool, approval, effect, and completion checkpoint.
- [ ] Split context, model, tool, checkpoint, and completion work into independently retry-safe
  activities behind a controlled rollout.
- [ ] Compare provider billing with reserved, captured, released, and reconciled usage during
  staged rollout.

## Release record

Change: Durable model-operation outcomes, budget reconciliation diagnostics, and Temporal recovery
signals.

Affected services: agents-api, agents-worker, Agents PostgreSQL, model gateway, and Kasitek Core
credit settlement.

API/schema changes: additive migration 084 adds `model_calls.operation_key`, `model_calls.response`,
and supporting indexes. The operations summary and reconciliation projections expose metadata only;
provider response content is not returned by operator or customer diagnostics.

Analytics, logs, and metrics: `model.reconciliation.required`, activity-attempt metrics, budget
exhaustion metrics, and reconciliation-required metrics are emitted without prompt or response
content.

Documentation: `docs/internal/architecture/agent-workflow-execution.md` and
`docs/internal/runbooks/agent-temporal-recovery.md`.

Validation: targeted runtime, HTTP, migration, and database integration tests pass locally. Full
suite, agents build, client type-check, production migration, and deployment evidence are pending
for this active tranche.

Rollout and rollback: deploy the additive migration before the application release. The previous
application artifact can be rolled back while retaining migration 084 and unresolved operation
rows. Do not drop the new columns or indexes until every affected operation is resolved and a later
migration explicitly retires the ledger.
