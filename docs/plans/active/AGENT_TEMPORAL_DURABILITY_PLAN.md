# Agent Temporal durability plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-09-01

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
- [x] Propagate Temporal activity cancellation into configured graph execution and add pre-node and
  post-provider-result contracts ([executor.ts](../../../agents/src/workflows/executor.ts),
  [workflow-graph-cancellation.test.ts](../../../agents/test/workflow-graph-cancellation.test.ts)).
- [x] Add graph-boundary worker-loss contracts for model, tool, approval, external-event, and
  terminal checkpoints ([workflow-graph-worker-recovery.test.ts](../../../agents/test/workflow-graph-worker-recovery.test.ts));
  activity-level worker-kill coverage remains open.
- [x] Route configured `agent_loop` nodes through the hosted bounded loop with scoped durable
  operation keys, shared capability/approval/effect hooks, residual graph limits, and pause/resume
  checkpoint mapping ([activities.ts](../../../agents/src/temporal/activities.ts),
  [workflow-graph-agent-loop.test.ts](../../../agents/test/workflow-graph-agent-loop.test.ts)).
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

## Follow-up release record: graph cancellation propagation

Change: Pass the Temporal activity abort signal into configured workflow graph execution. Reject
late model/tool results after cancellation, prevent a cancelled node from mutating graph state, and
prevent execution from advancing to a following node.

Owner: Agent Platform.

Risk: standard.

Affected services and user surfaces: agents-api, agents-worker, configured workflow runs, and
workflow cancellation/recovery behavior. MCP-Gateway has no code-path change but was deployed with
the exact shared release commit.

Platform release version or release ID: commit `ac81bc97`; Railway production deployments
`agents-worker` `eb435b96-957b-40da-8280-dff175fe4d58`, `agents-api`
`ce3f9028-fe62-48f1-8c2c-546a1841c5dd`, and `MCP-Gateway`
`c404bdb3-7564-48d7-9c1f-bc8ffe7f27bc`; all reported `SUCCESS` for commit
`ac81bc97d3db3ea196dbc5964a276b9ff97d3d0b`.

API/schema/migration changes: no API, database schema, or migration changes.

Feature flag or rollout method: no flag; the executor dependency is backward-compatible and the
exact tested commit was approved and deployed to the three production services.

Analytics events and success metrics: not applicable; this release changes cancellation control
flow only and adds no customer analytics event. Existing activity-attempt, cancellation, and
reconciliation telemetry remains in use.

Logs, metrics, dashboards, and alerts: existing Temporal cancellation and reconciliation signals;
no Collector configuration change. No new dashboard or alert was required for this narrow fix.

User, API, internal, and operational documentation: updated the platform audit, workflow execution
architecture reference, and this Temporal durability plan. The worker-kill matrix and activity
decomposition remain explicitly open.

Validation evidence: targeted graph, recovery, and cancellation tests passed (22/22); Agents
TypeScript check and build passed; `git diff --check` passed; production agents-api live/ready
checks returned 200, public `https://agents.kasitek.co.za/health/ready` returned ready, and the
agents-worker shell check passed.

Rollback or disable plan: redeploy the previous known-good commit if cancellation behavior causes
a regression. No migration rollback is needed. Do not claim remote provider reversal solely from a
cancellation; existing unknown-outcome reconciliation remains authoritative.

Post-release review date: 2026-09-08; review cancellation errors and complete the per-checkpoint
worker-kill coverage before closing P0.2/P0.3 durability work.

## Follow-up release record: hosted workflow agent-loop adapter

Change: Enable version 1 workflow `agent_loop` nodes through the same bounded runtime used by
ordinary hosted runs. Add node-prefixed model operation keys, apply residual graph budgets, share
tool grants and approval/effect lifecycle hooks, and map loop pauses into durable graph
checkpoints.

Owner: Agent Platform.

Risk: standard.

Affected services and user surfaces: agents-api, agents-worker, configured workflow execution,
workflow editor agent-loop nodes, approvals, handoffs, external-event waits, model-call ledger,
tool/effect records, and workflow checkpoints. MCP-Gateway is deployed with the shared artifact
but has no direct execution-path change.

Platform release version or release ID: record the exact commit and Railway deployment IDs after
production promotion.

API/schema/migration changes: no API, database schema, or migration changes. The version 1 graph
contract now has a supported `agent_loop` execution path; existing invalid graph rejection rules
remain in force.

Feature flag or rollout method: existing agent execution and effect controls remain authoritative;
no new flag was added. Rollback is by redeploying the prior application artifact.

Analytics events and success metrics: no new customer analytics event. Existing model-call,
tool-invocation, approval, workflow checkpoint, activity-attempt, budget, and reconciliation
signals remain the source of execution evidence; review workflow loop completion, pause, failure,
and budget-limit rates.

Logs, metrics, dashboards, and alerts: no Collector configuration change and no new exporter.
Existing bounded activity heartbeat, workflow, model, tool, approval, and reconciliation telemetry
is reused; no new dashboard was required for this adapter.

User, API, internal, and operational documentation: updated the architecture reference, platform
audit, and this durability plan. Public workflow schema documentation remains follow-up work.

Validation evidence: targeted graph, agent-loop, cancellation, and worker-loss tests plus Agents
TypeScript and build checks pass locally. Full suite and production deployment evidence are
pending.

Rollback or disable plan: redeploy the previous known-good commit. Disable agent execution or
effect execution through existing controls if an operational stop is needed. No migration rollback
is required.

Post-release review date: 2026-09-08; review agent-loop completion, pause/resume, budget, and
duplicate-operation metrics before closing the remaining graph and activity-decomposition work.
