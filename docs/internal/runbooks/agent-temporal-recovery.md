---
title: Agent Temporal recovery
owner: agent-platform
last_reviewed: 2026-09-01
---

# Agent Temporal recovery

This runbook covers worker loss, activity retries, model-operation uncertainty, and run-budget
reconciliation. It applies to the Agents API and Agents Worker in every environment.

## Activity inventory

`agentRunWorkflow` is the deterministic coordinator. It calls these activities:

| Activity | Work enclosed | Remote or durable boundary | Retry posture |
| --- | --- | --- | --- |
| `transitionRun` | Run status transition | Agents PostgreSQL | Idempotent state transition |
| `executeLoop` | Context, retrieval, model calls, tools, checkpoints, and completion decision | PostgreSQL, model providers, Core, channel/tool adapters | Still a large activity; completed model and tool outcomes plus opt-in loop-slice and eligible linear graph results are replayable when recorded |
| `pauseRun` | Persist waiting state and output | Agents PostgreSQL | Idempotent run transition |
| `deliverApprovalPrompt` | Resolve credentials and send the approval prompt | Telegram, Discord, or Core | Delivery failures are recorded; external sends require provider-safe handling |
| `cancelPendingApproval` | Cancel approval and mark its effect not executed | PostgreSQL | Idempotent by approval/effect state |
| `cancelHandoff` | Cancel the active handoff | PostgreSQL | Idempotent by handoff state |
| `completeRun` | Persist terminal output and rebuild the summary | PostgreSQL | Terminal run transition is guarded |
| `generateConversationTitle` | Optional decorative title model call | Model provider and PostgreSQL | Failure is swallowed after the main run completes |
| `deliverRunReply` | Resolve media and send the final reply | Telegram, Discord, or Core | Delivery attempt and unknown outcome are durable |
| `failRun` | Persist terminal failure | PostgreSQL | Terminal run transition is guarded |

`executeLoop` remains the P0.3 decomposition boundary. It must eventually be split into
retry-safe activities for context, one model operation, one tool operation, checkpoint, and
completion. Until then, the operation ledger and checkpoints are the safety boundary for retries.
When `TEMPORAL_STEP_ACTIVITIES_ENABLED=true`, each ordinary hosted loop slice carries a
deterministic step index. A checkpoint records the bounded message history, cumulative counters,
and the result status required by the workflow. If the same activity is retried with that step
index, the worker returns the recorded result for `limited` or a pause instead of rerunning the
model/tool slice. Approval and external-event resumes intentionally include their resume input and
continue from the checkpointed messages. For a configured graph, the same flag stops a linear graph
after one completed node and schedules the next node from its durable checkpoint. The graph
checkpoint includes edge/node iteration counters and the cumulative step/usage metadata. This
continuation mode does not apply to fan-out or `agent_loop` graphs, which remain on the existing
whole-graph boundary until the independent activity decomposition is released.

The activity-boundary recovery matrix is in
`agents/test/temporal-worker-loss-matrix.integration.test.ts`. It runs nine real Temporal cases:
model, tool, and effect loss before and after the checkpoint; approval loss after its pause
checkpoint; and completion loss before and after terminal persistence. Run it against a local
Temporal Server with:

```text
RUN_TEMPORAL_INTEGRATION_TESTS=true \
TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 \
pnpm --dir agents exec vitest run test/temporal-worker-loss-matrix.integration.test.ts
```

This matrix proves workflow replacement, pause/resume, and terminal activity idempotency. The
decomposed path additionally has targeted activity replay coverage in
`agents/test/decomposed-activities.test.ts`; the matrix still needs to be run with the decomposed
flag enabled before production rollout. The rollout flag is
`TEMPORAL_DECOMPOSED_ACTIVITIES_ENABLED`; it is disabled by default and should first be enabled
only for an isolated worker/task queue or tightly scoped canary. MCP and configured graph runs use
the compatibility activity even when the flag is true.

The inner-loop fault boundary is covered without making production failure injection available:
`agents/test/temporal-fault-injection.test.ts` simulates a retryable provider failure, a database
failure after model response persistence, and a database failure after a tool outcome is durable.
The expected outcomes are fallback on a retryable provider error, model replay without a second
provider request, and tool replay without a second handler invocation. These tests validate the
current bundled activity's safety net; they do not claim that the activity has already been split.

## Timeout and retry contract

The workflow proxy currently uses:

- schedule-to-close: 15 minutes;
- start-to-close: 5 minutes;
- heartbeat timeout: 20 seconds;
- maximum activity attempts: 5, with exponential backoff up to 30 seconds.

Provider, tool, and configured graph execution adapters must receive the activity cancellation
signal. Graph execution checks cancellation before starting a node and after an awaited provider or
tool result; it must not apply a late result or continue to a following node. A timeout or worker
loss must not be interpreted as proof that an external provider did not receive a request.

## Model-operation recovery

Before a hosted model request, the worker claims a stable, run-scoped operation key such as
`activity:loop:<run-id>:<iteration>:<attempt>`,
`workflow:agent-loop:<run-id>:<node>:<iteration>:<attempt>`, or
`workflow:model:<run-id>:<node>`. The `model_calls` row is created as `started` before provider
work. The run ID is required because `model_calls.operation_key` is globally unique; a key from a
different run must fail closed rather than be treated as a replay:

- `completed` stores the provider response and is replayed by a retry without another provider
  call;
- `failed` is safe to retry because the provider failure was known;
- `started` means the provider outcome is unknown. The retry stops instead of issuing a second
  request.

The worker recovery sweep moves old run-budget reservations to `unknown`, releases only the local
ledger estimate, emits `agent.model.reconciliation_required`, and exposes the reservation through:

- `GET /v1/operator/budgets/reconciliation` for platform operators;
- `GET /v1/operator/runs/:runId/usage-reconciliation` for a bounded run-level comparison of the
  Agents model-call and budget ledgers against Core reservations and usage events;
- `GET /v1/operations/budgets/reconciliation` for the owning organization;
- `GET /v1/operations/summary` for aggregate budget state.

The run-level report is platform-operator-only and requires `operator:read`. It uses the run's
organization and installation scope when calling Core, so operators do not need direct access to
the Core database. It compares Core events with platform-funded (`kasitek`) local model calls;
BYOK calls remain in the run budget but are not expected to create Core credit events. A `matched`
result means the returned Core usage events cover the billable local model calls, their provider
token totals match, and each event agrees with a captured Core reservation. When the provider
returns a cost, the report also compares the aggregate provider cost with the local billable
ledger. A missing provider cost is reported as unavailable rather than treated as invoice
evidence. `pending` means an unknown or unresolved local/Core reservation remains; `mismatch`
means the returned token, cost, or reservation amounts disagree; `no_billed_usage` means billable
local model calls exist without Core usage events and must be explained before treating the run as
settled.

Example:

```text
GET /v1/operator/runs/<run-id>/usage-reconciliation?limit=100
```

The endpoint is diagnostic and bounded. It does not settle a reservation or resolve an unknown
provider outcome. Use the dual-controlled reconciliation command below for that action.

Do not resolve an unknown reservation by editing PostgreSQL directly. Use the dual-controlled
operator command:

```text
POST /v1/operator/commands
Idempotency-Key: <unique-command-key>
{
  "commandType": "reconcile_budget",
  "targetId": "<reservation-id>",
  "payload": {
    "expectedOrganizationId": "<organization-id>",
    "expectedRunId": "<run-id>",
    "expectedStatus": "unknown",
    "outcome": "captured",
    "usage": {
      "inputTokens": 100,
      "outputTokens": 40,
      "totalTokens": 140,
      "estimatedCostUsd": 0.01
    },
    "reason": "Provider request lookup confirmed acceptance"
  }
}
```

Use `outcome: "released"` only when the provider confirms that it did not accept the request.
Two different operators must approve the command. A captured outcome requires provider-reported
usage; never infer it from the local estimate.

## Tool-operation recovery

Before an ordinary hosted tool handler runs, the worker records the provider tool-call identity and
argument hash in `tool_invocations`. On a retry, a completed row with the same run, tool-call ID,
tool name, and argument hash is returned as the durable redacted outcome. The retry then rebuilds
the model-visible tool message without invoking the handler, consuming another tool allowance,
creating another proposal/step, or consuming approval. Configured graph tools perform the same
lookup before resource preview, proposal, approval, budget, or effect work.

If the stored tool name or argument hash differs, recovery fails closed with
`TOOL_REPLAY_SCOPE_CONFLICT`. Proposed, executing, and failed rows are not treated as completed;
external effects whose provider outcome is unknown remain under effect reconciliation and must not
be replayed as if the provider had not received them.

For a configured fan-out, inspect `run_budget_parallel_leases` when a run reports a capacity
failure. The executor admits the first possible model/tool operation for every branch under the
run budget row lock before starting branch work. A lease is released after branch completion,
pause, failure, cancellation, or retry cleanup. `PARALLEL_MODEL_CAPACITY_EXCEEDED` and
`PARALLEL_TOOL_CAPACITY_EXCEEDED` mean the configured run limit cannot admit all branches at once;
do not bypass them by increasing worker concurrency. A lease that remains `active` after a worker
loss is safe to release only through the repository/recovery path after checking the corresponding
model or tool operation state.

## Incident procedure

1. Check `GET /v1/operator/health` and the Temporal namespace/task queue in the deployment
   dashboard.
2. Check the worker logs for `agent.worker.startup.failed`, `agent.recovery.sweep.failed`,
   `model.reconciliation.required`, and activity retry spans.
3. Inspect the affected run timeline, the run-level usage report, and the two budget reconciliation
   endpoints. Do not retry a run while
   its model operation or external effect is unresolved.
4. Look up the provider request using the stable operation key or provider-side idempotency key.
5. Resolve the budget through the dual-controlled command, then retry the run only if the product
   outcome is still incomplete.
6. Confirm that captured usage, durable `model_calls`, run budget totals, provider billing, and
   customer-visible output agree. Record the run-level report status and investigate any
   `pending`, `mismatch`, or `no_billed_usage` result before closing the incident.

## Conversation admission and redelivery

Only one active run may exist for a conversation. API admission locks the conversation row and
`agent_runs_one_active_conversation_uidx` is the final database guard. A `409 conversation_busy`
response is intentional backpressure: do not create a second run manually. For channel ingress,
retry the same provider event/message identity after the active run reaches a terminal state. The
provider identity makes a redelivery idempotent; a transaction that was rejected for backpressure
does not leave a partial message behind.

If the same platform idempotency key is retried, return the original message and run. If the
original run is terminal and the user wants another attempt, use the retry endpoint so the new run
keeps `causation_id` history without duplicating the inbound transcript.

## Signals and rollback

Watch these metrics and structured events:

- `kasitek.temporal.activity.attempt.count`;
- `kasitek.operation.retry.count`;
- `kasitek.run_budget.exhaustion.count`;
- `kasitek.run_budget.reconciliation_required.count`;
- `agent.model.reconciliation_required`;
- completed-tool replay and `TOOL_REPLAY_SCOPE_CONFLICT` failures;
- parallel branch capacity admissions, lease releases, and capacity failures;
- `agent.reply.delivery_failed` and effect reconciliation events.
- conversation admission outcomes, `conversation_busy` backpressure, and channel redelivery.

Migrations 084, 097, and 098 are additive. If the application release must be rolled back, deploy the previous
application artifact while retaining the migration and unresolved rows. Do not drop `operation_key`
or `response`; doing so would remove the evidence needed to prevent unsafe provider replay. Do not
drop the graph checkpoint runtime metadata from migration 098; older application artifacts ignore
the additive columns safely.

Migration 088 is additive. Do not remove its unique index during routine rollback. If migration
preflight finds duplicate active runs, stop the rollout and resolve the competing runs with the
operator recovery procedure before retrying the migration.
