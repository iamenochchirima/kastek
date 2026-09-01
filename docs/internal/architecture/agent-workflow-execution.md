---
title: Agent workflow execution
owner: agent-platform
last_reviewed: 2026-09-01
---

# Agent workflow execution

Hosted workflow runs are coordinated by a Temporal workflow and execute runtime work in the
Agents worker. PostgreSQL stores run state, ordered steps, model and tool lifecycle records, run
budgets, and workflow node checkpoints.

## Supported graph contract

The graph validator accepts version 1 graphs, validates node and edge references, and rejects
cycles. Fan-out graphs must name a fan-in node, have at least two branches, and route every
branch to that join. The executor runs those branches against a shared run budget, merges only
changed state paths, rejects overlapping writes, and executes the fan-in node once after all
branches reach it.

`agent_loop` nodes are hosted through the same bounded loop runtime as ordinary runs. The node
instruction and state are added to the existing scoped context, model operations use a node-
prefixed durable operation key, tool grants/approval/effect policy use the normal hooks, and the
node's loop usage is added to the graph aggregate. Node `maxIterations` and the remaining graph
model/tool/token/cost limits are applied before the inner loop starts. Approval, handoff, and
external-event results become graph checkpoints and resume at the same node.

Supported execution records validate state at the initial, intermediate, resumed, and final
boundaries. Node completion and pause checkpoints include state, trace, usage, next-node identity,
runtime iteration counters, graph step count, and an idempotency key. Graph retries restore those
counters before selecting the next node, so a worker replacement cannot reset a node, edge, or
graph-step limit. Fan-out test execution merges branch deltas and rejects conflicting overlapping
writes.

## Budgets and cancellation

Every hosted run initializes one durable budget ledger. Model work reserves estimated capacity and
settles it with provider usage or releases it on provider failure. Tool execution consumes an
atomic tool allowance. The same limits are passed to normal loops and configured graph execution,
including model calls inside graph nodes. MCP tool runs use the tool allowance as well.

Temporal activities use bounded schedule/start-to-close and heartbeat timeouts. The current loop,
model, tool, and graph adapters receive an abort signal where supported. Graph execution checks the
signal before starting a node and after an awaited model or tool result, so a late result is not
written into state or followed by another node. External effects retain durable approval and receipt
records; if a provider outcome cannot be proven, the effect remains eligible for reconciliation
rather than being treated as reversed. Activity attempt, budget exhaustion, and reconciliation
signals are emitted as bounded metrics and structured events.

The run budget ledger follows the same fail-closed rule. A worker timeout can leave a model
reservation in `unknown`; reconciliation releases the estimate only as a ledger operation and does
not claim that the provider did not execute the request. An operator or provider lookup must later
resolve the reservation as captured with actual usage or released with a reason. A captured
reservation cannot be silently reused by a retry.

## Known boundary

The default `executeLoop` activity still encloses more than one logical model/tool operation. An
opt-in `TEMPORAL_STEP_ACTIVITIES_ENABLED` mode provides an intermediate boundary for ordinary
hosted runs: each activity slice performs at most one model iteration, persists a bounded message
continuation in `run_workflow_state`, and the Temporal workflow schedules the next slice. The
continuation is versioned and fail-closed when malformed or oversized. It also records the step
index and paused result metadata, so a retry after the worker is lost after the database write can
replay the activity result without calling the provider or tool again.

Model operations claim a stable operation key in `model_calls` and persist the provider response
before budget and credit settlement; a completed operation is replayed without another provider
request. A worker loss after the request starts can still leave the operation `started` with an
unknown provider outcome, so it is stopped and sent to reconciliation rather than retried blindly.
Tool invocations claim a stable `(run_id, provider_tool_call_id)` record. When a retry finds a
completed record with the same tool name and argument hash, it reuses the persisted, redacted
outcome before creating a new proposal or step, consuming tool budget, invoking the handler, or
consuming approval. Configured graph tools use the same lookup before resource preview and effect
execution. A name or argument-hash mismatch fails closed; non-completed records are not replayed.
External effects retain their durable receipt boundary, and an unknown provider outcome still goes
to reconciliation rather than being treated as a successful replay.
The step mode groups the tool calls returned by one model response and refuses to execute a partial
multi-tool response when the remaining run budget cannot admit all of them. It does not yet make
context, model, individual tool, checkpoint, and completion work separate Temporal activities.
For controlled rollout, the same flag can also stop eligible linear configured graphs after one
completed node; graphs containing fan-out or `agent_loop` nodes continue through the existing
whole-graph activity boundary. The worker-kill matrix and the fully independent context/model/tool
activity decomposition therefore remain P0.3 work.

Fan-out admission uses `run_budget_parallel_leases`. Before branch promises are launched, the
executor identifies the first possible model and tool operation in each branch and atomically
leases those capacities under the run budget row lock. The first operation consumes its matching
lease slot in the same transaction as its normal model reservation or tool allowance. Additional
sequential operations use the ordinary ledger and limits. Leases are released in a `finally`
block, including pause, failure, cancellation, and worker-retry paths. A capacity mismatch or
missing lease fails closed before provider or tool work begins.
