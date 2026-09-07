---
id: agent-platform-hermes-aligned-runtime-reliability
title: Second implementation chunk · Hermes-aligned runtime reliability
sidebar_label: Second chunk · Hermes-aligned runtime
slug: /hermes-aligned-runtime-reliability
description: Second Agent Platform implementation chunk for adopting Hermes-inspired runtime reliability patterns across context, loops, tools, durability, graphs, observability, and future multi-agent execution.
---

# Agent Platform Hermes-Aligned Runtime Reliability

**Status:** In progress; local implementation pass substantially complete, infrastructure certification pending

**Owner:** Agent Platform

**Last updated:** 2026-09-07

**Depends on:** [`Agent Platform Host Boundary and Runtime Restructure`](./AGENT_PLATFORM_HOST_BOUNDARY_RESTRUCTURE_PLAN.md)

**Canonical plan:** [`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](../agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md)

**Related research:** `docs/plans/agents/AGENT_HERMES_ARCHITECTURE_RESEARCH.md`

**Mapped packages:** P01, P03, P05, P08, P09, P09B, P10, P14

## Objective

Use the host-neutral structure from the first implementation chunk to establish a reliable,
Hermes-aligned agent harness for KasiTek.

This chunk adopts Hermes' runtime patterns and invariants. It does not add Hermes as a production
dependency, replace Temporal, copy Hermes' local storage model, or reproduce its implementation.
KasiTek keeps its own tenancy, authorization, PostgreSQL evidence, provider adapters, approvals,
Temporal workflows, and release controls.

The target is a deep `AgentHarness` module: callers provide a small set of typed dependencies and
receive a durable, observable turn result. Context policy, tool execution, recovery, and event
emission remain behind the harness interface instead of being reimplemented by channels, hosts,
Temporal activities, graph nodes, or future tenant integrations.

## Why this is the second chunk

The first chunk creates the seam between Agent Platform and its hosts. That seam is necessary but
not sufficient. Without a reliable runtime contract behind it, we would only make the existing
failure modes easier to reuse:

- long conversations would still send oversized or poorly selected context;
- token budgets would still be calculated by different callers;
- tool results would still consume the next model request;
- ordinary loops and configured graphs could still have different retry and approval semantics;
- a completed run could still be confused with a delivered message;
- operator views could still reconstruct state from incomplete or unrelated records;
- future child agents could still copy full transcripts into parent context.

Hermes provides a useful reference for solving these problems through one shared runtime. This
chunk adapts that shape to KasiTek's durable and multi-tenant requirements before we add more agent
features.

## Adoption rule

We adopt behavior, interfaces, and invariants. We adapt implementations to KasiTek. We do not copy
infrastructure or assume Hermes' trust model.

| Hermes pattern | KasiTek adoption | Deliberately not copied |
| --- | --- | --- |
| Shared `AIAgent` runtime behind many entry points | One `AgentHarness` used by Core, tenant hosts, channels, REST, MCP, scheduled work, and child invocations | Hermes' process-local runtime as our production execution layer |
| Context engine and cache-aware compaction | A policy-driven context module with durable evidence, bounded projections, provenance, and provider-aware budgets | Hermes' local SQLite and model/provider assumptions |
| Central tool registry and toolsets | Versioned capability catalog with grants, readiness, approval, idempotency, receipts, and redaction | An unrestricted plugin registry as our authorization model |
| Tool-round persistence and safe parallel dispatch | Persist-before-effect, explicit barriers, typed outcomes, and parallel-safe capability metadata | Blind concurrency or retries around completed effects |
| Runtime callbacks and progress events | Canonical durable execution journal, projections, cursor replay, and live subscriptions | Process-local callbacks as the source of truth |
| Delivery ledger | PostgreSQL/Temporal-backed delivery outbox with reconciliation and channel receipts | Process-local delivery assumptions |
| Fresh-context delegated agents | Versioned child invocations with bounded context, attenuated authority, typed results, and Temporal durability | Open-ended swarm behavior |
| Skills, plugins, and MCP at the edges | A customer-facing extension model for installing versioned skills, plugins, connectors, and MCP configurations through the harness | Moving tenant business policy or arbitrary plugin code into shared workers |

## Standing Hermes reference discipline

`/home/enoch/aworkspace/agents/hermes-agent` is a standing architecture reference for this chunk,
not a one-time research source. The team should
refresh against the repository throughout implementation, especially before starting and completing
each workstream.

For every Hermes-aligned change:

1. Identify the equivalent Hermes module, contract, lifecycle, tests, and failure behavior.
2. Record the KasiTek decision as **adopt**, **adapt**, or **reject**, with the reason.
3. Adapt the behavior to KasiTek's tenant isolation, Temporal durability, PostgreSQL evidence,
   approvals, channels, and hosted security model.
4. Implement behavior and conformance tests rather than copying Hermes code or storage.
5. Capture the Hermes repository revision or review date in the implementation record so the
   comparison is reproducible.
6. Recheck the decision before exit criteria are marked complete, including any Hermes changes
   discovered during the work.

This discipline applies to the harness, skills, plugins, tools, MCP, context loading, loops,
delegation, durability, observability, and multi-agent workstreams.

**Implementation reference:** Hermes revision `9a84bee265daad14340a80d7585928cd8ea1f9eb`, reviewed
2026-09-07. The current pass specifically used its context lifecycle, single conversation loop,
narrow capability boundary, fresh child scope, and durable evidence patterns as comparison points.

## Target harness shape

```text
Channel / API / host adapter
             |
             v
      Interaction admission
             |
             v
        AgentHarness
             |
    +--------+---------+----------------+
    |                  |                |
 ContextPolicy   ModelGateway   CapabilityRuntime
    |                  |                |
    +--------+---------+----------------+
             |
       OperationCoordinator
             |
    +--------+---------+----------------+
    |                  |                |
 ExecutionJournal  DeliveryOutbox   ChildInvocation
```

The harness interface should express the lifecycle rather than expose internal implementation
steps. The exact types remain an open design decision, but the contract must cover:

```text
admitTurn(request) -> accepted | queued | rejected
runTurn(input, dependencies) -> completed | waiting | limited | failed
resumeTurn(input, decisionOrEvent) -> completed | waiting | limited | failed
inspectRun(runId, cursor) -> ordered execution evidence
cancelRun(runId, reason) -> acknowledged state transition
```

Temporal owns waiting, retries, signals, cancellation, child-workflow lifetime, and durable
checkpoints. The harness owns one bounded reasoning/tool turn and returns explicit typed outcomes.
The harness must not construct database, Core, provider, or telemetry clients internally.

## One agent runtime model and information containment

This section defines what one logical agent means in KasiTek and how the same model scales across
KasiAI, Core-owned agents, tenant agents, and customer-created agents.

### One logical agent

An agent is a versioned configuration executed by the shared harness. It is not a separate process,
worker, or custom runtime implementation.

```text
Agent definition
  → immutable agent version
      ├─ instructions and model policy
      ├─ skills
      ├─ plugins
      ├─ tools, connectors, and MCP configuration
      ├─ knowledge and memory policy
      ├─ channels
      └─ limits and approvals
          ↓
Installation
  ├─ organization, user, or business scope
  ├─ credential bindings
  ├─ resource grants
  └─ enabled extensions
          ↓
Session or conversation
          ↓
Durable run
  ├─ pinned agent version
  ├─ pinned extension snapshot
  ├─ bounded context decisions
  ├─ model and tool operations
  └─ events, receipts, and delivery obligations
```

Many agent versions, installations, and sessions use the same harness and worker fleet. Temporal
owns durable waiting, retries, cancellation, and workflow lifetime. PostgreSQL owns durable agent
configuration, installation scope, grants, evidence, receipts, and projections.

### Canonical execution scope

Every harness operation must receive or derive one explicit, immutable execution scope. The model
must never be able to select a scope by putting identifiers in tool arguments.

```text
ExecutionScope
  ├─ organizationId
  ├─ installationId
  ├─ agentDefinitionId
  ├─ agentVersionId
  ├─ sessionId / conversationId
  ├─ runId
  ├─ actorId and actor type
  ├─ extensionSnapshotId
  ├─ resource and connector grants
  ├─ policy, approval, and budget limits
  └─ correlation and causation identifiers
```

The scope is attached to context retrieval, memory reads and writes, knowledge retrieval, tool
authorization, connector resolution, MCP calls, event writes, delivery, analytics, operator
projections, and child invocations. Adapters may narrow the scope, but may not broaden it.

### Information containment rules

- Agent instructions and policy come from the pinned agent version.
- Installation settings and credentials are installation-scoped; secrets are never placed in model
  context and only opaque credential references cross the harness seam.
- Conversation messages belong to one installation and conversation.
- Working context is assembled for one turn and is not automatically shared with another agent or
  session.
- Memory namespaces are explicit: conversation, user-private, organization-shared, and agent-
  private. Read and write permissions are separate.
- Knowledge sources are selected and filtered by organization, installation, agent version, and
  source grant before retrieval.
- Full tool output remains durable for audit where permitted; the model receives a bounded,
  redacted projection.
- Platform extensions may be visible to multiple agents, but their capabilities and data access
  remain governed by each installation's grants.
- Child agents receive attenuated authority and bounded context, not the parent's full transcript
  or unrestricted capability set.
- Operator and visualization projections apply the same organization, installation, role, and
  retention rules as the underlying evidence.

### Version and run pinning

Publishing or changing an agent, skill, plugin, connector, or MCP provider must not mutate an
active run. Before a run begins, the harness resolves an immutable extension snapshot containing:

- exact agent, skill, plugin, tool, connector, and MCP versions;
- effective grants and resource constraints;
- model, context, memory, channel, approval, and budget policy;
- credential and provider bindings by opaque reference;
- compatibility and readiness decisions; and
- a checksum and provenance record.

New runs resolve the currently published installation configuration. Existing runs continue with
their pinned snapshot unless an explicit durable migration or cancellation policy says otherwise.
Revocation prevents new admissions and produces a typed state for affected waiting or active work;
it does not silently rewrite historical evidence.

### Session and concurrency model

The harness is horizontally scalable, but concurrency is scoped deliberately:

- different installations and sessions may execute in parallel;
- the same session or conversation has an explicit serialization or queueing policy;
- independent child invocations may run in parallel within parent limits;
- installation, organization, provider, and platform budgets provide backpressure;
- a concurrency decision is recorded as accepted, queued, limited, or rejected with a reason; and
- no worker remains occupied while a run waits on approval, a human, an external event, or a
  delivery retry.

The current active-run guard is an interim safety mechanism. The implementation chunk must decide
and verify the durable session queue/serialization behavior rather than treating `409 active run`
as the final user-facing concurrency model.

### Required acceptance tests

The runtime model is not complete until these cases pass:

| Scenario | Required evidence |
| --- | --- |
| Two agents in one organization run concurrently | Each run sees only its own installation, extension snapshot, memory, knowledge, and grants |
| One agent has two sessions | Sessions can progress independently; same-session ordering follows the declared queue/serialization policy |
| Plugin or skill changes during a run | The active run continues with its original snapshot; a new run uses the new published version |
| Credential or connector revoked | New admissions are denied or limited with a typed reason; no secret enters context or event payloads |
| Worker restarts during a tool operation | The run resumes from its durable operation state without duplicating a confirmed effect |
| Child agent is invoked | Child scope is visible, bounded, attenuated, and linked to the parent without copying the full transcript |
| Cross-tenant or cross-installation lookup is attempted | Authorization and storage policies reject it before data reaches the model |
| Live execution view reconnects | The same scoped event stream rebuilds without exposing another run or tenant |

## Scope

### Included

- A canonical harness interface and composition root built on the first host seam.
- A replaceable context policy with budget accounting, compaction, retrieval, and provenance.
- One consistent loop contract for ordinary agents, model/tool rounds, and graph nodes.
- A capability/tool runtime with typed readiness, authorization, approval, execution, and result
  projection.
- Durable operation checkpoints and replay rules around model, tool, provider, human, and delivery
  boundaries.
- A canonical execution event model that powers runtime callbacks, projections, and the visual
  execution trace.
- A durable delivery-obligation seam separate from agent-run completion.
- A versioned child-invocation contract that prepares for multi-agent execution without enabling an
  unrestricted swarm.
- Failure-injection, context-pressure, tool-replay, event-replay, tenant-isolation, and manual
  verification evidence.

### Excluded

- Adding Hermes as a runtime or hosted third-party dependency.
- Replacing Temporal with Restate or another durable execution layer.
- Implementing every memory, retrieval, or compaction strategy in one change.
- Enabling unrestricted customer-configured multi-agent swarms.
- Building a default n8n-style workflow editor for ordinary agents.
- Making every capability parallel-safe before its effect and resource semantics are declared.
- Migrating every existing tool, channel, or publishing path before the harness contracts are
  verified.
- Treating a passing happy-path demo as evidence of runtime reliability.

## Hermes-aligned workstreams

### 1. Harness composition and runtime ownership

**Purpose:** Ensure every entry point uses one deep runtime module rather than a separate loop.

**Adopt:** Hermes' narrow waist: channels and hosts adapt inputs and outputs; the shared runtime
owns the agent turn.

**KasiTek adaptation:** The harness receives host capability adapters, model adapters, repositories,
operation coordination, and event sinks through its composition root. Temporal wraps the harness;
it does not become a second harness implementation.

**Required outcomes:**

- Web, messaging, REST, MCP, scheduled runs, and tenant-host calls reach the same harness contract.
- The bounded loop, decomposed loop, and configured graph path either share the same harness or have
  an explicit reason and compatibility contract for their difference.
- Protocol handlers do not decide retry vocabulary, context policy, tool authorization, or delivery
  state.
- The harness returns typed terminal and waiting states instead of caller-specific strings.

**Verification:** A Core-hosted run, hostless/native run, and tenant-host fixture produce equivalent
harness states, event types, tool outcomes, and failure classifications.

### 2. Context engine and token reliability

**Purpose:** Prevent context growth and large tool results from repeatedly breaking model calls.

**Adopt:** Hermes' separation of durable transcript, working context, persistent memory, retrieved
history, and compressed summaries. Keep stable prompt content cache-aware and treat compaction as a
controlled runtime operation.

**KasiTek adaptation:** The context policy consumes tenant-scoped evidence and returns a bounded
model request projection:

```text
durable messages + summaries + memory + retrieval + run state
                              |
                       ContextPolicy
                              |
                              v
model messages + tools + limits + omissions + provenance
```

**Required outcomes:**

- One budget ledger covers system instructions, tool schemas, input messages, tool results, output
  tokens, total tokens, credits, and wall time.
- Full tool output remains available for audit and operator inspection, while the model receives a
  bounded projection.
- Recent turns and valid assistant/tool-call pairs are protected during compaction.
- Summaries are explicitly marked as reference context and never silently become active user
  instructions.
- Retrieval, knowledge, and memory selections include bounded provenance.
- Provider context overflow produces a typed recovery path instead of repeated doomed requests.
- Context omissions and compaction are visible in the execution journal.

**Verification:** Run long conversations, oversized tool results, large tool schemas, multilingual
messages, provider overflow responses, summary failure, and compaction timeout. Confirm that the
full durable evidence remains inspectable and the model receives a bounded request.

### 3. One reasoning loop for ordinary agents and graph nodes

**Purpose:** Stop ordinary agents, decomposed execution, and configured graphs from developing
different reliability behavior.

**Adopt:** Hermes' explicit turn lifecycle and tool-round barrier: persist the model proposal,
execute eligible tools, persist results, then resume reasoning.

**KasiTek adaptation:** A graph node may control sequence, branch, wait, fan-in, approval, or
delegation, but model calls and capability calls use the same harness operation interfaces and the
same budgets, receipts, and events as a normal turn.

**Required outcomes:**

- Model response, tool proposal, tool execution, tool result, and next-turn transitions have one
  event vocabulary.
- A completed model call or external effect is not repeated because the surrounding reasoning loop
  was retried.
- Loop limits are explicit for iterations, tool calls, input/output tokens, credits, wall time,
  parallelism, and nested depth.
- Approval and human waits return durable waiting states rather than blocking a worker.
- Graph checkpoints resume the exact next node or harness continuation.

**Verification:** Compare a prompt-only agent, a tool-using agent, and a graph node that calls the
same tool. Their approval, retry, timeout, event, and terminal behavior must match.

### 4. Capability and tool runtime

**Purpose:** Reduce integration failures by giving every tool source one invocation contract.

**Adopt:** Hermes' central registry, capability selection, readiness checks, dynamic schemas, and
edge extensibility.

**KasiTek adaptation:** Capability admission must additionally enforce organization, installation,
resource, credential, approval, risk, and provider policy before invoking a handler.

**Required outcomes:**

- Built-in, Core, tenant, provider, MCP, test, and future sandbox tools use one manifest shape.
- Readiness is separate from authorization and execution.
- Tool results have durable, redacted, and model-facing projections.
- Every external effect has an idempotency key, receipt, timeout, unknown-outcome rule, and
  reconciliation path.
- Tool errors map to stable codes such as not configured, not granted, unsupported, retryable,
  approval required, timed out, canceled, failed, or unknown.
- Parallel execution is allowed only for capabilities that declare safe concurrency and resource
  behavior.

**Verification:** Run the same conformance suite against a native capability, Core adapter, tenant
adapter, remote MCP tool, and deterministic fake. Include malformed arguments, unavailable tools,
approval mismatch, duplicate invocation, timeout, cancellation, redaction, and provider uncertainty.

### 5. Durable execution and recovery

**Purpose:** Make retry and recovery preserve completed work instead of replaying whole agent loops.

**Adopt:** Hermes' persist-before-effect discipline and explicit interruption/recovery states.

**KasiTek adaptation:** Use Temporal for durable coordination and PostgreSQL for operation evidence,
receipts, projections, and reconciliation.

**Required outcomes:**

- Model calls, tools, provider effects, approvals, handoffs, and deliveries are separate bounded
  operations.
- Checkpoints are written before and after each external or human-controlled boundary.
- A worker loss can distinguish not started, in progress, completed, failed, and unknown.
- Confirmed effects replay from receipts; uncertain effects become reconciliation work.
- Cancellation respects effect state and never claims that an uncertain effect was undone.
- Parent budgets and deadlines are consumed by retries and child work rather than reset.

**Verification:** Kill workers before request submission, after submission, after receipt persistence,
after provider completion, during approval, during handoff, and during delivery. Confirm no duplicate
confirmed effect and no silent loss of an owed response.

### 6. Observability and execution visuals

**Purpose:** Make the harness inspectable while it runs and diagnosable after failure.

**Adopt:** Hermes' runtime progress callbacks and status events.

**KasiTek adaptation:** Callbacks are delivery mechanisms only. The authoritative source is a
tenant-scoped durable journal and outbox with ordered events, replay cursors, redaction, and
projection lag detection.

**Required outcomes:**

- Every run exposes model, context, tool, approval, wait, retry, provider, handoff, child, and
  delivery events.
- Events include run, session, organization, installation, agent version, parent invocation,
  operation, attempt, sequence, causation, deadline, release, and safe reason fields.
- The same event stream powers the API, timeline, graph, operator controls, analytics, and alerts.
- The UI distinguishes generated execution traces from authored workflow graphs.
- A disconnected UI can reconnect from a cursor without duplicating or skipping events.

**Verification:** Rebuild the timeline and graph from the journal after process restart, projection
lag, duplicate events, out-of-order delivery, and live-subscription reconnect. Confirm tenant and
role visibility for every projection.

### 7. Delivery and customer-visible reliability

**Purpose:** Stop run completion, handoff creation, and customer receipt from being treated as the
same state.

**Adopt:** Hermes' delivery-obligation ledger and honest handling of ambiguous sends.

**KasiTek adaptation:** Use the interaction and delivery contracts from P06/P07 with PostgreSQL,
Temporal waits, channel adapters, and provider receipts.

**Required outcomes:**

- Every outbound response, approval prompt, handoff acknowledgement, and follow-up creates a
  delivery obligation before sending.
- Delivery states include queued, sending, delivered, retrying, failed, unknown, and reconciled.
- A run can be completed while delivery remains pending or unknown.
- Customer-facing and operator-facing status use the same durable state.
- Duplicate-risk recovery is explicit and visible rather than silently sending the same message.

**Verification:** Simulate channel timeout, lost acknowledgement, provider reconnect, duplicate
webhook, worker loss, operator offline state, and delivery after a run has completed.

### 8. Custom-agent extension model: skills, plugins, connectors, and MCP

**Purpose:** Make custom agents easy to create by composing approved capabilities through one
standard extension model instead of exposing a long unmanaged tool list or requiring an n8n-style
workflow for ordinary agents.

**Adopt:** Hermes' narrow harness with skills, plugins, and MCP at the edges. Skills describe
reusable behavior; plugins package reusable capabilities; connectors provide authenticated external
access; MCP provides a standard external tool/data boundary.

**KasiTek adaptation:** A plugin is a versioned, inspectable package that can contain skills,
approved capability manifests, connector requirements, MCP configuration, compatibility metadata,
and optional UI metadata. It is not permission to execute arbitrary customer code inside a shared
worker.

The custom-agent composition surface must allow a user or tenant administrator to configure:

```text
Agent definition
  ├─ identity and instructions
  ├─ skills
  ├─ installed plugins
  ├─ connected accounts and connectors
  ├─ MCP servers and configuration
  ├─ knowledge and memory sources
  ├─ channels and delivery behavior
  └─ permissions, approvals, budgets, and limits
```

This extension model is generally available to every agent class, including KasiAI, Core-owned
agents, tenant agents, and customer-created agents. KasiAI should be an early internal consumer of
the same contracts so its platform capabilities are exercised in a real agent rather than through
special-case integrations.

General availability means that the harness, registries, lifecycle, snapshot format, and
observability are shared. It does not mean that every agent receives every capability. Each agent
gets an explicit extension set and grant policy:

```text
Platform extension catalog
        |
        +── KasiAI: selected platform skills, plugins, connectors, and MCP services
        +── Core agent: selected Core capabilities
        +── Tenant agent: tenant-approved capabilities and account bindings
        +── Customer agent: customer-installed and permitted extensions
```

An extension may therefore be available on the platform but not connected, configured, or granted
for a particular agent. The UI and runtime must distinguish **available**, **installed**,
**configured**, **granted**, **ready**, and **used** rather than treating all of them as one state.

**Required outcomes:**

- Skills, plugins, connectors, and MCP servers have stable identifiers, versions, ownership,
  compatibility, lifecycle status, and provenance.
- KasiAI and other internal agents consume the same extension APIs as tenant and customer agents;
  internal access is represented by normal platform-scoped grants rather than hidden code paths.
- Users can create or install a plugin, validate it, publish a version, enable it for a tenant or
  agent, disable it, revoke it, and roll back to a previous version.
- A plugin can bundle a skill with the connector and MCP configuration it needs, without granting
  those capabilities automatically to every agent.
- Plugin installation never bypasses tool grants, connector scopes, approvals, rate limits,
  tenant isolation, or the durable operation kernel.
- The harness resolves an agent definition into an immutable extension snapshot containing exact
  skill/plugin/tool/MCP versions, grants, connector bindings, policies, and budgets.
- Each run is pinned to its extension snapshot; changing a plugin does not change an active run.
- Context uses progressive disclosure: lightweight extension metadata is available for selection,
  while full skill instructions and large tool schemas are loaded only when relevant.
- The execution journal records which extension selected a skill, exposed a tool, supplied an MCP
  operation, or caused a connector call.
- The default customer experience is profile composition. Authored graphs remain optional and are
  reserved for explicit sequence, branching, parallelism, approval, compensation, or delegation.
- Executable plugin components, if supported later, run through an isolated service or sandbox
  contract with its own security and release controls; they do not run as arbitrary code in the
  shared worker.

**Minimum implementation vertical slice:** A tenant creates a customer-service agent, installs one
plugin containing a skill and connector requirement, configures one MCP server, grants the required
capabilities, publishes the agent version, runs it through a channel, and inspects the resolved
extension snapshot and execution trace. Disable, revoke, version update, missing connector,
insufficient grant, and MCP failure must all produce typed and visible outcomes.

**Verification:** Test plugin manifest validation, dependency and version resolution, install and
rollback, tenant and agent scoping, capability attenuation, connector readiness, MCP readiness,
progressive loading, context budgets, active-run pinning, revocation behavior, and execution-trace
provenance. Verify that a plugin cannot make an ungranted tool appear executable or move data across
tenant boundaries.

### 9. Agent definitions, graphs, and custom agents

**Purpose:** Give customers a simple harness-first agent while retaining typed graphs for cases that
actually require deterministic orchestration.

**Adopt:** Hermes' profile model: agent identity, instructions, tools, memory, skills, model policy,
and history are selected as one versioned profile.

**KasiTek adaptation:** Separate:

- agent definition;
- published agent version;
- tenant installation;
- host and credential bindings;
- run and invocation state.

The default custom-agent experience is a profile plus a registry of granted capabilities. The
execution visualization is generated automatically by the harness. An authored graph is optional
and reserved for explicit sequence, branch, parallelism, approval, compensation, or delegation
requirements.

**Verification:** A simple customer-service agent, a deterministic workflow agent, and a tool-rich
research agent all use the same harness and produce the same event vocabulary. Editing a definition
does not change an active run, and a published version remains reproducible.

### 10. Multi-agent runway

**Purpose:** Prepare for multi-agent orchestration without adding it as an uncontrolled second
runtime.

**Adopt:** Hermes' fresh-context child agents, focused tasks, bounded budgets, parent progress, and
typed summaries.

**KasiTek adaptation:** Child agents become version-pinned Temporal child invocations with their own
run IDs, context policy, capability grants, events, budgets, deadlines, and typed result. The parent
receives a result reference or summary, not the child's full transcript.

**Required outcomes:**

- Parent and child relationships are represented in the same invocation graph.
- Authority is attenuated; a child does not automatically inherit every parent capability.
- Child cancellation, timeout, failure, partial result, and budget exhaustion are typed outcomes.
- Fan-out and fan-in are bounded and observable.
- The initial implementation supports a deterministic fake child and one bounded production child
  path; unrestricted customer swarms remain out of scope.

**Verification:** Test child success, timeout, cancellation, worker loss, parent cancellation,
partial results, duplicate completion, budget exhaustion, and version mismatch.

## Implementation phases

### Phase 0 — Measure and freeze the contracts

- Capture current token failures, context sizes, tool-result sizes, loop paths, graph paths, delivery
  failures, and missing execution evidence.
- Define the harness result states, context decision record, capability outcome vocabulary, operation
  state vocabulary, event envelope, and delivery-obligation state machine.
- Pin the first supported interface versions and identify which existing callers must migrate.

### Phase 1 — Establish the harness seam

- Construct the harness at the API and worker composition roots.
- Inject model, context, capability, operation, event, delivery, and host adapters.
- Route one Core-hosted read-only vertical slice through the harness.
- Route one native/hostless capability through the same harness.
- Remove the migrated callers' direct construction of broad clients and runtime policy.

### Phase 2 — Implement custom-agent extensions

- Define and validate plugin, skill, connector, and MCP manifests and lifecycle states.
- Add tenant-scoped installation, enablement, disablement, revocation, and rollback records.
- Compile agent definitions into immutable extension snapshots with exact versions and grants.
- Implement progressive extension loading so full instructions and large schemas are not placed in
  every model request.
- Build the first plugin vertical slice with one skill, one connector, and one MCP configuration.
- Emit extension-resolution and extension-use events into the canonical execution journal.
- Verify the customer composition flow before expanding the plugin catalog or supporting executable
  plugin components.

### Phase 3 — Make context and model/tool turns reliable

- Replace fixed caller-level context assembly with the context-policy seam.
- Add unified budget accounting and bounded model-facing tool results.
- Add compaction, overflow recovery, pairing protection, and provenance records.
- Align ordinary loops and graph model/tool nodes with the same turn and operation contracts.

### Phase 4 — Make tools and effects replay-safe

- Normalize capability manifests and readiness outcomes.
- Add typed invocation, approval, timeout, retry, idempotency, receipt, and reconciliation behavior.
- Introduce parallel-safe capability metadata and a bounded scheduler for the first safe read-only
  batch.
- Keep external effects behind the durable operation kernel.

### Phase 5 — Make events and delivery authoritative

- Emit one canonical event stream from harness, operations, graphs, approvals, children, and delivery.
- Build the thin timeline and graph projections from that stream.
- Add delivery obligations and reconcile the first messaging and web delivery paths.
- Replace polling-only UI assumptions with cursor replay plus live subscription.

### Phase 6 — Prepare graph and child-agent execution

- Compile configured agents and authored workflows into one versioned specification.
- Make graph nodes call the harness and operation interfaces rather than private model/tool logic.
- Add a bounded child invocation contract and deterministic fake child.
- Enable one controlled Temporal child path only after parent/child failure tests pass.

## Implementation checklist

Tick an item only when the implementation, focused tests, and evidence path exist. A passing type
check or a UI screenshot alone does not prove a durable runtime contract.

### Harness and context foundation

- [x] Add an injected `ContextPolicy` seam to `AgentHarness` and preserve a compatibility adapter
  for existing callers. Evidence: `agents/src/runtime/harness.ts`, `agents/src/runtime/context.ts`,
  and `agents/test/context.test.ts`.
- [x] Route the hosted Temporal loop and configured-graph loop through `AgentHarness.runTurn`
  rather than calling the loop implementation directly. Evidence: `agents/src/temporal/activities.ts`.
- [x] Record context budget, omission, tool-schema selection, and typed context decisions in the
  existing run-step and event evidence. Evidence: `agent.context.built` and `agent.context.limited`.
- [x] Make decomposed execution consume the same harness turn and context contracts.
  Evidence: the independent decomposed executor was removed; every durable run now schedules the
  one `AgentRunActivities.executeLoop` path, which composes `AgentHarness`.
- [x] Define typed harness continuations for completed, waiting, limited, failed, cancelled, and
  reconciliation-required states. Evidence: `agents/src/runtime/continuation.ts` and
  `agents/test/harness-continuation.test.ts`; Temporal remains the owner of cancellation signals.
- [x] Remove raw caller-owned model/tool policy construction from harness turns. Evidence:
  `agents/src/runtime/execution-plan.ts` and `agents/src/runtime/harness.ts` now require one
  resolved, run-pinned `AgentExecutionPlan`; ordinary and graph turns layer only turn-specific
  hooks and continuation input on that plan. Provider/model policy resolution remains at the
  durable activity composition boundary by design.

### Context and loop reliability

- [x] Bound historical messages and model-visible tool schemas while retaining durable evidence
  outside model context. Evidence: `DefaultContextPolicy` contract tests.
- [x] Add protected assistant/tool-call pairing and durable compaction summaries. Evidence:
  `agents/src/runtime/message-context.ts` and `agents/test/message-context.test.ts`; full durable
  run evidence remains outside the bounded model projection.
- [x] Add provider overflow recovery that compacts or limits once without retrying a doomed request.
  Evidence: context is bounded before dispatch and `runBoundedAgentLoop` turns a provider
  context-overflow response into one typed limited result with no adapter retry or fallback;
  `agents/test/context-overflow-recovery.test.ts` verifies the behavior.
- [x] Unify the budget ledger across context, model calls, tools, credits, wall time, graph work,
  and child work. Evidence: `agents/src/runtime/budget.ts` and `agents/test/budget.test.ts`; the
  ledger is the shared typed admission seam, while durable credit settlement remains in the
  existing run-budget repository.
- [x] Prove ordinary and decomposed/graph turns have identical model/tool event and outcome semantics.
  Evidence: `agents/test/harness-graph-parity.test.ts`; both paths use the same harness turn and
  capability runtime. Live Temporal replay evidence remains part of the infrastructure gate.

### Extensions and capabilities

- [x] Add declarative skill, plugin, connector, and MCP extension contracts with typed readiness
  gates and deterministic immutable snapshots. Evidence: `agents/src/extensions/` and
  `agents/test/extension-resolver.test.ts`.
- [x] Add a capability-runtime seam that consistently applies manifest lookup, readiness, grants,
  and injected installation admission before handler invocation. Evidence:
  `agents/src/capabilities/runtime.ts`, the API composition root, and
  `agents/test/capability-runtime.test.ts`.
- [x] Persist declarative plugin lifecycle records, dependency/compatibility rules, and immutable
  extension snapshots at agent-version publication and run admission. Evidence: migration 111,
  `agents/src/db/repositories/agent-repository.ts`,
  `agents/src/db/repositories/extension-snapshot-repository.ts`,
  `agents/test/extension-snapshot-repository.test.ts`, and
  `agents/test/run-repository.snapshot-admission.test.ts`.
- [x] Build `ExtensionResolver` for skills, plugins, connectors, and MCP configurations. Evidence:
  `agents/src/extensions/resolver.ts` and `agents/test/extension-resolver.test.ts`.
- [ ] Build one capability-admission interface that always performs readiness, authorization,
  approval, durable operation/receipt handling, invocation, redaction, and evidence. Readiness,
  authorization, approval admission, invocation, and redaction are now centralized; the remaining
  gap is making the operation/receipt lifecycle itself a required part of every capability call.
- [x] Migrate a read-only Core/native capability and one remote MCP capability through that interface.
  Evidence: `agents/src/invocation/immediate-read.ts`, `agents/src/temporal/activities.ts`,
  `agents/test/rest-mcp-local-parity.test.ts`, and `agents/test/remote-mcp.test.ts`. Live remote
  provider integration evidence remains part of the infrastructure gate.
- [ ] Prove KasiAI, Core, tenant, and customer agents consume the same extension contracts.

### Durability, events, delivery, graphs, and children

- [x] Define a typed execution-journal interface and in-memory conformance adapter covering run,
  context, model, tool, wait, uncertain-effect, and delivery events. Evidence:
  `agents/src/journal/` and `agents/test/journal-conformance.test.ts`.
- [x] Add the PostgreSQL journal adapter and migrate harness/operation event writes to it. Evidence:
  migration 113, `agents/src/journal/postgres.ts`, `RunRepository.appendJournalEvent`, and the
  run timeline's canonical `journal` projection. Legacy `appendEvent` callers now dual-write the
  typed journal and `agent_events` in one transaction; `agent_events` remains as a compatibility/
  operator projection until its consumers are migrated.
- [x] Separate delivery obligations from run completion behind one reusable delivery interface.
  Evidence: migration 112, `agents/src/delivery/`, run reply delivery, approval prompts, and
  handoff acknowledgements. Provider/channel paths not yet routed through the shared obligation
  coordinator remain an explicit follow-up.
- [x] Complete decomposed waiting/external-event continuation and remove the dual-loop rollout path.
  Evidence: wait continuation remains in the one Temporal workflow/harness path; the feature flag,
  decomposed coordinator, activities, protocol, state, and alternate tests were removed.
- [x] Make graph nodes use harness turn and capability interfaces exclusively. Evidence:
  `agents/src/temporal/activities.ts`, `agents/test/workflow-graph-agent-loop.test.ts`, and
  `agents/test/harness-graph-parity.test.ts`.
- [x] Add bounded, attenuated Temporal child invocation with parent/child evidence and fake-child
  conformance coverage. Evidence: `agents/src/children/`, `agents/test/child-invocation.test.ts`,
  and `agents/test/temporal-child-invocation.test.ts`. Production activation of a child workflow
  from an agent turn is still pending and is tracked separately below.
- [ ] Complete worker-loss, provider-uncertainty, approval, handoff, delivery, event-replay, tenant
  isolation, and manual verification evidence.

- [x] Serialize same-session runs through durable admission and keep different sessions parallel.
  Evidence: `agents/src/runtime/admission.ts`, `agents/src/db/repositories/run-repository.ts`,
  `agents/src/temporal/workflows.ts`, migration 113, and the hosted boundary test. The former
  `409 conversation_run_active` policy is no longer the normal same-session behavior.

### Local implementation evidence and remaining certification

The local implementation pass currently has these verified results:

- Same-session runs are admitted as durable queued runs and acquire turns in created order; the old
  database reject-active-run index is removed by migration 113. Different sessions retain
  independent admission and can run in parallel.
- Agent-version extension snapshots are validated at run admission, including developer-API
  installation creation and reuse. A run cannot execute without a valid immutable snapshot pin.
- REST/immediate reads, ordinary harness turns, graph turns, and the direct MCP path share the
  capability runtime for manifest lookup, readiness, authorization, and invocation.
- Typed journal events are persisted through the PostgreSQL repository path and exposed in the
  durable run timeline. Legacy operational facts are atomically dual-written into the typed
  journal. Delivery obligations are tracked independently for run replies, approval prompts, and
  handoff acknowledgements.
- Local verification passed on 2026-09-07: `pnpm -s test` in `agents/` produced 133 passed files,
  746 passed tests, 27 skipped integration files, and 86 skipped integration tests. `pnpm -s
  build` also passed.

The following are not falsely treated as complete because they require additional implementation
or infrastructure-backed evidence:

- Replace caller-owned provider/model/tool policy inputs with a resolved, version-pinned execution
  plan owned by the harness.
- Complete the universal capability operation kernel so every capability path shares operation,
  receipt, redaction, and evidence lifecycle behavior, not only the current local/MCP/read paths.
- Route every outbound channel/provider path through `DeliveryObligationCoordinator` and reconcile
  unknown sends after restart.
- Activate and exercise a production Temporal child workflow path; the bounded coordinator and
  fake-child contract exist, but the live child workflow runner is not yet wired into agent turns.
- Run PostgreSQL/RLS, Temporal worker-loss, remote MCP, provider uncertainty, and manual channel
  verification with the local integration services enabled.

## Manual verification matrix

| Scenario | Evidence required |
| --- | --- |
| Long conversation | Full history remains durable; model request stays within the declared budget |
| Large tool output | Full redacted result is inspectable; model receives a bounded projection |
| Provider context overflow | One typed recovery path; no repeated doomed request loop |
| Tool timeout | Stable error, bounded retry, and no false success |
| Worker loss before effect | Operation resumes or safely retries without duplicate effect |
| Worker loss after effect | Receipt prevents replay; uncertain state becomes reconciliation |
| Approval wait | No worker remains occupied; resume uses the pinned proposal and arguments hash |
| Graph node failure | Only the failed node resumes; completed nodes remain complete |
| Delivery acknowledgement loss | Run and delivery states remain separate; recovery is visible |
| Live visualizer reconnect | Cursor replay reconstructs the same ordered timeline |
| Core-hosted run | Core capability uses the Core adapter and correct tenant scope |
| Hostless/tenant run | Unneeded Core dependency is not constructed or required |
| Child invocation | Parent sees typed child state/result without receiving the full child transcript |

## Automated verification

- Context-policy contract tests for budgets, pruning, summaries, retrieval provenance, role pairing,
  and provider overflow.
- Loop-parity tests proving ordinary and graph-driven model/tool calls share outcomes and events.
- Capability conformance tests for readiness, grants, approval, timeout, retry, idempotency,
  redaction, cancellation, and unknown outcomes.
- Failure-injection tests around every model, tool, provider, human, journal, and delivery boundary.
- Event ordering, deduplication, cursor replay, projection rebuild, and live-subscription tests.
- Tenant and role isolation tests over harness inputs, context evidence, tool results, events, and
  visual projections.
- Version-pinning tests for agent definitions, tools, graph nodes, child agents, and operation
  adapters.
- Manual smoke tests for web, one messaging channel, REST/MCP, Core host, and tenant-host fixture.

## Exit criteria

This chunk is complete when:

- all in-scope entry points use the same harness interface;
- context is a bounded, inspectable policy rather than a fixed recent-message slice;
- model, tool, graph, approval, delivery, and child outcomes use one typed runtime vocabulary;
- a completed operation cannot be repeated merely because the worker or reasoning loop restarted;
- the visual execution trace is generated from durable events and can be rebuilt from a cursor;
- delivery is represented independently from run completion;
- custom agents can be composed from versioned skills, plugins, connectors, and MCP configurations,
  with a pinned extension snapshot and visible provenance;
- at least one hostless, Core-hosted, and tenant-hosted path pass the same conformance suite;
- a bounded child-invocation seam exists without enabling unrestricted multi-agent behavior;
- the token, context, delivery, and worker-loss failure scenarios have evidence, not only screenshots;
- no legacy compatibility runtime is extended to hide the new harness; obsolete paths are removed
  as their replacements become verified.

## Open decisions for revision

| Decision | Why it matters |
| --- | --- |
| Context policy location | Determines whether compaction is a reusable runtime step or an activity-specific behavior |
| Stable prompt boundary | Determines cache behavior and when agent/tool changes take effect |
| Model-visible result format | Determines token use, provenance, redaction, and operator inspection |
| Canonical event storage | Determines replay, live subscriptions, projection lag, and retention |
| Delivery outbox ownership | Determines how channels, handoffs, approvals, and agent replies share recovery |
| Plugin package boundary | Determines which skills, capability manifests, connector requirements, MCP configuration, and optional UI metadata can be installed together |
| Plugin execution model | Determines which components remain declarative or approved adapters and which require isolated sandbox/service execution |
| Extension snapshot format | Determines reproducibility, active-run pinning, rollback, revocation, and execution provenance |
| Extension dependency policy | Determines how plugin conflicts, version ranges, incompatible connectors, and revoked dependencies are handled |
| Safe parallel capability metadata | Determines which tools can execute concurrently |
| Graph-to-harness relationship | Determines whether configured graphs are a mode of the harness or a separate executor |
| Child invocation contract | Determines future multi-agent limits, authority attenuation, and result aggregation |
| First production vertical slice | Determines the smallest proof that the new runtime is reliable |

## Release record

This document is a planning artifact. No production code, schema, provider, deployment, or runtime
dependency changes are authorized by this document alone.

| Field | Decision |
| --- | --- |
| Change | Hermes-aligned Agent Platform runtime reliability foundation. |
| Owner | Agent Platform; Operations owns release and recovery evidence. |
| Risk | High; local implementation pass substantially complete, with infrastructure certification pending. |
| Affected services and surfaces | Agents API and worker, Temporal, PostgreSQL, Core and tenant adapters, channels, MCP, provider integrations, execution UI, and future child runs. |
| Platform release version or ID | Not applicable; this pass is local-only and is not being deployed. |
| API/schema/migration changes | Migration 113 adds the canonical typed execution journal and removes the obsolete reject-active-conversation index. The run-admission response exposes the admission decision and the run timeline exposes the canonical journal projection. Existing `agent_events` remains as a compatibility/operator projection until its consumers are migrated. |
| Feature flag or rollout | No runtime compatibility flag is required for the rewrite. Use controlled deployment cutovers where needed and record them in the implementation package. |
| Analytics | No new analytics contract in this local pass; existing structured runtime events cover context pressure, compaction, tool outcomes, operation recovery, delivery, and child invocation. Production rollout still requires dashboard/alert review. |
| Logs, metrics, dashboards, and alerts | Structured, redacted, release-identified evidence required before rollout. |
| Documentation | Update internal architecture, API, runbook, and supported behavior documentation with each implementation package. |
| Validation | Local contract/unit suite and build passed. PostgreSQL/RLS, Temporal worker-loss, remote MCP, provider uncertainty, and manual channel evidence remain pending because integration services are not enabled. |
| Rollback | No deployment occurred. For a later rollout, stop new admissions, preserve evidence, reconcile unknown effects, and restore the last tested deployment artifact; rollback is operational, not a legacy runtime strategy. |
| Post-release review | Required after each high-risk implementation phase. |
