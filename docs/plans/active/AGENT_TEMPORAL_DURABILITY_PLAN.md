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
- [x] Add a real Temporal worker-loss matrix around model, tool, approval, effect, and completion
      checkpoints before and after the activity boundary
      ([temporal-worker-loss-matrix.integration.test.ts](../../../agents/test/temporal-worker-loss-matrix.integration.test.ts));
      provider/database fault injection inside the still-large activity remains open.
- [x] Add an authenticated operator run-level usage reconciliation report that compares local
  model-call and budget totals with Core reservations and provider-reported usage events
  ([usage-reconciliation.ts](../../../agents/src/operations/usage-reconciliation.ts),
  [`GET /v1/operator/runs/:runId/usage-reconciliation`](../../../agents/src/http/app.ts)).
- [x] Define the versioned non-secret activity protocol for the next decomposition boundary
  ([decomposed-contracts.ts](../../../agents/src/temporal/decomposed-contracts.ts)); prompts,
  provider responses, tool arguments, and tool output remain in durable Agents state rather than
  being passed through Temporal history.
- [x] Add provider/database fault-injection tests for the current inner-loop safety boundary
  ([temporal-fault-injection.test.ts](../../../agents/test/temporal-fault-injection.test.ts)).
- [x] Split context, model, tool, checkpoint, and completion work into independently retry-safe
      activities behind `TEMPORAL_DECOMPOSED_ACTIVITIES_ENABLED` for ordinary hosted runs. MCP and
      configured graph runs explicitly use the compatibility activity until their boundaries are
      decomposed.
- [x] Move ordinary-loop sequencing into deterministic Temporal workflow code and persist approval
      and human/external-event resume state before the next model operation.
- [ ] Compare provider billing with reserved, captured, released, and reconciled usage during
  staged rollout; the diagnostic path exists, but staged production evidence and provider-side
  billing verification are still required.

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

Platform release version or release ID: commit `850681b40c98d6e465901e2a417179e7add338f5`; Railway
production deployments `agents-worker` `15d30a24-4e44-4b09-a595-fdde9ed7759c`, `agents-api`
`f6324539-4dd1-4567-8762-7cb70605774d`, and `MCP-Gateway`
`0a4bab87-5a3a-432a-be5e-19495fde2def`; all reported `SUCCESS` for the release SHA. Migration
one-shot deployment `8f21d894-105c-4696-b1a5-05ff9c14f765` exited after applying migration 097;
the temporary migration command and DDL variable were removed before restoring the normal API
start command.

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

Validation evidence: targeted graph/migration tests passed (`52/52`); full Agents suite passed
(`94` files, `571` passed, `24` integration files skipped, `69` tests skipped); Agents TypeScript
check and production build passed; migration 097 logged as applied in the one-shot deployment;
Agents API internal readiness returned `200`, the worker shell showed Temporal enabled with task
queue `kasitek-agents-production`, and public Gateway `/health` and `/health/ready` returned
`200`.

Rollback or disable plan: redeploy the previous application artifact only after confirming no active
branch lease is protecting an in-flight model or tool operation. Retain migration 097 and its rows;
it is additive and should not be dropped during an application rollback.

Post-release review date: 2026-09-08; inspect active lease age, capacity rejections, branch retry
replay, model/tool budget totals, and provider billing reconciliation.

## Follow-up release record: controlled linear graph continuation

Change: Add a controlled continuation seam for configured graphs that contain only linear model,
tool, and deterministic nodes. The worker returns only after persisting the completed node
checkpoint, allowing the next activity attempt to resume from the recorded next node and runtime
metadata. Fan-out and `agent_loop` graphs remain on the existing whole-graph activity boundary.

Owner: Agent Platform.

Risk: high.

Affected services and user surfaces: agents-api, agents-worker, configured linear workflow
execution, graph checkpoints, retry recovery, run budgets, and operator recovery diagnostics.
MCP-Gateway carries the shared artifact but has no direct graph execution path.

Platform release version or release ID: commit `83d067c0da3b7866297aa8ec34800ab40aff4ad6`;
Railway production deployments `agents-api`
`1b72f9b1-95c7-42e8-a5b6-6014a6697f9e`, `agents-worker`
`5ea101ce-8862-4889-b838-ad5e0bbb3574`, and `MCP-Gateway`
`a68dec80-f102-4f30-b74a-d199e92a9ca5`; all reported `SUCCESS` for the release SHA.

API/schema/migration changes: no new migration. Migration `098_workflow_checkpoint_runtime_metadata.sql`
was applied and verified before this release; the continuation uses its additive graph runtime
metadata columns.

Feature flag or rollout method: existing `TEMPORAL_STEP_ACTIVITIES_ENABLED`, default `false` in
production. When enabled, only eligible linear configured graphs use the one-node continuation;
fan-out and `agent_loop` graphs are explicitly excluded. Full independent context/model/tool/
checkpoint/completion activity decomposition remains open P0.3 work.

Analytics events and success metrics: no new customer analytics event. Review continuation rate,
checkpoint retry rate, duplicate model/tool execution, budget totals, pause/resume outcomes, and
failure rate by graph shape before widening the rollout.

Logs, metrics, dashboards, and alerts: existing activity-attempt, heartbeat, checkpoint, budget,
and reconciliation telemetry is reused. No Collector or debug-exporter configuration change was
made; use the existing Temporal recovery runbook queries and release SHA to inspect failures.

User, API, internal, and operational documentation: updated the platform audit, workflow execution
architecture reference, Temporal recovery runbook, and this plan. Public API documentation is not
applicable because the contract is internal and the flag is disabled by default.

Validation evidence: full Agents suite passed (`94` files, `573` passed, `24` integration files
skipped, `69` tests skipped); Agents TypeScript check and production build passed; staged diff
checks passed; public Agents API `/health/ready` and `/health` returned HTTP `200`; internal API
readiness returned `200` with `temporalEnabled: true`; and the worker shell reported Temporal
enabled on task queue `kasitek-agents-production`.

Rollback or disable plan: keep `TEMPORAL_STEP_ACTIVITIES_ENABLED=false` or redeploy the previous
known-good artifact. Retain migration 098 and graph checkpoint runtime metadata during rollback;
older application artifacts ignore the additive columns safely. Do not enable the flag for fan-out
or `agent_loop` graphs until their independent activity contracts and worker-kill coverage land.

Post-release review date: 2026-09-08; review graph continuation adoption, checkpoint/runtime
metadata replay, duplicate execution, budget reconciliation, and worker-loss recovery before
advancing P0.3.

## Follow-up release record: Temporal activity worker-loss matrix

Change: Add integration coverage for worker replacement before and after model, tool, approval,
effect, and completion checkpoints. The matrix verifies that workflow state resumes, approval
signals remain usable, and terminal completion is persisted once across worker replacement.

Owner: Agent Platform.

Risk: low.

Affected services and user surfaces: Agents Temporal workflow tests, recovery runbook, and audit
evidence. No production runtime behavior or customer-facing API changed.

Platform release version or release ID: test/documentation commit
`615abf51`; no production service artifact was changed or deployed.

API/schema/migration changes: not applicable; no API, schema, or migration changes.

Feature flag or rollout method: not applicable; the test requires an explicit local
`RUN_TEMPORAL_INTEGRATION_TESTS=true` opt-in and does not enable the production continuation flag.

Analytics events and success metrics: not applicable; the test emits no customer analytics. The
success metric is nine of nine matrix cases passing against a real Temporal Server.

Logs, metrics, dashboards, and alerts: not applicable to production. The local run intentionally
logs synthetic activity failures for the before-checkpoint cases; those failures are the injected
worker-loss condition, not application failures.

User, API, internal, and operational documentation: updated the architecture audit and
`docs/internal/runbooks/agent-temporal-recovery.md` with the matrix scope and command.

Validation evidence: the real Temporal integration matrix passed `9/9` cases against Temporal
Server `1.31.2`; the test passed without the integration opt-in as `9` skipped; Agents TypeScript
check passed; and the staged diff passed `git diff --check`.

Rollback or disable plan: revert the test/documentation commit if necessary. No production
rollback is required because no service artifact, flag, database, or runtime behavior changed.

Post-release review date: 2026-09-08; use the matrix as a gate for the remaining inner
`executeLoop` activity decomposition and provider/database fault-injection tests.

## Follow-up release record: run usage reconciliation

Change: Add a bounded, authenticated operator report that compares Agents durable model-call and
run-budget records with Core credit reservations and provider-reported usage events for one run.
The report classifies `matched`, `pending`, `mismatch`, and `no_billed_usage` outcomes without
settling reservations.

Owner: Agent Platform.

Risk: standard.

Affected services and user surfaces: Agents API operator diagnostics, Agents Worker usage records,
Core credit boundary, and MCP Gateway shared Agents artifact. No customer-facing surface changed.

Platform release version or release ID: Agents application commit `b25510e7`; Core formatting
follow-up `768a7ddb`. Final production deployments: Core `7487836d-4754-458e-b647-1543fee88cf7`
(image `sha256:95fbd5d98ae060a2ea2155ebc855e5d4494c3b17eeda114d8e977c59212ff4dc`), Agents API
`f207f1c9-d8ba-4a1f-b9f2-91ae547a7cdd` (image
`sha256:23f87335ca21b3b427312b627984dfe140c85c8b21ac1e13730ca2cb30e8a491`), Agents Worker
`62354d84-9065-44a5-9059-3da86d8de7b5` (image
`sha256:88ceaaa4d52f9f72270776c76080923d90a160c678edf7349d3a2e5dd22fd3b8`), and MCP Gateway
`53e7a306-9fec-4274-ad15-99fee846832d` (image
`sha256:9b2faaa2ee79e1edbc91530552f68719dd97e805ec05105c6dafb33ee774cd6f`). Test-matrix fix
`8948f262` updated the route-count conformance assertions; it did not change watched runtime
files or trigger a new production artifact.

API/schema/migration changes: Adds internal `GET /api/internal/agents/v1/credits/usage` in Core,
scoped by organization, source type, source ID, and a maximum 500-row limit. Adds operator-only
`GET /v1/operator/runs/:runId/usage-reconciliation` in Agents. No database migration.

Feature flag or rollout method: no new flag. The operator endpoint is available only behind the
existing platform operator authentication and `operator:read` scope. It is diagnostic; budget
settlement remains behind the existing dual-controlled command.

Analytics events and success metrics: no new customer analytics event. Success metrics are report
status distribution, uncovered local model calls, token comparison mismatches, and pending Core or
Agents reservations during staged observation.

Logs, metrics, dashboards, and alerts: Core emits the existing structured HTTP completion event
with the reconciliation operation and bounded counts; Agents logs Core-boundary failures with run
and organization identifiers. No Collector configuration revision changed. Use the Temporal
recovery runbook and existing budget/reconciliation metrics; do not treat the diagnostic report as
an alert by itself.

User, API, internal, and operational documentation: updated
`AGENT_PLATFORM_ARCHITECTURE_AUDIT.md`, `docs/internal/runbooks/agent-temporal-recovery.md`, and
this plan. Public API documentation is not applicable because both new routes are internal.

Validation evidence: Agents targeted reconciliation, Core-client, and HTTP tests passed (`130`);
the full Agents suite passed (`95` files, `579` passed, `78` skipped); Agents TypeScript build
passed; `cargo check --manifest-path server/kasitek-core/Cargo.toml` passed; the Core representative
route test passed; public `https://agents.kasitek.co.za/health/ready` and
`https://api.kasitek.co.za/health` returned HTTP `200`; and an authenticated in-container probe
reached the new Agents route and returned `404 run_not_found` for a valid UUID. Production has no
run rows yet, so a real billed-run result remains unobserved.

Rollback or disable plan: redeploy the previous successful Core and Agents artifacts. The change
has no migration and no data mutation; removing the operator route is safe after operators have a
replacement report. If Core is unavailable, Agents returns a bounded `502` diagnostic response and
retains local usage/budget data for investigation.

Post-release review date: 2026-09-08; review the first real run reports, status distribution,
provider token coverage, and any pending or mismatch outcomes before closing P0.4.

## Follow-up release record: decomposed activity protocol and fault-injection coverage

Change: Define the versioned non-secret contract for independently retry-safe context, model, tool,
checkpoint, and completion activities. Add deterministic fault-injection tests for retryable
provider failure, post-persistence database failure, and post-tool-outcome database failure.

Owner: Agent Platform.

Risk: low.

Affected services and user surfaces: Agents Temporal contracts, runtime safety tests, recovery
runbook, and architecture evidence. No production runtime path, API, database, or customer-facing
surface changed.

Platform release version or release ID: test/documentation commit pending; no production service
artifact is enabled by this change.

API/schema/migration changes: not applicable; no API, schema, or migration changes.

Feature flag or rollout method: not applicable. The protocol is not wired into the production
workflow and no failure-injection switch exists outside tests. The independent activity rollout
remains a separate follow-up behind a new controlled flag.

Analytics events and success metrics: not applicable to production. Test success is stable protocol
key derivation plus provider fallback and exactly-once replay behavior across the injected failures.

Logs, metrics, dashboards, and alerts: no production telemetry change. The test failures are
synthetic and do not alter Collector configuration, dashboards, or alerts.

User, API, internal, and operational documentation: updated the architecture audit, workflow
execution reference, Temporal recovery runbook, and this plan. The documents explicitly separate
the protocol contract from the not-yet-released worker wiring.

Validation evidence: targeted protocol and fault-injection tests passed; full Agents suite,
TypeScript check, production build, and the real Temporal worker-loss matrix remain required before
the protocol is wired and enabled.

Rollback or disable plan: revert the test/documentation commit if necessary. No production
rollback, migration rollback, or data repair is required because the new protocol is not on a
runtime path.

Post-release review date: 2026-09-08; review the worker implementation design and require an
activity-level provider/database fault matrix before enabling the decomposed rollout.

## Follow-up release record: decomposed ordinary-run activity wiring

Change: Wire the versioned decomposed context/model/tool/checkpoint/completion protocol into the
Temporal workflow for ordinary hosted runs, with durable state revisions, model/tool outcome replay,
approval waits, cancellation checks, and human-event resume persistence. MCP and configured graph
runs explicitly fall back to the compatibility activity.

Owner: Agent Platform.

Risk: high.

Affected services and user surfaces: agents-api, agents-worker, Agents PostgreSQL, Temporal
workflow history, model providers, tool/effect execution, approval prompts, human handoff resume,
and customer-facing hosted-agent replies. The rollout is disabled by default.

Platform release version or release ID: pending final commit and production artifact identity.

API/schema/migration changes: no API or database migration. Additive workflow input/configuration
field only: `decomposed` and `TEMPORAL_DECOMPOSED_ACTIVITIES_ENABLED`.

Feature flag or rollout method: `TEMPORAL_DECOMPOSED_ACTIVITIES_ENABLED=false` by default. Enable
only for a canary worker/task queue after the real Temporal worker-loss matrix and provider billing
reconciliation pass. Unsupported MCP and configured graph runs remain on the compatibility path.

Analytics events and success metrics: no new customer analytics event. Success metrics are zero
duplicate provider/tool outcomes, zero replay scope conflicts, no unaccounted model reservations,
and equivalent completion/approval/handoff rates between the canary and compatibility paths.

Logs, metrics, dashboards, and alerts: existing Temporal activity-attempt, model reconciliation,
budget exhaustion, effect reconciliation, and structured run lifecycle telemetry. Decomposed
activities emit bounded heartbeat phase metadata without prompt, response, argument, or credential
content. Collector configuration is unchanged; `not applicable` for a new Collector revision.

User, API, internal, and operational documentation: updated
`AGENT_PLATFORM_ARCHITECTURE_AUDIT.md`, `docs/internal/architecture/agent-workflow-execution.md`,
`docs/internal/runbooks/agent-temporal-recovery.md`, and this plan. Public API documentation is
not applicable.

Validation evidence: decomposed contract, coordinator, activity replay, and existing Temporal
fault-injection tests pass; Agents TypeScript check passes. The full Agents suite, production
build, real Temporal matrix with the decomposed flag enabled, and provider-side billing comparison
remain release gates.

Rollback or disable plan: set `TEMPORAL_DECOMPOSED_ACTIVITIES_ENABLED=false` and restart
agents-api/agents-worker, then redeploy the previous successful artifact if required. Existing
workflow runs retain their selected input and finish on their current path; new runs use the
compatibility activity. No migration rollback or data repair is required.

Post-release review date: 2026-09-08; review canary duplicate rates, activity retries, approvals,
handoff resumes, budget settlement, provider billing, and compatibility-path fallback counts.
