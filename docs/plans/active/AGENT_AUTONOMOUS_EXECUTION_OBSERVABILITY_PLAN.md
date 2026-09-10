---
id: agent-autonomous-execution-observability
title: Autonomous agent execution observability
sidebar_label: Autonomous execution observability
slug: /autonomous-execution-observability
description: Runtime-owned execution stages and real-time graph observability for autonomous agents.
---

# Autonomous Agent Execution Observability

**Status:** In progress; autonomous-first observability seam implemented; guided verification and handoff continuation remain open

**Owner:** Agent Platform and Studio

**Last updated:** 2026-09-10

**Risk:** High

**Related plans:** [`Agent Playground and Execution Observatory`](./AGENT_PLATFORM_EXECUTION_OBSERVATORY_AND_CONTROL_PLANE_PLAN.md), [`Studio runtime observatory and promotion update`](./AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md), [`Hermes-aligned runtime reliability`](./AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md)

## Objective

Make the Studio graph a truthful, real-time view of an autonomous agent run.

An autonomous agent receives an input, builds context, reasons with its model, chooses and uses
capabilities when needed, may repeat that loop, and produces a result. The graph must show those
actual runtime transitions while they happen. It must identify the exact stage that is active,
completed, waiting, or failed without reconstructing execution from browser heuristics.

Success means that a user can send one message and answer, from the graph alone:

- which runtime stage is active now;
- which capability was selected and whether it completed;
- whether a stage ran repeatedly or concurrently;
- which exact stage failed and why; and
- whether the displayed state came from the current run or from a replayed durable event.

This plan is for autonomous agents first. Guided customer-support agents, deterministic workflow
agents, and specialist-agent delegation are later execution modes and must not shape the autonomous
core prematurely. The correct architectural relationship between autonomous execution and human
handoff is deliberately left open below; it requires a product and runtime decision before either
side is changed.

## Research findings and architectural conclusion

Waku and n8n use the same essential pattern:

- the runtime owns the executable topology and its stable node identities;
- lifecycle events identify node start, completion, failure, routing, and terminal state;
- the UI keeps one topology mounted and overlays live execution state on it;
- repeated visits are operation instances, not new topology nodes; and
- the live stream and historical execution view consume the same ordered evidence.

References: [Waku graph runtime](/home/enoch/aworkspace/agents/waku-agent/waku/ops/static/js/graph.js),
[Waku graph design](/home/enoch/aworkspace/agents/waku-agent/docs/agent-graphs-design.md),
[n8n lifecycle hooks](https://github.com/n8n-io/n8n/blob/master/packages/cli/src/execution-lifecycle/execution-lifecycle-hooks.ts),
[n8n editor event handling](https://github.com/n8n-io/n8n/blob/master/packages/frontend/editor-ui/src/app/components/WorkflowCanvasHostBody.vue),
and [n8n execution records](https://github.com/n8n-io/n8n/blob/master/packages/frontend/editor-ui/src/features/execution/executions/executions.types.ts).

The current KasiTek implementation does not yet have that contract. It has a conceptual Studio
graph, generic journal items, browser-side event classification, and a final timeline projection.
Those pieces cannot reliably tell the UI which node executed. Patching the projection alone will
continue producing a graph that looks plausible but is not evidence of the actual path.

The correct seam is:

```text
Autonomous AgentHarness runtime
        ↓
Stable execution-stage lifecycle events
        ↓
Durable journal (source of truth)
        ↓
SSE delivery and cursor replay
        ↓
Frontend execution reducer
        ↓
Persistent topology with live state overlay
```

The graph and the activity receipt are two projections of the same run evidence. Neither creates
or infers execution.

## Domain decision: autonomous execution versus handoff

The existing handoff tables and APIs represent a customer-support ownership transition: a
conversation can move from agent ownership to human ownership, with states such as pending,
claimed, resolved, expired, and cancelled. Handoff is an optional feature that an agent may or may
not have. It is not a separate runtime and it is not a mandatory stage in the autonomous graph.

The agreed architecture is:

- all agent types use the same shared `AgentHarness`, capability runtime, journal, and durable run
  machinery;
- the agent's explicit execution mode determines how work is orchestrated: autonomous now, with
  guided and workflow modes added deliberately later;
- the agent's audience and policy determine which capabilities are available;
- customer-service agents may receive the handoff capability and its conversation-ownership
  policy; personal agents do not receive it; and
- the graph renders handoff only when the effective agent configuration enables it and a typed,
  correlated handoff event actually occurs.

Handoff therefore has two layers that must remain connected but separate:

1. an optional capability/policy that an eligible agent can invoke; and
2. a conversation-ownership state machine that records offers, consent, requests, claims, human
   responses, resolution, expiry, cancellation, and return to the agent.

The exact run continuation behavior remains an implementation detail to define at the handoff
seam: a handoff may pause a run, finish the current turn and let the conversation controller own
the next turn, or resume a durable run after a human event. That choice must be explicit in the
typed contract, but it does not change the decision that handoff is optional agent capability.

The implementation must not:

- create a separate handoff runtime;
- silently remove the existing handoff tables or APIs;
- permanently add Handoff to every autonomous topology;
- map any event containing `handoff` to an autonomous stage by string matching;
- treat a model/tool failure as a handoff; or
- grant handoff to an agent merely because it serves a customer-facing channel.

Agent-to-agent delegation is also a separate future capability and must not be conflated with human
handoff.

## Execution model

### Stable topology

The runtime exposes a stable topology for the selected autonomous agent version. The initial core
contains only stages that are part of the autonomous harness contract:

```text
input → session → context → model → response → delivery
```

The following are optional runtime stages and appear when configured or actually available:

- memory read/write;
- retrieval or knowledge lookup;
- capability selection/routing;
- tools, connectors, skills, and MCP servers;
- approval checkpoints required by policy; and
- child-agent/delegation execution when that future capability is explicitly enabled.

Optional does not mean invisible. It means the topology is derived from the effective agent
configuration and runtime stage descriptors instead of being hard-coded as a mandatory path.

Persistence and journal writing remain infrastructure evidence. They should not be presented as
ordinary reasoning stages unless the runtime explicitly exposes them as an inspectable operation.

## Visual node contract

Nodes must communicate useful execution facts without turning the graph into a raw event dump.
The graph is the primary live view; the selected-node inspector and operation receipt carry the
complete detail.

### Information hierarchy

At normal zoom, a node shows:

- icon and stable stage name;
- current execution state;
- live elapsed time while running;
- provider/model or capability name when relevant; and
- occurrence or attempt count when the stage repeats.

Selecting a node exposes the full operation record: operation ID, attempt ID, parent operation,
duration, bounded redacted detail, error code, approval state, effect receipt, reconciliation
state, and related evidence.

### Three independent signals

The visual state must keep these concerns distinct:

1. **Availability:** declared, ready, blocked, or unavailable.
2. **Execution:** idle, queued, running, waiting, complete, failed, or skipped.
3. **Evidence:** occurrence count, duration, attempt, output/receipt state, and error.

`ready` must not look identical to `complete`. A capability can be available but not yet used.

### Stage-specific facts

- Input shows a bounded message preview, admission state, and turn number.
- Session shows conversation/turn state and session-lease contention when relevant.
- Context shows source count, estimated tokens, compaction, and context outcome.
- Memory shows read/write direction, namespace/category, evidence count, and revision count.
- Retrieval shows source, result count, query outcome, and latency.
- Model shows provider/model, attempt, elapsed time, token usage, and finish reason.
- Router shows the selected capability or route and a typed route reason when available; it must
  never expose hidden chain-of-thought.
- Tools, connectors, skills, and MCP nodes show full capability name, provider, operation state,
  occurrence, attempt, duration, approval state, effect receipt, and bounded failure code.
- Response shows response-generation state and output format.
- Delivery shows channel, delivery attempt, provider receipt, retry, and reconciliation state.
- Handoff appears only when its optional feature is enabled and a typed handoff fact occurs; it is
  not a mandatory autonomous node.

### Live animation and causal edges

Following the Waku live-graph pattern:

- running nodes hold a visible active state for the complete operation duration;
- elapsed time updates while an operation is active;
- completed nodes briefly pulse and retain completed state;
- failed nodes remain visibly failed until the run overlay is reset; and
- waiting nodes show what they are waiting for.

Edges are driven by typed route/causation events, not merely by the status of either endpoint.
Selected routes animate directionally, completed routes become muted success state, failed routes
become red, waiting routes become amber, and unrelated edges remain neutral.

### Repeats, concurrency, and dynamic nodes

Repeated visits remain attached to one stable node and show an occurrence count. The operation
receipt records every occurrence. Concurrent operations may light multiple stable nodes at once;
wave/timing cards are shown only when the runtime supplies reliable parent or parallel metadata.

The graph includes only:

- core autonomous stages;
- capabilities configured for the selected agent version and installation;
- explicit child-agent stages when configured; and
- unresolved runtime capabilities when the backend explicitly reports them.

It must not display every directory connection, arbitrary event string, or a new topology node for
each loop iteration.

### Runtime operation instances

The topology remains stable while individual runs produce operation instances:

```text
{
  runId,
  stageId: "context",
  operationId,
  attemptId,
  parentOperationId,
  occurrence: 3,
  status: "completed",
  startedAt,
  finishedAt,
  durationMs
}
```

If Context executes five times, the graph keeps one Context node, displays an occurrence count,
and exposes five ordered operation records in the inspector/activity receipt.

## Runtime event contract

The runtime must emit typed lifecycle events through the existing journal and stream. The browser
must not infer lifecycle state from event-name substrings.

Minimum events:

```text
run.admitted
stage.started
stage.completed
stage.failed
stage.waiting
stage.skipped
route.selected
run.completed
run.failed
```

Each stage event must carry:

```text
{
  eventId,
  cursor,
  runId,
  stageId,
  operationId,
  attemptId,
  parentOperationId,
  occurrence,
  status,
  occurredAt,
  startedAt,
  finishedAt,
  durationMs,
  error
}
```

Capability events must additionally identify the selected capability:

```text
{
  capabilityId,
  capabilityKind,
  capabilityName,
  configured
}
```

An observed capability missing from the effective configuration is shown as an explicit unresolved
runtime capability. It must never silently become a configured node.

## Implementation plan

### Phase 0 — Establish the domain boundary

- [x] Record autonomous execution as the only primary Studio runtime mode in this slice.
- [ ] Inventory the existing handoff schema, queue, consent, ownership, run, and resume semantics.
- [x] Decide that Handoff is an optional capability and policy attached to eligible agents, not a
      separate runtime or mandatory autonomous stage.
- [x] Preserve the existing customer-support handoff schema, queue, consent, and ownership APIs
      while the typed runtime/ownership continuation contract is implemented.
- [x] Inspect the current uncommitted Studio experiment and discard only the heuristic runtime-node
      changes; preserve the other agent's unrelated work.

### Phase 1 — Define the deep runtime observability interface

- [x] Define `ExecutionStageDescriptor`, `ExecutionTopology`, `ExecutionOperation`, and
      `ExecutionStageEvent` at the backend/frontend seam.
- [x] Assign stable stage IDs to autonomous harness boundaries.
- [x] Define lifecycle invariants, cursor ordering, idempotency, causation, parent operation links,
      redaction, and terminal-state rules.
- [x] Keep the interface small: the runtime emits typed facts; the frontend consumes a projected
      topology and ordered events.
- [x] Record which stages are core, optional, capability-backed, infrastructure-only, or future
      extensions.

### Phase 2 — Emit lifecycle facts from the autonomous runtime

- [x] Add stage identity at run admission, session creation, context assembly, model attempts,
      capability selection/execution, response formation, and delivery boundaries.
- [x] Emit start and terminal events from the runtime boundary that actually owns each operation.
- [ ] Include retry/attempt and parent-operation identity for repeated, nested, or concurrent work.
- [x] Emit explicit failure codes and bounded redacted details.
- [x] Do not add a second event stream; append to the existing durable journal and expose through
      the existing SSE/replay mechanism.

### Phase 3 — Build the authoritative projection

- [x] Project configured topology, active operations, completed operations, failed operations,
      waiting operations, selected routes, terminal outcome, and cursor metadata.
- [x] Make replay, reconnect, duplicate suppression, and out-of-order protection explicit.
- [x] Make the final timeline response reconciliation data rather than a replacement for live state.
- [x] Preserve unresolved capability evidence and distinguish `configured` from `observed`.

### Phase 4 — Replace browser heuristics with a reducer

- [x] Replace string-based `TraceNode` status inference with a deterministic execution reducer.
- [x] Keep topology state separate from operation-instance state.
- [x] Use optimistic Input only as `pending`; let `run.admitted` confirm the real execution state.
- [x] Keep active stages active until their own terminal event arrives.
- [x] Merge stream replay and final snapshots by durable event identity and cursor.
- [x] Auto-select the exact failed stage and retain its bounded error evidence.

### Phase 5 — Make the graph the primary live execution surface

- [x] Keep the configured autonomous topology mounted before, during, and after a run.
- [x] Remove graph-mode selectors and manual graph Run buttons.
- [x] Hold an active animation on the exact running node and highlight its causal route.
- [ ] Pulse completed nodes briefly while retaining their completed state.
- [x] Keep repeated operations on one stable node with occurrence counts.
- [x] Add capability nodes only from explicit configured or unresolved runtime descriptors.
- [x] Show the exact failed node in red with an error badge and inspector selection.
- [x] Separate availability state from execution state so `ready` and `complete` are visually
      distinct.
- [ ] Show stage-specific live facts such as elapsed time, provider/model, capability operation,
      attempt, receipt, and bounded error details.
- [x] Drive edge animation from typed route/causation events rather than endpoint status alone.
- [x] Keep hidden chain-of-thought out of the graph; expose only typed route and policy facts.

### Phase 6 — Recast the activity panel

- [x] Make the lower panel a compact operation receipt, not a competing raw journal timeline.
- [ ] Show active, completed, waiting, and failed operation instances with duration and occurrence.
- [ ] Group concurrent work only when the runtime supplies reliable causal/parallel metadata.
- [x] Keep the graph as the primary answer to “what is happening now?”

### Phase 7 — Resolve and implement the handoff architecture

- [x] Use the shared runtime for autonomous, guided, and workflow agents; vary orchestration and
      effective capability policy rather than cloning runtimes.
- [x] Make handoff an optional customer-service capability/policy rather than a base autonomous
      stage or a separate runtime.
- [ ] Decide and document the ownership, run-status, resume, cancellation, and graph semantics at
      the handoff seam.
- [ ] Define typed handoff events and correlation rules if handoff is included in the observatory.
- [ ] Keep autonomous execution, guided customer support, and agent-to-agent delegation distinct
      unless an explicit product decision joins them.
- [ ] Implement only the approved handoff contract after the decision is recorded.

## Expected result

Before a run, the user sees the autonomous agent's configured and optional runtime topology. No
node is falsely shown as having executed.

When the user sends a message, Input becomes pending immediately, then becomes active when the
backend admits the run. Context, Model, and selected capabilities light up from actual lifecycle
events. If Context repeats, one node shows the count while the receipt exposes each operation.

If a capability fails, that exact capability node becomes red, its incoming route reflects the
failure, and the inspector shows the operation, attempt, and bounded error. The user does not have
to infer the failure from a generic “request failed” banner.

Handoff is available only when the selected agent's effective policy grants it. When enabled, the
agent uses the same runtime and invokes the handoff capability through the normal capability seam;
the conversation-ownership controller then records and enforces the human transition. When it is
not enabled, the agent cannot call it and the graph does not show it as an available autonomous
stage.

The remaining handoff work is to define the typed run/ownership correlation and continuation
semantics. The graph must not show a handoff state unless a typed, correlated handoff fact actually
occurred.

## Self-review and non-negotiable failure conditions

This plan is invalid if stable runtime stage identity cannot be emitted. In that case, the first
implementation must stop at the backend seam; additional UI work would only create another
plausible but inaccurate graph.

The implementation must not:

- create graph nodes from arbitrary event strings;
- infer execution from chat messages or final response text;
- treat the conceptual graph as proof that a stage ran;
- create a new topology node for every loop occurrence;
- mark all active nodes complete when one event arrives;
- use Handoff as a generic failure or escalation node before its contract is decided;
- claim parallel waves without runtime parallel metadata; or
- let the customer-support queue become a dependency of autonomous execution.

The key architectural test is deletion: if the frontend reducer were removed, the runtime journal
would still contain the complete execution evidence. If the graph were removed, the autonomous
runtime would still execute correctly. That separation is what makes the observatory trustworthy.

## Verification

- [ ] Backend contract tests prove stable stage IDs and lifecycle ordering.
- [ ] Projection tests prove replay, duplicate suppression, reconnect, and terminal reconciliation.
- [ ] Reducer tests cover admission, repeated context, capability success, capability failure,
      concurrent operations, unresolved capabilities, and stale events.
- [ ] Visual verification covers active elapsed time, completed pulse, failed-node persistence,
      distinct ready/complete states, exact causal edge highlighting, repeated-stage counts, and
      scoped dynamic capability nodes.
- [ ] Manual run proves Input activation, exact tool activation, exact failure selection, and no
      handoff node during ordinary autonomous execution.
- [ ] Manual compatibility check proves existing customer-support handoff records and queue APIs
      remain unaffected.
- [x] Run client lint/typecheck and targeted backend checks.
- [ ] Run the production build if no unrelated build lock is active; do not kill another agent's
      process to force it.

## Release record

```text
Change: Autonomous execution lifecycle contract and real-time Studio observability
Owner: Agent Platform and Studio
Risk: high
Affected services and user surfaces: AgentHarness/runtime, journal projection, SSE run stream, Studio graph, Studio operation inspector
Platform release version or release ID: to be assigned at release
API/schema/migration changes: Prefer additive journal/projection contract changes; database migration not applicable unless existing persistence requires materialized stage columns
Feature flag or rollout method: Decide before implementation; use a narrow observatory rollout if compatibility requires it
Analytics events and success metrics: Product analytics not applicable; operational execution metrics are required
Logs, metrics, dashboards, and alerts: Structured lifecycle logs with run/stage/operation IDs, redacted errors, event lag, dropped/replayed events, and stream reconnect counts
User, API, internal, and operational documentation: Update this plan and the current Studio/runtime documentation; document the autonomous-versus-handoff boundary
Validation evidence: Contract tests, projection/reducer tests, client checks, backend checks, and guided manual runs
Rollback or disable plan: Disable the new observatory projection/reducer behind the rollout control and fall back to the prior compatible run view; runtime execution must continue independently
Post-release review date: to be assigned at release
```

## Open decisions before implementation

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Autonomous base topology | Use only real harness stages as core; optional capabilities are descriptors, not mandatory path nodes | Agent Platform and Studio | Decided |
| Human handoff availability | Optional capability and policy for eligible agents; not a separate runtime or mandatory autonomous stage | Product and Agent Platform | Decided |
| Human handoff continuation | Decide whether the current run pauses, ends the turn, or resumes after a human event | Product and Agent Platform | Open |
| Agent-to-agent delegation | Separate future capability, not human handoff | Agent Platform | Decided |
| Runtime stage IDs | Must be emitted by the runtime adapter, never guessed in React | Agent Platform | Decided |
| Parallel waves | Implement only after reliable parent/parallel metadata exists | Agent Platform and Studio | Deferred |
| Rollout control | Select the existing compatible feature-control mechanism before implementation | Platform Ops | Open |
