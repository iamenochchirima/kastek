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
- [x] Add a controlled ordinary-run continuation seam that persists a bounded model-message
      checkpoint after each model/tool slice and schedules the next Temporal activity through a
      new operation-key prefix ([loop-checkpoint.ts](../../../agents/src/runtime/loop-checkpoint.ts),
      [loop-step.test.ts](../../../agents/test/loop-step.test.ts)); keep it opt-in until the
      worker-loss matrix is complete.
- [x] Make continuation retries return the persisted activity result when a worker is lost after
      the checkpoint write, carry paused-result metadata through recovery, and refuse partial
      multi-tool slices when the remaining tool budget cannot admit the provider response
      ([activities.ts](../../../agents/src/temporal/activities.ts),
      [loop-checkpoint.ts](../../../agents/src/runtime/loop-checkpoint.ts)).
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

Platform release version or release ID: commit `ac815292`; Railway production deployments
`agents-worker` `ca1e4843-df84-422a-8091-59dee0a14801`, `agents-api`
`3b03c95a-0af0-4dbc-88f5-3522e7c5a32d`, and `MCP-Gateway`
`54aeaee8-0e60-4a39-a880-be61e65b505f`; all reported `SUCCESS` for commit
`ac81529201f4081ebbe87e34a5bf281f62b26a08`. The preceding build failure on `7d66e73d` was
caused by an undeployed local-only authorization import; the fix is self-contained in this
release.

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

Validation evidence: targeted graph and agent-loop tests (21/21) and the Agents TypeScript check
passed after the release-boundary fix. The full Agents suite and production build were already
green for the implementation commit; the exact fix commit was promoted only after all three
Railway deployments reported `SUCCESS`. Internal agents-api live/ready checks returned 200,
`railway ssh` reached the worker shell, and public `https://agents.kasitek.co.za/health/ready`
returned `{"status":"ready","service":"agent-gateway"}`. `api.kasitek.co.za/health/ready`
returning 404 is expected because that public domain is not the private Agents API health
surface.

Rollback or disable plan: redeploy the previous known-good commit. Disable agent execution or
effect execution through existing controls if an operational stop is needed. No migration rollback
is required.

Post-release review date: 2026-09-08; review agent-loop completion, pause/resume, budget, and
duplicate-operation metrics before closing the remaining graph and activity-decomposition work.

## Follow-up release record: opt-in loop continuation seam

Change: Add a bounded, opt-in continuation mode for ordinary hosted runs. Each activity slice is
limited to one model iteration, persists a versioned bounded message continuation in the existing
run workflow-state record, and returns a checkpoint marker so the Temporal workflow schedules the
next slice with a new operation-key prefix.

Owner: Agent Platform.

Risk: standard.

Affected services and user surfaces: agents-worker, configured hosted runs, model-call and budget
ledgers, continuation/recovery behavior, and operator recovery diagnostics. Agents API and
MCP-Gateway carry the shared artifact but have no direct execution-path change.

Platform release version or release ID: commit `aa09c39b`; Railway production deployments
`agents-worker` `e0aa8afd-554a-4832-a92d-193a3bf84c79`, `agents-api`
`f9918d5e-1869-4e32-979b-d64656ee87c8`, and `MCP-Gateway`
`17493231-8190-4b4a-9253-29681c2cd170`; all reported `SUCCESS` for commit
`aa09c39bea1e82ed7ae09e7b5126cc044e2654ff`. The feature flag remains disabled in production.

API/schema/migration changes: no API or migration changes; the existing run workflow-state JSON
record stores a versioned `__agentLoop` continuation with bounded message count and size.

Feature flag or rollout method: `TEMPORAL_STEP_ACTIVITIES_ENABLED`, default `false`; enable only
for a controlled installation or equivalent canary after recovery evidence is available.

Analytics events and success metrics: no new customer analytics event. Review continuation count,
activity duration, model duplicate rate, budget reservation reconciliation, completion latency, and
pause/resume outcomes.

Logs, metrics, dashboards, and alerts: existing activity heartbeat, model-call, budget, and
reconciliation telemetry is reused. No Collector configuration change; debug exporters remain
verification-only and are not a production retention path.

User, API, internal, and operational documentation: updated the platform audit and workflow
execution architecture reference. The Temporal recovery runbook needs the canary/disable steps
before this flag is enabled.

Validation evidence: loop continuation and checkpoint validation tests pass (6/6 across the
continuation, checkpoint, and graph suites), Agents TypeScript check and build pass, and the full
Agents suite passes (94 files, 564 passed, 24 integration files skipped; 68 tests skipped).
The exact commit is deployed to all three production services; agents-api live/ready checks
returned 200 from inside the service, the worker shell check passed, and public
`https://agents.kasitek.co.za/health/ready` returned ready. Canary evidence is intentionally
pending because the flag remains disabled.

Rollback or disable plan: leave `TEMPORAL_STEP_ACTIVITIES_ENABLED=false` or redeploy the prior
known-good artifact. Existing runs with a persisted continuation are still readable by the
compatibility path; do not delete `__agentLoop` state or model-operation records during rollback.

Post-release review date: 2026-09-08; review canary continuation/retry/reconciliation metrics and
complete worker-kill coverage before enabling this mode more broadly.

## Follow-up release record: loop-slice retry replay guard

Change: Make the opt-in ordinary-run continuation seam idempotent across an activity retry after a
worker replacement. The checkpoint now carries a deterministic step index and the paused or limited
activity result; retries return that result without rerunning the model/tool slice. Multi-tool model
responses are treated as one budget unit and are never partially executed.

Owner: Agent Platform.

Risk: standard.

Affected services and user surfaces: agents-worker, ordinary hosted runs using the opt-in
continuation flag, model-call and run-budget ledgers, pause/resume behavior, and recovery
diagnostics. Agents API and MCP-Gateway were promoted with the shared artifact but have no direct
execution-path change.

Platform release version or release ID: commit `ffdae702905e60021b6f2417f324799ec72f0a87`;
Railway production deployments `agents-worker` `423eef26-c25f-4633-89ef-94f895deb756`,
`agents-api` `d1b96fab-b21d-4c99-b123-b8c22b0db527`, and `MCP-Gateway`
`d39ad74e-d09f-465b-bca7-2d8a09dc02ac`; all reported `SUCCESS` for the exact commit.

API/schema/migration changes: no API or database migration changes. Existing
`run_workflow_state.__agentLoop` JSON is extended additively with optional step and result
metadata; malformed state remains fail-closed.

Feature flag or rollout method: `TEMPORAL_STEP_ACTIVITIES_ENABLED`, default `false`; existing
persisted step checkpoints remain readable if the flag is later disabled so rollback does not
discard an in-flight continuation.

Analytics events and success metrics: no new customer analytics event. Review duplicate model-call
rate, provider request count, activity retry count, continuation count, budget settlement, pause
recovery, and multi-tool budget-limit outcomes.

Logs, metrics, dashboards, and alerts: existing activity-attempt, model-call, budget, heartbeat,
and reconciliation telemetry is reused. No Collector configuration change; debug exporters remain
verification-only.

User, API, internal, and operational documentation: updated the workflow execution architecture,
Temporal recovery runbook, and this plan. The full worker-kill matrix and independently retry-safe
activity decomposition remain open.

Validation evidence: Agents TypeScript check passed; targeted checkpoint, loop-slice, graph, and
runtime tests passed (24/24); full Agents suite passed (94 files, 566 passed, 24 integration files
skipped; 69 tests skipped); production build passed; real Temporal recovery integration passed
(3/3) against Temporal Server 1.31.2; `git diff --check` passed; and production live/ready,
worker-shell, and public Gateway readiness checks passed after deployment.

Rollback or disable plan: leave `TEMPORAL_STEP_ACTIVITIES_ENABLED=false` or redeploy the previous
known-good artifact. Existing model-operation records and continuation state must be retained until
affected runs are resolved; no migration rollback is required.

Post-release review date: 2026-09-08; review retry replay, duplicate-operation, budget
reconciliation, pause/resume, and multi-tool limit metrics before enabling the flag broadly.

## Follow-up release record: durable tool-outcome replay

Change: Replay a completed tool outcome after a worker retry when the same run and provider
tool-call identity carry the same tool name and argument hash. The lookup runs before new proposal,
run-step, budget, approval, resource-preview, or handler work for ordinary and configured-graph
execution. Scope mismatches fail closed, and non-completed or unknown external-effect outcomes are
not treated as successful replays.

Owner: Agent Platform.

Risk: standard.

Affected services and user surfaces: agents-worker, agents-api, configured workflow execution,
ordinary hosted runs, tool-invocation and run-step evidence, approvals, tool budgets, effect
receipts, and retry recovery. MCP-Gateway carries the shared artifact but has no direct execution
path change.

Platform release version or release ID: corrected commit `b97ebfb2275e46fa3562e14b7ebfd21dd10157c5`;
Railway production deployments `agents-worker` `150e88a8-dd54-4571-a1f3-f1bf75d2297b`,
`agents-api` `1fc63a98-6e3a-4923-b8da-1c6bc35a58d6`, and `MCP-Gateway`
`0983d9f0-3db1-4a63-8422-171740dd81b8`; all reported `SUCCESS` for the corrected SHA. The
initial pushed candidate `4572d350` failed before deployment because its selectively staged
runtime import was incomplete; it was replaced by the corrected commit.

API/schema/migration changes: no API, database schema, or migration changes. The existing unique
`(run_id, provider_tool_call_id)` tool-invocation record is used as the replay ledger.

Feature flag or rollout method: no new flag. Replay is an always-on retry safety guard; existing
effect-execution and loop-continuation controls remain authoritative.

Analytics events and success metrics: no new customer analytics event. Review duplicate tool
handler rate, completed-outcome replay count, scope-conflict failures, tool-budget consumption on
retries, approval consumption, effect reconciliation, and run-step states.

Logs, metrics, dashboards, and alerts: existing tool lifecycle, activity-attempt, budget, heartbeat,
and reconciliation telemetry is reused. The workflow heartbeat includes `workflow.tool.replayed`;
no Collector configuration change or debug exporter was added.

User, API, internal, and operational documentation: updated the platform audit, workflow execution
architecture reference, Temporal recovery runbook, and this plan. Public API contracts are
unchanged.

Validation evidence: targeted replay, checkpoint, and graph tests passed (`11/11`); Agents
TypeScript check and production build passed; full Agents suite passed (`94` files, `569` passed,
`24` integration files skipped, `69` tests skipped); `git diff --check` passed; and production
Agents API live/ready, worker-shell, and public Gateway readiness checks returned successfully.
The real Temporal recovery integration suite passed (`3/3`) against Temporal Server 1.31.2.

Rollback or disable plan: redeploy the previous known-good artifact. No migration rollback is
needed. Retain completed tool-invocation rows and unresolved external-effect receipts during
rollback so a retry cannot lose the evidence needed to avoid duplicate execution.

Post-release review date: 2026-09-08; review replay rate, scope conflicts, duplicate run-step
creation, effect reconciliation, and handler failure metrics before closing the remaining
worker-kill matrix and activity-decomposition items.

## Follow-up release record: parallel graph-branch budget admission

Change: Admit configured fan-out branches through a durable, tenant-scoped capacity lease before
launching branch work. The lease reserves the first possible model and tool operation for each
branch and is consumed atomically with the ordinary model reservation or tool allowance. Later
sequential operations continue through the canonical run budget ledger.

Owner: Agent Platform.

Risk: high.

Affected services and user surfaces: agents-worker, configured graph execution, run-budget and
workflow checkpoint records, operator budget diagnostics, and PostgreSQL tenant isolation.
Agents API and MCP-Gateway carry the shared artifact but have no direct graph execution path.

Platform release version or release ID: pending commit and exact Railway deployment IDs.

API/schema/migration changes: additive migration `097_parallel_branch_budget_leases.sql` creates
`run_budget_parallel_leases`, applies the existing child-scope ownership trigger, and enables
`FORCE ROW LEVEL SECURITY` for the restricted runtime role. No public API contract changes.

Feature flag or rollout method: no new flag. Graph branch admission is fail-closed and applies
only when the graph executor reaches a fan-out. Existing graph publication and execution controls
remain authoritative.

Analytics events and success metrics: no new customer analytics event. Review branch admission,
capacity rejection, lease release, model/tool reservation, retry, and reconciliation outcomes;
compare branch admission failures with configured graph limits.

Logs, metrics, dashboards, and alerts: existing budget exhaustion and activity heartbeat telemetry
is reused; `workflow.tool.replayed` remains available for retry diagnostics. Add operational query
coverage for active leases and capacity failures before closing the follow-up review.

User, API, internal, and operational documentation: updated the architecture audit, workflow
execution architecture, Temporal recovery runbook, and tenant-isolation inventory. Public API
documentation is not applicable.

Validation evidence: pending typecheck, targeted graph/migration tests, full Agents suite, build,
database migration, and production smoke verification.

Rollback or disable plan: redeploy the previous application artifact only after confirming no active
branch lease is protecting an in-flight model or tool operation. Retain migration 097 and its rows;
it is additive and should not be dropped during an application rollback.

Post-release review date: 2026-09-08; inspect active lease age, capacity rejections, branch retry
replay, model/tool budget totals, and provider billing reconciliation.
