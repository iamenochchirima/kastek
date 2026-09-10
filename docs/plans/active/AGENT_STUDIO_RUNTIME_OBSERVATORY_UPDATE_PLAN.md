---
id: agent-studio-runtime-observatory-update
title: Studio runtime observatory and promotion update
sidebar_label: Studio updates · observatory and promotion
slug: /studio-runtime-observatory-update
description: Standalone Studio plan for visualising context, memory, capabilities, durable execution, and Playground to Live promotion.
---

# Studio runtime observatory and promotion update

**Status:** Observatory UI and runtime evidence links implemented; persistent live execution overlay is being corrected; broader promotion and runtime proof work remains

**Owner:** Agent Platform and Studio

**Last updated:** 2026-09-10

**Risk:** High

**Primary plan:** [`Agent Playground and Execution Observatory`](./AGENT_PLATFORM_EXECUTION_OBSERVATORY_AND_CONTROL_PLANE_PLAN.md)

**Related contracts:** [`Context runtime and telemetry`](./AGENT_CONTEXT_RUNTIME_AND_TELEMETRY_IMPLEMENTATION_PLAN.md), [`Agent memory architecture`](../agents/AGENT_MEMORY_ARCHITECTURE_AND_IMPLEMENTATION_PLAN.md), and [`Agent Platform implementation`](../agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md)

## Why this document exists

The memory plan's M6 section defines the durable memory events that Studio will eventually render.
The context plan defines truthful context and model-attempt telemetry. The second implementation
chunk defines the journal, tools, skills, plugins, MCP, approvals, child execution, and delivery
contracts. Those documents own the runtime behaviour. None of them should also become a browser
layout specification.

This document owns the Studio visual contract that brings those projections together. It covers
the configuration surface, the real Playground, the conversation view, the execution graph, the
timeline, the node inspector, context and memory detail, capability detail, and the promotion path
from Playground to Live.

Studio must make one run understandable without making users learn the internal service split. A
user should be able to configure an agent, run it with real Playground resources, see what the
harness did, fix the configuration, and promote the exact tested version to a separate Live
installation. A browser-only status or a graph inferred from chat messages is not evidence.

## Product lifecycle

Studio is the configuration and Playground workspace. Playground is not a button that opens a
different product. It is the environment in which Studio runs the current candidate.

```text
Editable draft
    |
    v
Immutable candidate version + extension snapshot
    |
    v
Playground installation + Playground resource bindings
    |
    v
Real run through AgentHarness, Temporal, context, memory, tools, and gateways
    |
    v
Execution observatory and validation evidence
    |
    v
Promotion manifest + live binding preflight + approval
    |
    v
Live installation and configured gateway/channel
```

The environments have different bindings, not different agent logic:

| State | User can do | Runtime effect |
| --- | --- | --- |
| Draft | Edit instructions, model policy, capabilities, memory, safety, limits, and required resources | No live traffic changes |
| Playground | Run the pinned candidate with real, isolated or constrained resources | Creates real durable runs and effects under Playground policy |
| Validated candidate | Review run evidence, checks, approvals, and promotion diff | Does not change live traffic |
| Live | Activate a validated candidate for an installation or gateway | New live runs use the activated version |

After promotion, later Studio edits create a new candidate and affect Playground only. They do not
mutate the Live installation. Rollback changes the Live version pointer and preserves both run
history and promotion evidence.

## Ownership boundary

Studio is a read and command surface over durable contracts. It must not become a second execution
engine, context assembler, memory store, or telemetry calculator.

| Concern | Runtime owner | Studio responsibility |
| --- | --- | --- |
| Run, turn, operation, attempt, and child identity | Execution journal and durable runtime | Group and link the records |
| Model capacity, request manifest, token/byte accounting, fit, pruning, compaction, overflow | Context runtime | Render decisions, measurements, reasons, and outcomes |
| Context occupancy and latency measurement basis | Context runtime telemetry | Show provider-reported, anchored estimate, full estimate, or unknown honestly |
| Checkpoint, evidence, retrieval, revisions, retention, and deletion | Memory domain and journal | Show scoped evidence, lineage, lifecycle, and allowed commands |
| Tool, skill, plugin, MCP, and provider resolution | Capability and extension runtime | Show selected version/digest, readiness, calls, results, and failures |
| Approval, pause, resume, cancel, retry, handoff, and reconciliation | Durable command and operation contracts | Submit commands and display acknowledgements |
| Resource credentials, environment bindings, and gateway identity | Binding and installation services | Show readiness and destination without exposing secrets |
| Candidate publication, promotion, activation, and rollback | Agent version and installation services | Show the diff, evidence, approval, and activation state |
| Visual ordering and graph layout | Studio projection | Derive it from journal events and stable relationships |

The UI may format a value, but it may not recalculate a policy value from browser state. The
backend projection remains authoritative after refresh, reconnect, process restart, or a delayed
event.

## Studio layout

The primary Studio workspace is a two-pane testing surface:

```text
+--------------------------- Studio header ----------------------------+
| agent | version | Playground | run selector | Configure | Promote     |
+----------------------+-----------------------------------------------+
|                      |                                               |
| Conversation         | Execution observatory                         |
|                       |                                               |
| messages             | graph / timeline / memory lineage             |
|                       |                                               |
| composer             | selected node and operation detail             |
+----------------------+-----------------------------------------------+
```

The conversation pane is about one third of the workspace on desktop. The observatory uses the
remaining space. Configuration opens from the header as an on-demand panel or route. It does not
occupy a permanent right-hand card beside the graph.

### Header

The header keeps the identity needed to avoid unsafe actions visible at all times:

- agent name and protected/default status;
- candidate or Live version;
- environment badge, with `Playground` as the default Studio environment;
- installation and binding readiness;
- run/session selector;
- `Configure`, `Promote`, and, for Live, `Rollback` actions when authorized.

The header uses short labels. It should not repeat policy explanations that belong in a detail
panel. A Live action must be visually and semantically distinct from a Playground run.

### Conversation pane

The conversation pane contains the input, messages, run state, and concise error/result notices.
It starts in Playground when the agent has a Playground installation. It must not show an
`Open Playground` action inside Studio.

The composer is disabled only for a real reason, such as missing Playground installation, binding
failure, unavailable version, active run lock, or authorization failure. The UI must name the
reason and expose the appropriate recovery action. It must not remain disabled because the route is
called Studio.

The pane displays the selected run's assistant result and links each message to the corresponding
turn and execution item. It does not claim that a run succeeded until the durable run outcome says
so.

### Execution observatory

The observatory has three readings of the same durable evidence:

1. **Graph.** A compact overview of the execution path. Repeated loops may be collapsed, but the
   graph must indicate that detail is hidden.
2. **Timeline.** The ordered journal view. This is the clearest view when retries, waits, parallel
   branches, or reconnects make a graph ambiguous.
3. **Inspector.** The selected operation, context decision, memory evidence, capability call,
   approval, receipt, or promotion record with bounded redacted detail.

The main view must not show repeated generic `Context` boxes when the runtime did not emit separate
context stages. Node labels come from typed events and operation records.

## Visual contract for one run

Every visual item carries stable identifiers and scope. At minimum, the projection must retain:

- organization, workspace, agent, version, installation, and environment;
- session, conversation, run, turn, operation, attempt, and parent/child identifiers;
- event ID, sequence, cursor, causation, correlation, and manifest identifiers where applicable;
- lifecycle state, start/end times, duration, deadline, retry count, and error code;
- candidate, extension, adapter, binding, and release digests;
- redaction level and role visibility;
- source event IDs and evidence IDs for memory and retrieval items.

The graph is generated from actual events. It does not imply that an autonomous agent was authored
as a node workflow. If an authored workflow exists, Studio labels it separately from the generated
execution graph.

### Configured topology and live execution overlay

The observatory has two related readings that must remain distinct.

The configured topology is the effective candidate and extension snapshot that will run in the
selected environment. It is visible before the first message and includes the runtime stages and
the capabilities the user configured, such as models, context, memory, skills, plugins, MCP tools,
gateways, approvals, and resource bindings. Each configured item has a readiness state such as
`declared`, `resolved`, `ready`, `blocked`, or `unavailable`. A missing credential, permission,
binding, schema, provider route, or installation must be visible before a run and must not be
represented as a ready node.

The live execution overlay is built from the same run's durable journal. It attaches execution
items to the configured topology when a stage is resolved, started, waiting, retried, completed,
or failed. Every item retains run, turn, operation, attempt, event, and manifest identifiers, with
start time, end time, duration, queue delay, retry count, bounded redacted detail, and the typed
outcome. A configured Google Calendar capability therefore appears before execution as a ready or
blocked capability, then gains a live invocation item when the model selects it. Memory retrieval,
context compaction, model attempts, approvals, child runs, deliveries, and provider effects use
the same rule.

The graph must not create a second configured node for every loop iteration, and it must not infer
execution from chat text. Repeated calls remain separate execution items linked to one configured
capability. Collapsed loops show count, duration range, status, and a link to the exact timeline
items. The timeline remains the lossless ordered view when parallel branches, retries, waits, or
reconnects make the graph ambiguous.

This gives users two answers at once: "what will this agent use?" and "what did it actually do on
this run?" The node inspector must make the difference explicit and show the first failing durable
fact, its non-secret reason, and the available recovery action.

### UI implementation slice: configured system map

The first UI slice is intentionally visual and local to Studio. It establishes the observatory
surface before the runtime projection is wired in:

- [x] Render a persistent configured topology before a run starts.
- [x] Show ingress, session, context, memory, retrieval, model, capability routing, tools, MCP,
      skills, approvals, handoff, persistence, response, and delivery as connected nodes.
- [x] Keep the topology fixed while runtime events overlay `running`, `complete`, `waiting`, and
      `error` states on the matching node.
- [x] Allow operators to drag nodes into a useful arrangement, persist the local layout per agent
      version, and reset it without changing the configured topology.
- [x] Make each node selectable with scope, provider, event contract, and bounded configuration
      details; open the existing settings surface for configurable nodes.
- [x] Use temporary representative configuration data until the effective candidate projection is
      available. This data is clearly marked as configured/demo state and is not a runtime claim.
- [x] Replace the representative graph with the effective candidate and extension snapshot.
- [x] Attach timeline items and operation evidence from durable journal records, with scoped memory observatory and selected-revision lineage summaries.
- [x] Add readiness states and the existing authorized configuration recovery action from backend contracts.

### UI correction: persistent topology with live execution overlay

The graph is the primary execution surface. It remains mounted while a run is active and shows
the configured base stages plus the selected agent's capabilities. Runtime evidence changes node
state in place and records repeated visits to the same stage as activity counts and ordered run
items. The UI must not replace the base graph with a second "Run" graph or require a graph-mode
button to inspect live work.

- [x] Remove the topology/run graph switch from the observatory header.
- [x] Keep the configured core and capability nodes mounted before, during, and after a run.
- [x] Overlay live status and repeated-stage counts on configured nodes, including repeated context,
  memory, retrieval, model, tool, and connector work.
- [x] Keep the ordered run activity view as a compact Waku-style receipt linked to graph nodes;
  raw journal metadata remains secondary evidence rather than the hero surface.
- [ ] Add richer backend-projected wave timing and parallel-branch grouping when the runtime
  projection exposes those measurements consistently.

This slice is a preview surface, not a second execution engine. It does not create runs, infer
events from chat text, or persist configuration from node selection.

The current implementation also loads installation-scoped run history, reconstructs a selected run
from the durable timeline endpoint, and displays the backend cursor, freshness, redaction level,
terminal outcome, sequence gaps, and bounded capability operation evidence. Timeline items are
deduplicated by their durable event identity before they are projected into the graph and timeline.
The observatory now has a configured topology and an exact run graph, reconnects the active-run SSE
stream from its last durable cursor, consumes a versioned unified timeline-item projection, exposes
retry/resume/cancel/approval commands through existing durable APIs, and can open a bounded memory
revision-lineage summary. Exact execution items now retain their configured-stage link, represent
child executions explicitly, expose bounded effect receipt/reconciliation metadata, and show the
current Live candidate identity alongside the Playground candidate. The existing promotion path
also mirrors the tested Playground capability connections and grants to Live without copying secret
payloads. Richer promotion evidence, full lineage controls, and manual runtime proof remain
follow-ups; a separate environment-binding management system is intentionally out of scope.

## Release record for the UI slice

```text
Change: Persistent configured execution-observatory map in Studio
Owner: Agent Platform and Studio
Risk: standard
Affected services and user surfaces: client Studio/Playground observatory only
Platform release version or release ID: not applicable (preview UI slice)
API/schema/migration changes: timeline responses now include versioned projection metadata (cursor, freshness, redaction, observed timestamp) and bounded scoped `items` for events, journal entries, steps, tool calls, and effects; no migration is required
Feature flag or rollout method: existing Studio route; graph projection is read-only and uses existing effective-config, readiness, connection, and run-journal APIs
Analytics events and success metrics: not applicable; no new user outcome is persisted
Logs, metrics, dashboards, and alerts: not applicable; no backend lifecycle is added
User, API, internal, and operational documentation: this plan updated
Validation evidence: client ESLint, TypeScript check, and production Next.js build pass; Agents TypeScript check and HTTP projection tests pass; Studio projection uses effective candidate data, durable journal evidence, cursor-aware SSE replay, unified timeline items, configured-stage links, explicit child nodes, bounded effect reconciliation metadata, and scoped memory projections
Rollback or disable plan: revert the Studio UI commit; existing run/configuration APIs are unchanged
Post-release review date: when promotion and full runtime-proof work begins
```

### Core execution nodes

The default run view may contain these nodes when their events occur:

```text
input received
run admitted
turn started
context planned
memory checkpoint
memory retrieval
request manifest finalized
model attempt
skill/plugin/MCP resolution
tool call
approval or human wait
child agent invocation
provider or gateway effect
delivery obligation
handoff
retry or recovery
turn completed
run completed / failed / cancelled / unknown
```

The UI must not invent a node to make the graph look complete. A stage that is still accepted,
queued, indexing, waiting, or unknown must retain that state.

## Context and model telemetry view

Context is one of the most important Studio details because it explains why an autonomous run is
slow, compacting, limited, or unable to continue. The context inspector is a projection of the
context runtime, not a token counter implemented in React.

For the selected model attempt, show when available:

- model, provider, endpoint, route, and capability source;
- context window capacity;
- current input occupancy;
- utilization percentage;
- output reservation;
- safety margin;
- payload-byte pressure when applicable;
- run and cumulative token budgets as separate values;
- measurement basis: `provider_reported`, `anchored_estimate`, `full_estimate`, or
  `unknown_after_compaction`;
- request-manifest digest and component accounting summary;
- compaction count and current compaction state;
- queue delay, provider latency, time to first token, completion time, and total turn duration;
- overflow class, recovery attempt, and typed final outcome when recovery occurs.

The display must show `unknown` when the runtime has deliberately invalidated an occupancy anchor.
It must never replace unknown with zero. Cumulative session tokens must never be labelled current
context occupancy.

The context detail should let an authorised operator inspect which categories were selected or
excluded, such as transcript, system instructions, tools, memory evidence, plugin output, and
attachments. It shows counts, digests, and reasons by default. Raw prompts remain protected.

## Memory view

Memory has two visual readings that use the same event and projection contracts.

### Memory in the run graph

The run view shows memory work only when it happened:

- checkpoint requested, committed, blocked, or failed before a lossy context rewrite;
- retrieval requested, completed, blocked, or failed before final request assembly;
- evidence selected, rejected, or excluded by scope, lifecycle, freshness, or token budget;
- consolidation queued, accepted, retrying, completed, or dead-lettered;
- projection accepted, indexing, visible, delayed, failed, or deleted.

Each evidence item shows stable evidence ID, memory scope, source event IDs, validity/lifecycle
state, retrieval reason or score, redacted content, and measurement metadata where applicable.
The graph must not display private memory merely because the run itself is visible.

### Memory lineage view

The lineage view follows a memory revision rather than a single turn:

```text
source event
    -> candidate or explicit write
    -> review / policy decision
    -> semantic or episodic revision
    -> projection readiness
    -> retrieval use
    -> correction, supersession, retention, or deletion
```

The view exposes why a revision exists, which source supported it, which scope allowed it, which
agent saw it, and what lifecycle state it has. Review, correction, retry, revalidate, and delete
controls appear only when the backend exposes a tested transition.

## Tools, skills, plugins, and MCP view

Autonomous agents are configured as a profile with instructions and capabilities. Studio does not
turn every capability into a required workflow block. It does show the exact capability path used
by a run.

For each selected capability item, show:

- capability kind: built-in tool, skill, plugin, MCP server/tool, gateway, or provider;
- stable name, version, source, and extension/configuration digest;
- readiness and permission decision;
- selected input schema and bounded redacted arguments;
- queue, start, completion, timeout, retry, and failure timing;
- approval requirement and actor if approval was needed;
- bounded result summary, receipt, idempotency key, and effect status;
- isolation mode and resource references without secret values;
- child operations or backend trace links when permitted.

The extension panel must distinguish these states:

```text
declared -> resolved -> ready -> invoked -> completed
                         \-> blocked / denied / timed out / failed
```

Skills, plugins, and MCP are part of the candidate and extension snapshot. A new extension version
must create a new candidate digest. Studio must show extension drift before promotion.

## Autonomous loops and child agents

The observatory must make autonomous behaviour legible without pretending the agent followed a
fixed workflow. Show:

- iteration number and loop reason;
- model attempts within the iteration;
- tool calls selected by the model;
- waiting and approval boundaries;
- child-agent invocation, parent operation, child run, and return result;
- context and budget pressure that ended an iteration;
- retry and recovery boundaries;
- final stop reason, including completed, user-stop, budget-limited, context-limited, failed, or
  unresolved external effect.

Child runs inherit only explicitly allowed scope, capabilities, environment, and budgets. The
visual projection must make inherited and newly granted authority visible without showing secrets.

## Promotion and Live view

Promotion is not a rename of the Playground installation. Studio must show a separate Live target
and a promotion record.

Before promotion, show:

- candidate and extension digests;
- runtime, adapter, schema, and policy revisions;
- required resources and their Playground/live binding status;
- successful Playground runs and evaluation evidence;
- channel or gateway certification evidence;
- approval actor, reason, and timestamp;
- promotion diff and rollback target;
- unresolved warnings that require an explicit decision.

Promotion must resolve Live bindings without copying Playground credentials, conversations,
memories, test data, or side effects. Activation changes the Live version pointer atomically. A run
already in progress remains pinned to its original version and binding snapshot.

The Live view shows the active version, binding revision, gateway/channel targets, release identity,
last activation, and rollback target. It does not expose Playground-only drafts as live traffic.

## States and error presentation

Studio uses concise status labels with detail on selection. The minimum shared states are:

```text
ready, queued, running, waiting, approval_required, paused, retrying,
accepted, indexing, visible, blocked, failed, completed, cancelled,
unknown, reconciliation_required, delayed, disconnected, unavailable
```

The UI must pair a state with a bounded reason and recovery action when one exists. Examples:

- `Context limited` with the context fit outcome and the last recovery action;
- `Checkpoint blocked` with the typed memory boundary failure, while preserving the transcript;
- `Tool approval required` with the requested capability and approver action;
- `Provider effect unknown` with reconciliation, not a false success or blind retry;
- `Projection delayed` with cursor and lag information, not a stale completed badge.

## Implementation phases

### Phase 0: freeze the visual contract

- [ ] Confirm the second-chunk journal, event cursor, projection, redaction, and command contracts.
- [ ] Link context telemetry, memory observatory, capability, approval, child-run, delivery, and
  promotion events to the common visual item identity.
- [ ] Define read models for run summary, timeline item, graph node/edge, inspector detail,
  telemetry snapshot, memory lineage, promotion manifest, and command acknowledgement.
- [ ] Define the configured-topology read model separately from live execution items, including
  stable configured node identity, capability kind, candidate/extension digest, readiness state,
  environment binding, and redacted configuration detail.
- [ ] Define the execution-overlay read model, including the configured node link, run/turn/
  operation/attempt/event identifiers, causation, lifecycle state, start/end timestamps, duration,
  queue delay, retry count, bounded detail, and typed outcome.
- [ ] Define role and tenant visibility for each field, including memory evidence and tool results.
- [ ] Define graph aggregation rules so collapsed loops retain counts, ranges, and a link to exact
  events.

### Phase 1: build the Studio shell

- [ ] Make Studio open with the agent's Playground installation when one exists.
- [ ] Make the composer run in Playground by default and remove route-name checks that disable it.
- [ ] Implement the clean two-pane layout: conversation at roughly one third, observatory for the
  remaining workspace.
- [ ] Move configuration into an on-demand panel or route.
- [ ] Keep agent, version, environment, installation, and run identity visible without text noise.
- [ ] Add responsive desktop, tablet, and mobile layouts with an intentional stacked mobile view.

### Phase 2: render durable execution

- [ ] Build run selection and run summary from tenant-scoped projections.
- [ ] Build the ordered timeline with cursor replay, deduplication, gaps, and lag states.
- [ ] Render the configured topology before the first run, including ready, blocked, unavailable,
  and unresolved capability nodes.
- [ ] Build the generated graph for sequential, parallel, retry, wait, approval, child, and
  delivery operations.
- [ ] Overlay live execution items onto configured nodes as durable start, progress, wait, retry,
  completion, and failure events arrive.
- [ ] Add aggregated and exact-execution graph modes.
- [ ] Build the selected-item inspector with bounded redacted data and source identifiers.
- [ ] Show the first durable failure reason, operation timing, retry history, and recovery action
  for a blocked or failed node.
- [ ] Add reconnect and live updates without making polling the correctness mechanism.

### Phase 3: render runtime capabilities

- [ ] Add context manifest, fit, compaction, overflow, usage, token, byte, and timing details.
- [ ] Add memory checkpoint, retrieval, evidence, lineage, consolidation, projection, and deletion
  details.
- [ ] Add tools, skills, plugins, MCP, provider, approval, receipt, and isolation details.
- [ ] Add loop, child-agent, handoff, delivery, and reconciliation details.
- [ ] Add context, memory, capability, and effect links from chat messages to execution items.

### Phase 4: configuration, validation, and promotion

- [ ] Render the effective candidate configuration and extension snapshot.
- [ ] Render resource-binding readiness without credential values.
- [ ] Show real-effect destination, quota, spend, approval, and data-namespace constraints before
  execution.
- [ ] Show validation evidence and the exact candidate/extension digests used by Playground runs.
- [ ] Build promotion diff, Live binding preflight, approval, activation, and rollback views.
- [ ] Prove that promotion changes a separate Live installation and does not mutate Playground or
  active runs.

### Phase 5: controls, security, and manual proof

- [ ] Expose only tested durable controls for pause, resume, cancel, retry, approve, reject,
  handoff, reconcile, correction, revalidate, and delete.
- [ ] Test valid, stale, concurrent, unauthorized, and unknown command states.
- [ ] Verify raw prompts, credentials, restricted tool results, private memory, and cross-tenant
  evidence never appear in an unauthorized projection.
- [ ] Test reconnect, cursor expiry, duplicate events, out-of-order events, projection rebuild,
  and browser refresh.
- [ ] Run real Playground conversations that exercise context pressure, memory retrieval, a tool,
  an approval, a retry, and a child invocation where configured.
- [ ] Promote one validated candidate, verify the Live gateway uses it, then roll back without
  losing evidence.
- [ ] Record responsive, keyboard, accessibility, release, analytics, logging, and rollback
  evidence.

## Checklist

Tick an item only when the implementation, focused automated coverage, and evidence link exist.
Screenshots prove layout, not durable correctness.

### Contracts and projections

- [ ] One versioned Studio read-model contract exists for run, timeline, graph, inspector, memory
  lineage, telemetry, promotion, and command acknowledgement.
- [ ] Every item has stable run/turn/operation/attempt/event identity and environment scope.
- [ ] Every projection exposes cursor, freshness, projection version, and redaction metadata.
- [ ] Graph items are generated from journal events and never inferred from browser chat state.
- [ ] Memory projections use M6 event and lineage contracts without creating a second memory stream.
- [ ] Context projections use context-runtime telemetry without calculating occupancy in the client.
- [ ] Capability projections identify tool, skill, plugin, MCP, provider, approval, receipt, and
  extension digest without exposing secrets.
- [ ] Tenant, installation, role, retention, and authorization tests pass for every read model.

### Studio and Playground

- [ ] Studio opens with a Playground installation for KasiAI and newly created agents by default.
- [ ] The composer is a real Playground runner, not a simulated or mock execution path.
- [ ] The two-pane layout gives conversation about one third of desktop width and the observatory
  the remainder.
- [ ] The observatory shows the configured agent topology before a run instead of an empty graph.
- [ ] Live execution items attach to configured capability nodes without duplicating topology nodes
  for each loop iteration.
- [ ] Tool, memory, context, model, approval, child-run, and delivery items expose actual lifecycle
  timing and typed outcomes when their journal contracts provide them.
- [ ] Configuration is on demand and does not permanently consume the observatory panel.
- [ ] The UI does not show an `Open Playground` action as a prerequisite inside Studio.
- [ ] Playground environment, candidate digest, installation, and binding readiness are visible.
- [ ] Draft changes do not change an existing Playground run or Live installation.
- [ ] Real provider and gateway effects obey Playground credentials, namespaces, destinations,
  quotas, budgets, and approval policy.

### Context and memory

- [ ] The context inspector shows capacity, occupancy, utilization, reservation, safety margin,
  measurement basis, compaction count, and attempt timing when available.
- [ ] The UI distinguishes current occupancy, context capacity, output reservation, run budget,
  cumulative usage, and payload bytes.
- [ ] Unknown-after-compaction is rendered as unknown, never zero.
- [ ] Context fit, compaction, overflow, and typed limit outcomes link to the responsible events.
- [ ] Checkpoint requested/committed/blocked/failed states render before a lossy rewrite.
- [ ] Retrieval evidence shows stable IDs, scope, provenance, validity, lifecycle, reason/score,
  redacted content, and measurement metadata.
- [ ] Memory lineage follows source event, candidate, review, revision, projections, retrieval,
  correction, retention, and deletion without browser-invented stages.
- [ ] A failed checkpoint never presents the durable transcript as deleted.

### Tools, extensions, and autonomous execution

- [ ] Tool, skill, plugin, MCP, provider, and gateway stages show actual resolution and invocation.
- [ ] Extension version and digest drift is visible before promotion.
- [ ] Capability arguments and outputs are bounded and redacted by role.
- [ ] Approval, denial, timeout, retry, receipt, idempotency, and effect-unknown states are honest.
- [ ] Autonomous iterations, stop reasons, child runs, inherited scope, and budgets are visible.
- [ ] Generated execution graphs are clearly distinct from authored workflow graphs.

### Promotion and Live

- [ ] Validation evidence is tied to the exact candidate and extension digests.
- [ ] Promotion shows the portable configuration diff and separate Live binding preflight.
- [ ] Playground secrets, conversations, memories, test data, and side effects are not copied.
- [ ] Activation changes a Live installation atomically and leaves active runs pinned.
- [ ] Live gateway/channel use is restricted to the activated Live installation.
- [ ] Rollback restores the previous tested version without deleting execution evidence.

### Verification and release

- [ ] Automated projection, redaction, cursor, reconnect, command, and isolation tests pass.
- [ ] Browser-level tests cover chat, graph, timeline, inspector, telemetry, memory, capability,
  promotion, rollback, responsive layout, and keyboard navigation.
- [ ] Manual real-resource Playground proof is recorded for web and at least one configured
  gateway, plus REST/MCP where enabled.
- [ ] Context pressure, memory retrieval, tool timeout, approval wait, worker loss, provider
  uncertainty, and reconnect are manually observable and recoverable.
- [ ] Analytics, structured logs, metrics, redaction, documentation, rollout, and rollback records
  are complete.
- [ ] The plan records remaining limitations before the Studio update is marked complete.

## Manual acceptance proof

The Studio update is ready for acceptance when a user can perform this sequence locally:

1. Open Studio and see the protected KasiAI agent and its Playground installation.
2. Create or edit an agent draft without changing Live.
3. Run a real Playground conversation from the Studio composer.
4. Watch the graph and timeline show the actual input, context decision, memory work, model
   attempt, capability calls, approvals, effects, and final outcome.
5. Select the context item and verify capacity, occupancy, utilization, latency, turn duration,
   measurement basis, and compaction state are backend values.
6. Select the memory item and verify scope, evidence IDs, provenance, lifecycle, retrieval reason,
   and redaction.
7. Select a tool, skill, plugin, or MCP item and verify its version/digest, bounded arguments,
   approval, result, receipt, and effect state.
8. Refresh or disconnect the browser and verify the same run reconstructs from the journal cursor.
9. Validate the candidate, inspect the promotion diff, approve it, and activate it for a separate
   Live installation.
10. Use the configured Live gateway and verify it runs the promoted version, while the next draft
    still runs only in Playground.
11. Roll back the Live installation and verify old run evidence and Playground drafts remain.

## Verification requirements

- Contract tests for every Studio read model, event mapping, cursor, projection version, and
  redaction rule.
- Conformance tests proving the same run appears consistently in graph, timeline, inspector, and
  telemetry views.
- Context-runtime and memory-observatory integration tests covering checkpoint, retrieval, fit,
  compaction, overflow, and measurement basis.
- Capability integration tests covering built-in tools, skills, plugins, MCP, approval, provider
  receipts, retries, and effect uncertainty.
- Child-run, handoff, delivery, and multi-channel projection tests.
- Environment, tenant, role, credential, data namespace, destination, and gateway isolation tests.
- Browser tests for Studio loading, real Playground execution, reconnect, responsive layout,
  accessibility, promotion, activation, and rollback.
- Failure-injection evidence for worker loss, provider timeout, tool timeout, projection lag,
  checkpoint block, memory retrieval block, and Live binding drift.

## Open decisions

| Decision | Default |
| --- | --- |
| Studio environment on entry | Playground for every agent with a healthy Playground installation |
| Main workspace | Conversation at roughly one third width, observatory at roughly two thirds |
| Configuration placement | On-demand panel or route, not a permanent graph-side card |
| Primary execution reading | Timeline is authoritative; graph is a derived overview |
| Memory reading | Run memory stages plus a separate revision-lineage view |
| Context numbers | Backend-owned telemetry with explicit measurement basis |
| Graph authoring | Optional workflow capability; autonomous agents are not authored as blocks |
| Live promotion | Separate Live installation with atomic version activation |
| Mobile layout | Stack conversation above the observatory and preserve access to the selected inspector |

## Release record

| Field | Decision |
| --- | --- |
| Change | Studio runtime observatory, real Playground testing, context/memory/capability visual projections, and Playground-to-Live promotion UX. |
| Owner | Agent Platform and Studio; Operations owns release and recovery evidence. |
| Risk | High. The UI joins security-sensitive runtime, memory, capability, and deployment evidence. |
| Affected services and surfaces | Client Studio, Agents API, journal projections, context telemetry, memory observatory, capability/extension runtime, installation bindings, gateways, Temporal, PostgreSQL, analytics, and internal documentation. |
| Platform release version or ID | Not applicable until an implementation package is released. |
| API/schema/migration changes | Expected for read models, cursor/subscription payloads, promotion/activation views, and command acknowledgements. Existing runtime and memory contracts remain authoritative. |
| Feature flag or rollout | Start locally with Playground resources. Gate Live promotion and high-risk controls by authorization and binding readiness. No Railway or Vercel deployment is part of the current local workflow. |
| Analytics | Required for Studio open, Playground run, readiness failure, context/memory/capability inspection, validation, promotion, activation, rollback, reconnect, and command outcomes. |
| Logs, metrics, dashboards, and alerts | Required for projection lag/gaps, redaction failures, environment leaks, binding drift, promotion mismatch, subscription failures, command failures, and gateway activation failures. |
| Documentation | Update the Studio user/API contract, internal runtime observatory documentation, memory M6 handoff, context telemetry plan, and operator runbooks with implementation. |
| Validation | Contract, integration, browser, accessibility, real Playground, gateway, promotion, activation, rollback, isolation, and failure-injection evidence. |
| Rollback | Disable unverified visual controls, keep read-only inspection available, and atomically restore the previous Live candidate and binding revision. Preserve journal, memory, context, and promotion evidence. |
| Post-release review | Required after each Studio implementation phase and after the first real Live promotion. |
