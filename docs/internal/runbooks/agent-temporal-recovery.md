---
title: Agent Temporal recovery
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agent Temporal recovery

This runbook covers worker loss, activity retries, model-operation uncertainty, and run-budget
reconciliation. It applies to the Agents API and Agents Worker in every environment.

## Activity inventory

`agentRunWorkflow` is the deterministic coordinator. It calls these activities:

| Activity | Work enclosed | Remote or durable boundary | Retry posture |
| --- | --- | --- | --- |
| `transitionRun` | Run status transition | Agents PostgreSQL | Idempotent state transition |
| `executeLoop` | Context, retrieval, model calls, tools, checkpoints, and completion decision | PostgreSQL, model providers, Core, channel/tool adapters | Still a large activity; model outcomes are operation-keyed and replayable when recorded |
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

## Timeout and retry contract

The workflow proxy currently uses:

- schedule-to-close: 15 minutes;
- start-to-close: 5 minutes;
- heartbeat timeout: 20 seconds;
- maximum activity attempts: 5, with exponential backoff up to 30 seconds.

Provider and tool adapters must receive the activity cancellation signal. A timeout or worker loss
must not be interpreted as proof that an external provider did not receive a request.

## Model-operation recovery

Before a hosted model request, the worker claims a stable operation key such as
`model:<iteration>:<attempt>` or `workflow:model:<node>`. The `model_calls` row is created as
`started` before provider work:

- `completed` stores the provider response and is replayed by a retry without another provider
  call;
- `failed` is safe to retry because the provider failure was known;
- `started` means the provider outcome is unknown. The retry stops instead of issuing a second
  request.

The worker recovery sweep moves old run-budget reservations to `unknown`, releases only the local
ledger estimate, emits `agent.model.reconciliation_required`, and exposes the reservation through:

- `GET /v1/operator/budgets/reconciliation` for platform operators;
- `GET /v1/operations/budgets/reconciliation` for the owning organization;
- `GET /v1/operations/summary` for aggregate budget state.

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

## Incident procedure

1. Check `GET /v1/operator/health` and the Temporal namespace/task queue in the deployment
   dashboard.
2. Check the worker logs for `agent.worker.startup.failed`, `agent.recovery.sweep.failed`,
   `model.reconciliation.required`, and activity retry spans.
3. Inspect the affected run timeline and the two reconciliation endpoints. Do not retry a run while
   its model operation or external effect is unresolved.
4. Look up the provider request using the stable operation key or provider-side idempotency key.
5. Resolve the budget through the dual-controlled command, then retry the run only if the product
   outcome is still incomplete.
6. Confirm that captured usage, durable `model_calls`, run budget totals, provider billing, and
   customer-visible output agree.

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
- `agent.reply.delivery_failed` and effect reconciliation events.
- conversation admission outcomes, `conversation_busy` backpressure, and channel redelivery.

Migration 084 is additive. If the application release must be rolled back, deploy the previous
application artifact while retaining the migration and unresolved rows. Do not drop `operation_key`
or `response`; doing so would remove the evidence needed to prevent unsafe provider replay.

Migration 088 is additive. Do not remove its unique index during routine rollback. If migration
preflight finds duplicate active runs, stop the rollout and resolve the competing runs with the
operator recovery procedure before retrying the migration.
