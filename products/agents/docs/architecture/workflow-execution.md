---
title: Agent workflow execution
owner: agent-platform
last_reviewed: 2026-09-01
---

# Agent workflow execution

This document describes the current Temporal implementation. The target architecture selects self-hosted Restate for business-agent durable execution. See the [platform architecture](agent-platform-architecture.md).

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
written into state or followed by another node. The workflow tracks each in-flight model, batch,
tool, and commit Activity in a cancellable scope; an application Stop/expire signal cancels those
scopes before transitioning the durable run. Long-running Activities heartbeat every five seconds,
and the production Worker caps SDK heartbeat throttling at five seconds so cancellation is delivered
promptly rather than waiting for the SDK default window. External effects retain durable approval and
receipt records; if a provider outcome cannot be proven, the effect remains eligible for
reconciliation rather than being treated as reversed. Activity attempt, budget exhaustion, and
reconciliation signals are emitted as bounded metrics and structured events.

Social content batch publishing uses the same boundary. The Agent prepares one draft, Core
preflights every concrete account and captures the target, variant, media, and permission
identity in an approval snapshot, then admits one durable batch after one approval. Existing
per-account publish jobs remain the provider execution records; the batch only coordinates them
and aggregates their states. The batch status endpoint and Agent status capability expose
`SUCCEEDED`, `PARTIAL`, `PROCESSING`, `FAILED`, `BLOCKED`, or `UNKNOWN` plus bounded per-target
reason and remediation fields. A blocked preflight queues no provider work. A timeout or upstream
5xx is recorded as `UNKNOWN` and is not retryable until a provider reconciliation path confirms
the outcome; confirmed published targets are never retried.

After an approved batch is admitted, the Agent retains the returned batch ID in the run result and
the Temporal workflow polls the read-only Core status activity on durable timers. The run is not
completed with the initial `PROCESSING` text. It delivers one terminal aggregate and per-target
result when Core settles the batch, or an explicit unconfirmed message after the bounded observation
window. Status observation failures are recorded as bounded run events and never become a claim that
the batch failed or that no destination published.

The run budget ledger follows the same fail-closed rule. A worker timeout can leave a model
reservation in `unknown`; reconciliation releases the estimate only as a ledger operation and does
not claim that the provider did not execute the request. An operator or provider lookup must later
resolve the reservation as captured with actual usage or released with a reason. A captured
  reservation cannot be silently reused by a retry.

## Approval groups

Approval-required calls emitted in one autonomous model batch form one immutable approval group.
The group carries a deterministic plan digest and expiry; its child approval records retain the
exact runtime operation, provider call, arguments hash, capability revision, and resource snapshot
that the reviewer saw. `Approve all` authorizes only that group, never a later model turn. The
Temporal Workflow waits on the group decision, then each `executeToolCall` Activity re-reads and
consumes its selected child authorization before an effect. A stale digest, unselected operation,
expired group, or changed resource fails closed. The HTTP decision path revalidates the reviewed
resource snapshot before accepting a decision; a mismatch durably invalidates the group, signals
the waiting Workflow, and commits a typed blocked result for every child. Rejection, expiry,
cancellation, invalidation, provider failure, and unknown effects remain distinct operation
outcomes. Group approval does not change the parallel-tool safety segmentation; it only opens the
existing durable execution barrier.

## Execution boundary

For new autonomous runs, `agentRunWorkflow` owns the model-to-tool command sequence. The
`executeModelStep` Activity performs one bounded model/context slice with provider tool execution
deferred. `prepareToolBatch` persists the complete assistant batch and safety segments,
`executeToolCall` runs one durable call, and `commitToolBatch` writes the ordered tool results
before the next model slice. The old `executeLoop` Activity is retained only behind the Temporal
patch gate for histories that began before this command-sequence migration; it is not the path for
new runs.

The continuation is versioned and fail-closed when malformed or oversized. It records the step
index, pinned authorization snapshot, and paused result metadata, so a retry after the worker is
lost after the database write can replay the Activity result without calling the provider or tool
again. Safe calls are joined by the Workflow in bounded waves; sequential external effects remain
barriers. An unauthorized or otherwise blocked sibling becomes a typed per-call result instead of
discarding the valid calls in the same model batch.

Model operations claim a stable, run-scoped operation key in `model_calls` and persist the provider
response before budget and credit settlement; a completed operation is replayed without another
provider request. Normal hosted-loop keys use the run ID plus the activity-slice checkpoint when
present, and configured workflow keys use the run ID plus the node ID. A worker loss after the
request starts can still leave the operation `started` with an unknown provider outcome, so it is
stopped and sent to reconciliation rather than retried blindly. The run scope is part of the key
because `model_calls.operation_key` is globally unique; omitting it would make two independent
runs at the same iteration or node fail closed as a scope conflict. Before reservation, the bounded
runtime estimates the serialized prompt, including granted tool schemas, and caps an implicit model
output allowance to the remaining run-token budget after that estimate. The total-token limit
therefore covers both input and output without rejecting a first request merely because its output
ceiling equals the entire run budget.
Tool invocations claim a stable `(run_id, provider_tool_call_id)` record. When a retry finds a
completed record with the same tool name and argument hash, it reuses the persisted, redacted
outcome before creating a new proposal or step, consuming tool budget, invoking the handler, or
consuming approval. The run-level tool budget is claimed once per durable runtime operation in the
same PostgreSQL transaction as the counter increment, so a provider retry cannot consume the same
logical call twice. Configured graph tools use the same lookup before resource preview and effect
execution. A name or argument-hash mismatch fails closed; non-completed records are not replayed.
External effects retain their durable receipt boundary, and an unknown provider outcome still goes
to reconciliation rather than being treated as a successful replay.
The step mode accepts the complete tool batch even when the run-level tool budget is smaller than
the proposal count. The budget remains an execution guardrail: each call receives a typed budget
result when capacity is genuinely exhausted, while sibling calls are not discarded as an atomic
batch. Safe calls are bounded by the Temporal worker's activity concurrency; side-effecting calls
remain ordered barriers unless their manifest explicitly opts into parallel execution. MCP and
configured graph compatibility paths retain their existing ownership boundaries, but autonomous
tool calls do not use a hidden in-Activity fan-out or an opt-in decomposition flag.

## Context runtime contract

Every hosted agent model attempt resolves capability for its own provider, route, and model before
dispatch. The shared context planner selects history units, protects the current task and
assistant tool-call/result pairs, bounds tool schemas/results, reserves output and safety margin,
and measures both the generic request shape and the provider adapter envelope. A request is not
admitted when either the token or serialized-byte gate fails. Provider-reported usage is a later
measurement anchor; it does not replace the pre-dispatch fit decision.

The planner emits a content-free request manifest and accounting fact through the existing
`harness.turn` journal envelope. It contains component counts, token/byte estimates, source and
manifest digests, and fit reasons—not prompts, credentials, or private tool output. After a
compaction, occupancy remains unknown until a provider response re-anchors it. Durable compaction
is fenced and replayable; its lifecycle events use the same journal. Before a lossy rewrite, the
context runtime may call the memory checkpoint port, while memory remains responsible for evidence
persistence and retrieval rather than token policy, pruning, or prompt assembly.

Capability metadata is resolved against the exact provider, default endpoint, credential route,
model, and runtime environment. The direct-provider metadata adapter uses credentials only for the
metadata request, never logs or persists the secret, and returns no capacity when the provider does
not publish an authoritative limit. Unknown capacity remains a typed fail-closed outcome. Attempt
telemetry preserves queue delay, prompt/prefill time-to-first-token, total provider latency, output
throughput, and the context measurement basis in the same durable read model. That read model keeps
current context occupancy, cumulative provider usage, and the configured run-token budget as
separate values; the Test UI does not substitute one for another.

## Durable session transcript

Conversation display rows are not the model-context source of truth. The Agents worker creates one
organization-, installation-, and conversation-scoped session context with a monotonic generation,
ordered transcript head, idempotent entry keys, and an active compaction pointer. The transcript
stores structured model messages so assistant tool calls, provider tool IDs, runtime operation IDs,
and tool results are not flattened into the final customer reply.

On a new generation-1 turn, legacy display history is imported conservatively once, the admitted user
message is appended, and the active transcript projection is passed to the context policy. Later
turns read the canonical session before admitting only the new user entry. During the bounded
bootstrap window, the runtime compares legacy and canonical entry keys, ordering, content digests,
and bounded counts; it emits no message bodies. The summary table remains a display compatibility
projection and is not read to assemble a canonical model prompt. The final assistant message is
appended before terminal run persistence. Live tool-call and approval boundaries must append their
structured entries through the same seam; their dispatch and effect state machines remain owned by
the tool execution runtime.

For a deferred model batch, the assistant tool-call message is appended before any tool activity
or approval decision. The entry retains both the provider call ID and the runtime operation ID and
is idempotent by batch. The runtime then appends a typed waiting marker containing the ordered
pending operation IDs. While that marker has unresolved operations, normal provider projections
retain the audit entries but omit the incomplete assistant/tool round; a recovery read may inspect
the incomplete state explicitly. This prevents a retry or approval wait from sending an unanswered
assistant tool call back to a model.

Each terminal batch result—completed, failed, timed out, cancelled, blocked, waiting, or unknown
effect—is appended as a tool message keyed by its runtime operation ID before continuation. The
canonical transcript keeps the complete redacted result. The workflow checkpoint may carry only a
bounded preview with a retrieval handle for large output, so checkpoint size cannot replace or
truncate canonical context. Once all operation IDs have results, the waiting marker is skipped by
the active provider projection and the complete assistant/tool round becomes model-visible.

Compaction archives the replaced active rows without deleting them, writes a validated checkpoint,
and advances the active pointer atomically. Subsequent requests load the checkpoint followed by the
uncompacted tail. A retry of an already committed append replays the entry; a stale head cursor or
digest fails closed. An explicit Clear/New operation starts a new generation; retries, worker
replacement, approval resume, and Temporal recovery do not reset session context.

Each provider request manifest records the canonical transcript cursor, transcript generation, and
active-projection digest alongside its bounded source and fit accounting. The request is not
admitted if that identity does not match the active session projection that was loaded for the
turn. Provider-relative soft pressure selects the durable retained tail; the final provider planner
still owns the exact token and byte fit gate.

Fan-out admission uses `run_budget_parallel_leases`. Before branch promises are launched, the
executor identifies the first possible model and tool operation in each branch and atomically
leases those capacities under the run budget row lock. The first operation consumes its matching
lease slot in the same transaction as its normal model reservation or tool allowance. Additional
sequential operations use the ordinary ledger and limits. Leases are released in a `finally`
block, including pause, failure, cancellation, and worker-retry paths. A capacity mismatch or
missing lease fails closed before provider or tool work begins.
