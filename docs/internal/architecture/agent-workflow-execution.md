---
title: Agent workflow execution
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agent workflow execution

Hosted workflow runs are coordinated by a Temporal workflow and execute runtime work in the
Agents worker. PostgreSQL stores run state, ordered steps, model and tool lifecycle records, run
budgets, and workflow node checkpoints.

## Supported graph contract

The graph validator accepts version 1 graphs, validates node and edge references, rejects cycles,
and rejects `fan_out`, `fan_in`, and `agent_loop` until their durable semantics are complete. This
is an intentional publication-time containment rule. The direct executor still contains bounded
fan-out and loop test seams so those semantics can be developed without making them available to
production agent versions.

Supported execution records validate state at the initial, intermediate, resumed, and final
boundaries. Node completion and pause checkpoints include state, trace, usage, next-node identity,
and an idempotency key. Fan-out test execution merges branch deltas and rejects conflicting
overlapping writes.

## Budgets and cancellation

Every hosted run initializes one durable budget ledger. Model work reserves estimated capacity and
settles it with provider usage or releases it on provider failure. Tool execution consumes an
atomic tool allowance. The same limits are passed to normal loops and configured graph execution,
including model calls inside graph nodes. MCP tool runs use the tool allowance as well.

Temporal activities use bounded schedule/start-to-close and heartbeat timeouts. The current loop,
model, and tool adapters receive an abort signal where supported. External effects retain durable
approval and receipt records; if a provider outcome cannot be proven, the effect remains eligible
for reconciliation rather than being treated as reversed.

The run budget ledger follows the same fail-closed rule. A worker timeout can leave a model
reservation in `unknown`; reconciliation releases the estimate only as a ledger operation and does
not claim that the provider did not execute the request. An operator or provider lookup must later
resolve the reservation as captured with actual usage or released with a reason. A captured
reservation cannot be silently reused by a retry.

## Known boundary

The current `executeLoop` activity still encloses more than one logical model/tool operation. The
run ledger prevents a retry from bypassing configured capacity, but a captured model reservation
does not yet persist the provider response itself. Splitting model, tool, checkpoint, and completion
work into independently retry-safe Temporal activities remains P0.3 work.
