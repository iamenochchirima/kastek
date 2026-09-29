# Initial Agent Platform Architecture Improvement Plan

**Status:** Superseded architecture reference

**Owner:** Agent Platform and Platform Integrations

**Last updated:** 2026-09-05

**Planning status:** This document records an architecture direction and implementation sequence.
It does not authorize product code, schema, deployment, or provider changes by itself.

**Architecture posture:** A broader architecture rethink is required before implementation. The
boundaries and ownership model described below are working hypotheses to investigate and validate,
not final commitments to a rewrite, service split, or runtime replacement.

**Source of truth:** The canonical implementation direction is now
[`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](./AGENT_PLATFORM_IMPLEMENTATION_PLAN.md). This document
is retained as architecture input and historical reasoning only.

## Objective

Make KasiTek's agent tool calling and external integrations reliable, durable, explainable, and
operationally inspectable across the KasiTek product and the tenant platform.

An agent should be able to decide that an action is unavailable before invoking a provider, execute
an available action through a bounded and durable operation, survive worker or provider failures,
and return a truthful terminal result. Operators and developers should be able to see the complete
execution path, identify the failing module or provider, and take only a safe recovery action.

Success means that the same execution contract applies to built-in tools, tenant-owned domain
capabilities, provider-backed actions, MCP tools, channel-triggered runs, and future integrations.
A user should not need to infer the state of an external action from a generic error, a missing
response, or a worker log. The runtime must not require a KasiTek Core tenant when an installation
uses only Agent Platform-native or another approved host's capabilities.

## Scope

### Included

- A provider-neutral tool invocation and external-operation contract.
- A generic durable invocation identity with root, parent, causation, and relationship fields.
- Parent-child execution semantics that work for tools, humans, MCP, providers, and future agent
  delegation.
- Explicit context, authority, budget, deadline, safety, and cancellation inheritance rules.
- A single readiness and capability decision before provider-backed tool execution.
- Separation of agent reasoning, action authorization, durable execution, and provider effects.
- Durable operation states, idempotency, bounded retries, receipts, polling, webhooks where
  available, and reconciliation for unknown provider outcomes.
- A common provider-adapter interface for social, messaging, email, and future external services.
- A hostability model that keeps Agent Platform control and execution data separate from Core or
  tenant-owned product data.
- A tenant-host adapter model that makes identity, domain capabilities, and event/media/delivery
  integrations explicit rather than constructing a Core client as an unconditional dependency.
- Adapter conformance tests and failure-injection scenarios.
- A structured execution event model and materialized read projections.
- Developer and operator visuals for runs, graphs, tool calls, approvals, waits, retries, provider
  effects, versions, and deployment identity.
- Per-target execution visibility for fan-out actions such as batch publishing.
- Release identity, rollout, metrics, alerts, runbooks, and rollback evidence for each
  implementation tranche.

### Excluded

- Adopting Nango, Restate, LangGraph, or another external runtime as a required production
  dependency.
- Replacing Temporal before a measured architecture decision demonstrates that the current runtime
  cannot meet the required execution contracts.
- Building a universal catalog of every external API before the common adapter contract is proven.
- Exposing raw provider APIs, OAuth scopes, credentials, or provider-specific payloads to agents.
- Running arbitrary user code, browser automation, or unreviewed plugins inside the shared worker.
- Making a visualization a substitute for durable state, idempotency, or provider reconciliation.
- Executing agent-to-agent delegation, recursive agent spawning, autonomous agent discovery, or an
  unrestricted swarm model in the initial architecture work.
- Copying Core or tenant product records, business rules, or credentials into the Agent Platform in
  the name of independence.
- Requiring every host integration or domain capability to become a separately deployed service.

## Context and constraints

- KasiTek already has a durable Temporal workflow path, a typed action/capability registry,
  approvals, effect receipts, provider adapters, channel adapters, structured run evidence, and
  an analytics outbox. The plan extends these modules rather than proposing a wholesale rewrite.
- The current architecture audit identifies oversized workflow activity boundaries, incomplete
  provider-effect reconciliation, and incomplete provider-adapter conformance as material risks.
- `docs/plans/completed/AGENT_TOOL_ACTION_READINESS_PLAN.md` defines the initial readiness vocabulary.
  This plan treats that readiness result as the front door to every provider-backed action.
- `docs/plans/completed/AGENT_BATCH_PUBLISHING_PLAN.md` defines per-destination status and one approval
  for a fixed batch. This plan generalizes that model to all external effects.
- The active batch publishing, tool-action readiness, and knowledge-grounding plans are upcoming
  capability slices. Their deployed or tested behavior is a baseline to preserve and revalidate,
  not a finalized cross-host interface.
- The action platform design keeps protocol adapters separate from action policy and execution. The
  same rule applies to agent loops, MCP, REST, channels, and provider adapters.
- Agent grants, product entitlements, provider connection access, provider capability, and human
  approval are separate decisions. One must not be represented as another.
- Every operation must remain scoped to the organization, agent installation, connection, and
  resource selected by the authenticated caller. Provider identifiers supplied by a model are not
  sufficient resource authorization.
- No credential, token, raw provider scope, full message body, or unnecessary personal data may be
  written to prompts, durable events, analytics, logs, or visual projections.

## Architecture direction

The core design is three explicit modules separated by a small external seam:

```text
Agent, channel, UI, REST, or MCP request
                    |
                    v
          Action and capability interface
                    |
                    v
          Durable operation coordinator
       readiness | approval | idempotency
       timeout   | retry    | reconciliation
                    |
                    v
             Provider adapter seam
                    |
                    v
       Instagram, Gmail, X, TikTok, etc.

Every layer emits structured execution events.
                    |
                    v
       Read projections and live subscriptions
                    |
                    v
        Timeline, graph, operation, and release views
```

The agent loop owns intent and reasoning. It does not own provider retries, indefinite waits,
connection health, or the truth of an external side effect.

The durable operation coordinator owns the sequence and evidence for one action. Temporal remains
the durable workflow owner. PostgreSQL remains the product evidence and idempotency store. Provider
adapters own provider-specific authentication, request construction, response interpretation, and
provider-side status or reconciliation logic.

This is a deep-module goal: callers should learn a small action and operation interface while the
implementation hides provider-specific retries, state transitions, authorization details, and
recovery behavior. The seam must be testable with a fake adapter and exercised against at least two
real adapters before it is treated as a stable abstraction.

### Architecture rethink: interaction and delivery reliability

The repeated production failures indicate that we need to rethink the architecture across the
interaction path, not only patch individual provider or model failures. A customer message can be
accepted by Core, admitted by the Agent Platform, completed by Temporal, and still fail to reach
the customer. Human handoff can also be recorded in one service while the customer acknowledgement,
operator view, and outbound channel delivery follow separate paths. When a later delivery step
fails, the run can appear complete or return a generic fallback instead of exposing the failing
transition.

This section starts an architecture investigation. Before implementation, the team must validate
where each lifecycle should live, whether the current service boundaries are helping or creating
failure modes, and which parts can be improved incrementally. The proposed ownership and flow below
are the leading direction for that investigation. They must be tested against website chat,
messaging channels, human handoff, external tool calls, tenant hosting, and future multi-agent
execution before being treated as the final architecture.

The current path is effectively:

```text
Customer channel or widget
          |
          v
Core ingress/session state
          |
          v
Agent Platform admission and conversation state
          |
          v
Temporal agent run
          |
          v
Agent message and delivery attempt
          |
          v
Core delivery boundary or provider adapter
          |
          v
Polling, realtime subscription, or operator view
```

The likely outcome is a targeted interaction-architecture overhaul rather than an immediate full
rewrite, but that is an architecture decision to validate. The investigation must explicitly
compare incremental restructuring with larger component changes and must assess whether Temporal
continues to meet the required execution guarantees. Until that work is complete, the compatibility
path remains available and no service split or runtime replacement is assumed.

#### Ownership hypothesis to validate

The leading hypothesis is that the Agent Platform should become the canonical owner of the agent
interaction lifecycle:

- conversation admission and per-conversation serialization;
- inbound and outbound message records;
- agent runs and their relationship to messages;
- human handoff state and ownership transitions;
- delivery intent, attempts, receipts, retries, and terminal outcomes;
- invocation, operation, and execution evidence.

The corresponding hypothesis is that Core remains the owner of tenancy, authentication, product
records, business rules, and the first host/channel adapter. It may retain a website session or
product projection where required by the host, but the generic runtime must not infer agent state
from multiple competing copies. Every shared object needs one authoritative owner and explicit
references at the other boundary. These ownership choices require an inventory and migration-impact
assessment before they become implementation decisions.

#### Unified interaction path

All supported channels should use the same transport-neutral lifecycle:

```text
Inbound channel adapter
          |
          v
Interaction admission
 idempotency | authorization | serialization
          |
          +--------------------+
          |                    |
          v                    v
 Agent run coordinator     Human handoff coordinator
       Temporal            offer | accept | assign | resolve
          |                    |
          +--------------------+
                       |
                       v
                 Durable outbox
          queued | sending | delivered
                 retrying | failed | unknown
                       |
                       v
             Channel delivery adapter
                       |
                       v
                 Delivery receipt
```

The same contract must cover website, WhatsApp, Telegram, email, social messaging, API clients,
and future channels. A channel adapter translates provider payloads; it must not implement its own
conversation state machine, retry vocabulary, or handoff semantics.

#### Run completion and delivery completion are different facts

An agent run completing means that reasoning and action execution produced a result. It does not
mean that the result reached the customer. The platform must record and expose these separately:

```text
run:       received → running → completed | failed | canceled
delivery:  queued → sending → delivered
                         ├→ retrying → delivered
                         ├→ failed
                         └→ unknown → reconciled
handoff:   agent_active → handoff_requested → human_owned → resolved
```

Delivery failures must not be swallowed by a successful workflow activity. They must create a
bounded retry or explicit terminal failure with a safe reason code, visible to the customer-facing
surface where appropriate and actionable in the operator view. A generic fallback may be used only
when the system has classified the failure and has no safer, more specific response.

#### Handoff is an interaction transition, not a tool side effect

Human assistance must be handled by the same interaction coordinator as agent replies. A handoff
request should atomically record the customer message, transition ownership, create the handoff
request, and produce the customer acknowledgement. The customer should receive a clear state such
as “Your request has been sent to our team. A team member will reply here as soon as possible.”
The system must distinguish:

- request accepted by the platform;
- a human available to accept the work;
- a human accepting or claiming the work;
- the first human message delivered to the customer;
- handoff resolution or expiry.

The customer and operator surfaces should derive from the same event stream and should not require
separate polling-specific interpretations of handoff state.

#### Realtime is the primary read path

The execution event stream should be the primary way that widgets and operator views receive state
changes. It must support authorization, cursor replay, reconnect, and a bounded fallback read. A
polling fallback may remain for hostile networks or older clients, but it must consume the same
delivery projection and must not silently treat a 404, stale session, or missing event as an empty
conversation. Client-visible errors should identify whether the problem is admission, execution,
handoff, or delivery.

#### Questions the rethink must answer

Before implementation, this work must answer:

- Which service is authoritative for conversations, messages, runs, handoffs, delivery attempts,
  and customer-visible projections?
- Which boundaries should be synchronous admission boundaries and which should be durable
  asynchronous transitions?
- Should the website session remain in Core, move behind the Agent Platform, or become a thin
  channel projection?
- Can one delivery outbox safely serve website, messaging, email, social, and tenant-hosted
  channels, or do some channels require separate delivery domains?
- Which guarantees belong to Temporal, PostgreSQL, the interaction coordinator, and channel
  adapters?
- What is the smallest change that removes silent failures without creating a second parallel
  runtime or duplicated source of truth?
- What must remain compatible for existing agents, tenants, integrations, and operator workflows?

#### Working architectural consequences

If the hypotheses are validated, this reset would make the following changes to the implementation
direction:

- Do not add another channel-specific handoff or delivery implementation.
- Do not treat an HTTP 202 or a completed Temporal workflow as proof of customer delivery.
- Do not let an activity return success after a delivery exception without recording that outcome.
- Do not build operator tabs or customer widgets from independently queried state machines.
- Do not rely on static or stale release labels when diagnosing a cross-service execution.
- Keep the current Core boundary as a compatibility adapter until the Agent Platform interaction
  and delivery contracts are proven with real channels.

The first measurable target is one reliable customer interaction across the website and one
messaging channel: admission, agent reply, delivery receipt, handoff acknowledgement, human
message, and operator visibility must all be traceable through one correlation chain.

### Agent Canvas and Execution Observatory

The Agent Platform should treat visual execution as a core platform capability. This is more than
an observability dashboard: it is a shared visual model for how an agent is designed, how a run
progresses, and how an operator or developer investigates a result. The same model must work for
KasiAI, hosted customer-service agents, tenant-created agents, and future multi-agent systems.

The platform should support two related but distinct graphs:

1. The **agent design graph** describes the versioned agent definition: its inputs, context,
   knowledge, reasoning, tools, conditions, approvals, handoffs, waits, parallel branches, child
   agents, and outputs.
2. The **live execution graph** describes one invocation of that definition: which nodes ran, which
   branch was selected, which node is active, what is waiting, what was retried, and where the run
   completed or failed.

The design graph explains what the agent is intended to do. The execution graph explains what
actually happened for a specific customer interaction. They must share stable node identities and
version references, but a run must not mutate the agent definition.

#### Standard node model

The initial node taxonomy should cover the common execution shapes without forcing every agent to
be represented as a large graph:

- input or channel trigger;
- context assembly;
- procedural memory, semantic knowledge, or episodic memory retrieval;
- LLM reasoning or response drafting;
- condition, router, or classifier;
- tool or domain capability;
- approval or consent;
- human handoff;
- wait, schedule, webhook, or external signal;
- parallel branch, fan-out, and fan-in;
- validator, formatter, or policy gate;
- durable external operation;
- child-agent invocation;
- response, channel delivery, or terminal result.

A simple customer-service agent should be represented by a compact generated graph such as:

```text
Incoming message
        |
        v
Context assembly
   |          |
   v          v
Knowledge   Memory
   \\          /
        v
     LLM agent
     /       \\
    v         v
  Tool      Handoff
    |
    v
Validation
    |
    v
Customer reply
```

The user does not need to manually create every node for a simple agent. The runtime should create
the baseline graph from the agent definition and enabled capabilities. Advanced builders can then
configure explicit branches, policies, tools, approvals, and sub-agents.

#### Versioned graph contract

The graph must be a platform contract rather than frontend-only state. A versioned agent graph
should be able to describe at least:

```text
graph_id
agent_version_id
node_id
node_type
label
parent_node_id
input_contract
output_contract
connection_edges
tool_or_agent_reference
approval_policy
timeout_policy
retry_policy
parallelism_policy
visibility_policy
```

Edges must identify the relationship between nodes, including normal sequence, conditional branch,
parallel branch, fan-in, retry, compensation, handoff, and child-agent delegation. A node may be a
collapsed group containing its own graph. This is required for multi-agent systems so a coordinator
can show a research agent as one node while allowing an operator to expand its internal execution.

Agent definitions, graph revisions, and execution instances must be separately versioned. A run
must retain the exact graph, agent, tool catalog, workflow, policy, and host-adapter revisions that
were active when it was admitted.

#### Runtime event contract

Every meaningful node transition should emit a bounded, redacted, versioned event referencing the
graph node:

```text
run.started
node.started
node.waiting
node.completed
node.blocked
node.retrying
node.failed
node.cancelled
knowledge.search.completed
tool.proposed
tool.admitted
tool.blocked
approval.requested
approval.received
operation.started
operation.completed
handoff.requested
handoff.accepted
message.delivered
run.completed
run.failed
```

The event envelope should include:

- event, run, conversation, invocation, and node IDs;
- root and parent invocation references;
- agent, graph, workflow, tool catalog, host adapter, and release versions;
- state, duration, attempt, deadline, and safe reason code;
- provider, connection, operation, approval, receipt, or evidence references where applicable;
- redacted input/output summaries and links to access-controlled detail records.

The event journal is not a replacement for authoritative state. Temporal history and durable run
or operation records remain authoritative for execution and recovery. A transactional event outbox
publishes state transitions to projections so the canvas cannot show a completed node without the
corresponding durable state transition.

The target architecture is:

```text
Agent definition graph
          |
          v
Versioned execution plan
          |
          v
Temporal run and operation events
          |
          v
Event journal and transactional outbox
          |
          v
Materialized graph/timeline projections
          |
          +----------------------+----------------------+
          |                      |                      |
          v                      v                      v
Live run canvas          Operator console       Builder/debug API
```

#### Canvas views and audiences

The same execution model should serve different audiences through visibility policies rather than
separate implementations:

| Audience | Default view | Appropriate detail |
| --- | --- | --- |
| Agent builder | Design graph and version diff | Node configuration, contracts, policies, test runs, and capability requirements |
| Tenant administrator | Agent graph and run history | Current status, failures, approvals, handoffs, delivery, cost, and safe input/output summaries |
| KasiTek operator | Live execution graph and timeline | Cross-service correlation, retries, provider receipts, reconciliation, queue lag, and release identity |
| Developer | Debugger and execution trace | Redacted arguments/results, event ordering, activity attempts, projection lag, and adapter details |
| End customer | Minimal progress state where appropriate | “Searching,” “Waiting for approval,” “Connecting you to a person,” or “Reply sent” |

The primary run view should include a graph, synchronized timeline, current status, last progress,
deadline, version identity, and next safe action. Selecting a node should open a detail panel rather
than placing large payloads inside the node. The panel can show duration, attempts, readiness,
approval state, evidence references, provider receipt, delivery status, and a redacted error.

The canvas should support zoom, pan, minimap, collapsed groups, branch highlighting, synchronized
timeline selection, status filters, and version comparison. Active paths should be visually clear,
but animation must not be the only indication of state. Every status must also have a text label and
accessible representation.

#### Agent-builder experience

Visual authoring must not make simple agents unnecessarily complex. The platform should provide:

- generated baseline graphs for prompt/configuration-based agents;
- templates for common shapes such as customer service, lead qualification, content review, and
  operations monitoring;
- progressive disclosure from simple flow to detailed node configuration;
- typed input/output contracts and validation before publishing a graph;
- capability, approval, timeout, retry, and data-visibility warnings on affected nodes;
- test-run playback using the same live execution graph;
- graph and prompt/configuration version diffs before release;
- exportable graph metadata through an API/SDK without exposing credentials or private reasoning.

Builders should be able to create an agent without understanding Temporal task queues or provider
adapter internals. Those remain implementation details behind the graph and execution contracts.

#### Multi-agent representation

The graph model must support a child agent as a typed, versioned node before multi-agent execution
is enabled. A coordinator could appear as:

```text
Marketing coordinator
  |
  +-- Research agent
  +-- Content agent
  +-- Brand review agent
  `-- Publishing agent
```

Each child needs its own invocation ID, budget, authority, deadline, and result contract. The parent
graph should show child status and aggregation without flattening every child step into one unreadable
canvas. An operator can expand a child only when investigating it.

#### Security and data boundaries

The canvas must never become a side channel for secrets or unrestricted customer data. Visibility
must be enforced by organization, installation, role, and agent ownership. Raw chain-of-thought,
credentials, tokens, raw provider payloads, and unnecessary personal data must not be rendered.
The platform may show safe decision summaries, for example:

> Selected `customer.lookup` because the request required account information.

Sensitive node inputs and outputs should be stored in access-controlled detail records and replaced
in the graph event with bounded summaries or references. Customer-facing views should show progress
and outcomes, not internal implementation or diagnostic data.

#### Live updates and recovery

The canvas should consume a live event stream with cursor replay. Reconnecting a browser must resume
from the last event rather than lose the active path or require a full refresh. The read model must
also support historical reconstruction for completed runs.

Controls such as pause, resume, cancel, retry, reconcile, and reauthorize must be attached to the
underlying state machine and authorization policy. A visual node must not expose an action merely
because it is displayed. Read-only visualization comes first; recovery controls follow once the
corresponding operation transitions and audit records are proven.

#### Questions to validate before implementation

- Should the graph be authored directly by advanced builders, generated from agent configuration,
  or support both modes with one canonical graph contract?
- Which graph nodes are durable execution nodes, and which are explanatory projections of internal
  work such as prompt assembly or provider health checks?
- How much graph detail remains useful before a run becomes unreadable, and which groups should be
  collapsed by default?
- Which event payloads can be safely retained, replayed, and exposed to tenant developers?
- How should graph revisions remain compatible when an agent is edited while runs are active?
- Which live-stream guarantees are required for customer widgets versus operator tooling?
- Which controls can be safely offered to tenant administrators, and which remain KasiTek-operator
  only?

Success means that a builder can inspect an agent definition, an operator can follow a live run from
input to delivery, and a developer can identify the exact failing node, transition, provider, or
release without reading unrelated service logs. The same graph contract must support a simple
customer-service agent today and nested child-agent execution later.

### Multi-agent readiness

The immediate architecture should treat the current single-agent run as a root invocation rather
than as a special execution shape that cannot contain durable children. This does not require
multi-agent execution now. It prevents tools, approvals, MCP calls, provider effects, and future
agent calls from developing separate lifecycle and control models.

```text
Root agent invocation
        |
        +-- model operation
        +-- tool invocation
        +-- human interaction
        +-- MCP invocation
        +-- provider effect
        `-- future child-agent invocation
```

Every durable invocation should be able to record:

```text
invocation_id
root_invocation_id
parent_invocation_id
causation_id
invocation_type
relationship_type
organization_id
installation_id
agent_version_id
context_reference
authority_grant
budget_allocation
deadline
safety_plan_revision
result_contract
status
```

Relationship types must distinguish attached children, detached work, handoffs, tools, human
interactions, provider effects, and compensation. Cancellation normally propagates only through
attached relationships. Every other relationship must declare its behavior explicitly.

The current `agent_loop` workflow node remains an internal reasoning loop within one run. A future
`agent_invocation` node would call a separately installed and versioned agent with narrower context,
authority, budget, deadline, and a typed result. The graph contract should leave room for that node
without implementing it during the initial reliability work.

The eventual `AgentOrchestrator` should sit behind the common invocation interface. Parent agents
would use a small `delegate`, `wait`, `signal`, `cancel`, and `inspect` interface without learning
Temporal child-workflow, task-queue, Nexus, inbox, or result-delivery mechanics. That module remains
future work. The immediate plan establishes the invocation records and invariants it will need.

### Agent Platform hostability and Core decoupling

The Agent Platform is already separately deployable and has its own API, worker, gateway, database,
agent definitions, installations, conversations, runs, approvals, credentials, and execution
evidence. It is not yet fully host-independent. The default runtime still constructs a Core client,
uses Core as the authority for developer API keys, and exposes several `kasitek.core.*` tools for
content, campaigns, bookings, media, channel delivery, and product snapshots.

That coupling is correct when an agent acts on KasiTek product records. It becomes a problem only
when the generic agent runtime assumes that every installation has a KasiTek Core tenant, Core
credentials, and Core-owned data. The plan is to make Core the first host adapter, not a hidden
requirement of every agent run.

```text
                    Agent Platform
 agent versions | installations | conversations | runs | approvals
 memory | invocation graph | durable operations | receipts | evidence
                         |
                         | selected, typed host integrations
          +--------------+---------------+----------------+
          |                              |                |
          v                              v                v
  Host identity adapter       Domain capability adapters   Event, media, and
  tenant/actor/entitlements   content/campaign/CRM/etc.    delivery adapters
          |                              |                |
          +------------------------------+----------------+
                                         |
                                         v
                         KasiTek Core, tenant product, or
                         a customer's approved external system
```

Ownership stays explicit:

| Agent Platform owns | Host owns |
| --- | --- |
| Agent definitions, versions, installations, credentials, sessions, conversations, runs, workflow state, approvals, invocation graph, evidence, budgets, and recovery | Tenant identity, actors, entitlements, business records, domain rules, billing, channels, media, and product-specific delivery |

The target uses three small seams rather than one broad host interface.

1. A host identity adapter establishes the authenticated organization, actor, installation scope,
   and entitlement facts. Core developer-key resolution becomes one adapter. Directly installed
   external agents can use Agent Platform-native installation credentials instead.
2. Typed domain capability adapters perform host-owned business actions. Core content, campaign,
   booking, media, and channel operations become a first-party adapter set. Each capability
   declares its resource selector, authority, result contract, and rollback or reconciliation
   limits.
3. Event, media, and delivery adapters accept inbound events and resolve approved assets or outbound
   delivery without making raw host data part of the generic runtime contract.

Do not create a single `HostIntegration` module with a long list of product methods. It would be a
shallow pass-through and would force every new host to imitate Core. A seam becomes real when two
hosts vary across it. Start with the existing Core implementation and an in-memory contract adapter
for tests. Introduce a second production adapter only when a tenant or external application needs
one.

The generic runtime should select only the adapters required by the admitted capability. A run that
only uses Agent Platform-native conversation, approval, or external provider tools must not fail
because Core is unavailable. A run that targets a Core-owned content record must retain Core's
authorization and product rules. This also gives future role-based teams a safe model: a delegated
agent receives only the host capability, resource scope, and authority that its role needs.

### Upcoming capability slices

The existing batch publishing, tool-action readiness, and knowledge-grounding work is a useful
correctness baseline, but it is not the final Agent Platform contract. The architecture work must
revalidate those capabilities before they are treated as stable features. Their existing plans are
reference material only; this document owns the replacement design and sequencing.

| Upcoming capability | Existing baseline | Architecture dependency | Revalidation gate |
| --- | --- | --- | --- |
| Batch publishing | Durable batches, one approval, per-target status, and explicit `UNKNOWN` outcomes | One invocation and durable-operation interface, provider adapters, tenant domain-capability adapter, and host-scoped resource selection | The batch command runs through the shared operation coordinator for both the Core host and a tenant-host adapter; the Agent does not loop over provider calls; partial and unknown outcomes remain recoverable |
| Tool calling and action readiness | Typed tool registry, readiness vocabulary, approvals, and bounded provider effects | A single tool invocation interface that separates model proposal, host authorization, readiness, operation execution, and observation | Built-in, Core-backed, provider-backed, MCP, and tenant-hosted tools produce the same typed terminal outcome and use the same idempotency, retry, and cancellation rules |
| Knowledge grounding | Scoped lexical/semantic retrieval and deterministic no-evidence behavior | Host-independent context assembly, tenant-scoped evidence references, and a run contract that preserves source and installation scope | Hosted KasiTek and tenant-platform runs enforce the same organization/agent/installation isolation and no-evidence response without requiring Core-specific context code |
| Tenant-platform availability | Tenant identity, portal, and client-scoped data services exist as a host target | Host identity, typed domain capability, and event/media/delivery adapters; no unconditional Core client construction | A hostless Agent Platform installation and a tenant-platform installation can use native and approved provider tools, while host-owned actions retain the host's authorization and data rules |
| Human assistance and handoff | Existing handoff records and continuation paths | Durable human presence, effective availability, capacity, queue eligibility, handoff acceptance, and callback capture behind one interaction interface | The Agent can query current eligible availability, offer a real handoff, distinguish availability from acceptance, and create a durable follow-up when no human can accept |

The intended sequence is:

1. Define host identity, capability ownership, and invocation/operation records.
2. Move tool readiness and provider effects behind those deep interfaces.
3. Revalidate knowledge context and evidence projection against the host-independent run contract.
4. Rebuild batch publishing on the shared operation coordinator and tenant capability seam.
5. Add adapter conformance, tenant-host smoke tests, rollout controls, and release evidence.

Until those gates are complete, the current implementations should be treated as compatibility
baselines, not reasons to freeze their present interfaces or extend their old checklists. Do not
move the reference plans to `completed/` as part of this architecture work; close or archive them
only after the replacement implementation plan records what remains relevant.

### Scope of the override

This plan changes the planning assumptions in four places:

- Batch publishing remains a required user capability, but its current batch-specific tool and
  Core execution path may be replaced by the shared invocation and operation modules defined here.
- Tool calling and readiness become one platform contract. Feature plans must not add another
  provider preflight, retry policy, or result vocabulary.
- Knowledge grounding remains a required correctness guarantee, but retrieval and evidence
  assembly must be re-seated behind the host-independent context seam defined here.
- Session, scaling, and multi-agent research remain design references. Their implementation work
  must be re-derived from this plan's invocation, host, authority, and operation contracts.

## Target contracts and invariants

### Tool invocation

Every tool call should carry or resolve:

- stable tool and action identity plus version;
- run, step, actor, organization, installation, and resource scope;
- normalized provider and connection identity;
- required capabilities and approval class;
- a stable idempotency key;
- bounded deadline and retry policy;
- redaction and output-size policy.

The model may propose a tool call. The execution coordinator decides whether it may be admitted and
whether it may create an external effect.

### Readiness

Readiness must be evaluated before provider work and again immediately before an approved effect.
The result must distinguish at least:

```text
READY
NOT_CONFIGURED
NOT_GRANTED
UNSUPPORTED
REQUIRES_PROVIDER_APPROVAL
REQUIRES_USER_ACTION
UNHEALTHY
UNKNOWN
```

`UNSUPPORTED` and other proven blocked states must produce one terminal tool result and zero
provider calls. They must not be converted into a model retry or a generic connection failure.

### External operation lifecycle

Provider-backed effects should use explicit states rather than a Boolean success flag:

```text
ADMITTED → EXECUTING → CONFIRMED
                    ├→ FAILED
                    ├→ UNKNOWN → RECONCILIATION_REQUIRED → CONFIRMED | FAILED
                    └→ CANCELED
```

An upstream timeout or lost response is `UNKNOWN` unless a provider lookup, webhook, or durable
receipt proves the outcome. Unknown effects must not be blindly retried. A confirmed effect must
not be submitted again because a later readback, usage record, or channel delivery failed.

### Execution events

Events should be append-only, versioned, bounded, redacted, and correlated through:

```text
event_id
run_id
step_id
tool_invocation_id
operation_id
provider
connection_id
attempt
state_revision
occurred_at
release_id
agent_version
```

The event payload should contain a safe reason code, outcome, timing, and remediation metadata. It
should reference sensitive or large data by an access-controlled record rather than embedding it in
the event stream.

The event stream is not a replacement for authoritative state. Durable operation records and
Temporal history own execution state; event projections provide queryable product and operator
views. An outbox or equivalent transactional publication mechanism must prevent a state transition
from becoming invisible to the visual layer.

## Human assistance availability and handoff

Human assistance is a first-class Agent Platform capability, not a prompt instruction or a fixed
fallback message. The Agent must be able to ask the host for current human support availability,
offer a real handoff, and create a durable follow-up when no eligible person can accept the work.

### Presence and effective availability

Human support agents show their presence through the tenant support interface. The initial presence
states are:

- `AVAILABLE`
- `BUSY`
- `AWAY`
- `OFFLINE`

The selected state is not sufficient by itself. Effective availability is derived from:

```text
effective availability =
  manual status is AVAILABLE
  + recent authenticated session heartbeat
  + schedule and queue eligibility
  + supported channel and skill
  + remaining handoff capacity
```

The presence record should include the tenant and support scope, human actor, eligible queues or
skills, supported channels, maximum and current active assignments, last-seen time, expiry time,
status reason, and a monotonic revision. A stale heartbeat or expired presence must not be reported
as available. Accepting a handoff increments active load; reaching capacity makes the person
unavailable for new work until capacity is released.

The host owns human identity, schedules, queues, skills, presence writes, and staffing policy.
Agent Platform owns the durable interaction and handoff lifecycle, invocation evidence, deadlines,
and continuation. The handoff interface must not copy host staff or customer records into generic
runtime state beyond the bounded references required to execute the interaction.

### Availability query and user behavior

The Agent should call a typed availability capability that returns an aggregate result, not an
unreviewed list of staff members. A result should include:

```text
available
eligible_count
estimated_wait
queue_reference
checked_at
availability_revision
```

Individual staff names or presence details are exposed only when the host explicitly permits it.
The normal customer-facing result is that an eligible human is available, unavailable, or that the
current state is unknown.

When a human is available, the Agent may tell the user that assistance is available and create a
durable handoff request with the conversation context, requested queue, channel, deadline, and
authority. Availability and acceptance are separate states: the Agent must not claim that the
handoff succeeded until a human actually accepts it.

When no human is available, the Agent should say so plainly and request only the contact details,
preferred contact channel, and consent needed for follow-up. It then creates a durable callback or
support request containing the bounded conversation context and the user's follow-up preference.
This is a real queueable record that can be assigned and notified later; it is not a hard-coded
"someone will contact you" response.

### Durable interaction lifecycle

The handoff and callback records should use explicit states:

```text
HANDOFF_OFFERED → WAITING_FOR_ACCEPTANCE → ACCEPTED → IN_PROGRESS → RESOLVED
                                 ├→ DECLINED
                                 ├→ EXPIRED
                                 └→ CANCELED

NO_AGENT_AVAILABLE → CALLBACK_REQUESTED → QUEUED → ASSIGNED → CONTACTED → RESOLVED
                                      ├→ CANCELED
                                      └→ EXPIRED
```

The lifecycle must be idempotent and scoped to the organization, installation, conversation, and
host support queue. It must record who accepted or declined, when presence was checked, which
availability revision was used, delivery attempts, expiry and escalation deadlines, and whether
the customer consented to later contact. A lost response or stale presence must create an explicit
unknown or re-check state rather than silently claiming that a person is available.

### Implementation gates

- [ ] Define the host presence and effective-availability contract, including heartbeat expiry,
      schedule, queue/skill, channel, and capacity rules.
- [ ] Add tenant-owned presence writes and support-interface indicators for available, busy, away,
      and offline states.
- [ ] Add an aggregate availability query that returns freshness, eligible count, wait estimate,
      queue reference, and a revision without exposing staff data by default.
- [ ] Add durable handoff offer, human acceptance/decline, assignment, continuation, expiry, and
      cancellation records behind the common interaction interface.
- [ ] Add durable callback-request capture with consent, contact validation, preferred channel,
      bounded conversation context, assignment, notification, and follow-up state.
- [ ] Add channel-specific rendering for availability, acceptance, no-availability, and callback
      capture across web, WhatsApp, Telegram, and other configured gateways.
- [ ] Add presence-staleness, duplicate-delivery, race, capacity, authorization, tenant-isolation,
      handoff-acceptance, callback, and notification failure tests.

Success requires a human support agent to be able to show availability through the tenant interface,
the Agent to receive a fresh and scoped availability result, and every handoff or follow-up to have
a durable owner, state, consent record, and next action.

## Implementation workstreams

### 1. Invocation and orchestration readiness

- [ ] Define one invocation envelope and lifecycle for agent runs, tools, humans, MCP, provider
      operations, and future child-agent calls.
- [ ] Add root, parent, causation, invocation-type, and relationship-type identity to the durable
      execution model and event projection.
- [ ] Define attached, detached, handoff, tool, human, provider-effect, and compensation edge
      semantics, including deadline and cancellation propagation.
- [ ] Define explicit context references and authority attenuation. A future child may receive less
      authority than its parent but can never gain authority through delegation.
- [ ] Define hierarchical model, tool, token, cost, wall-time, and parallelism budgets that can be
      allocated to child work without resetting the root limits.
- [ ] Pin agent, workflow, capability, result-contract, and safety-policy versions to each
      invocation.
- [ ] Represent current single-agent runs as root invocations before enabling an agent destination
      adapter.
- [ ] Keep `agent_loop` and future `agent_invocation` node semantics distinct in the workflow graph
      contract.
- [ ] Confirm that the invocation graph can represent partial failure, unknown effects, durable
      waits, handoffs, compensation, and future result aggregation.

### 2. Agent Platform hostability and Core decoupling

- [ ] Inventory every direct Core dependency in the Agent API, worker, prompt context, capability
      registry, credential resolution, media path, and channel-delivery path.
- [ ] Classify each dependency as Agent Platform-native state, host identity, typed host domain
      capability, or event/media/delivery integration.
- [ ] Define the host identity interface for organization, actor, installation, entitlement, and
      resource-scope facts. Keep Core developer API-key resolution behind its Core adapter.
- [ ] Define typed domain capability interfaces only where behavior varies across a real host seam.
      Do not introduce a broad generic host client.
- [ ] Change the generic runtime to select an approved host adapter for a capability instead of
      constructing a Core client as an unconditional dependency.
- [ ] Keep Agent Platform-native installation credentials, conversations, approvals, workflow state,
      and evidence independent of a host adapter.
- [ ] Move the default `kasitek.core.*` capability set behind the first-party Core adapter while
      preserving existing Core authorization and resource checks.
- [ ] Add contract tests using an in-memory host adapter and a Core adapter. Prove that a hostless
      external installation can execute native and provider-backed tools without a Core call.
- [ ] Add the tenant-platform host contract adapter when its first Agent capability is approved;
      prove that tenant identity, resource ownership, and domain authorization remain host-owned.
- [ ] Pin host-adapter revision, host identity source, and capability owner to each effect record
      and execution event.

### 3. Tool-calling contract

- [ ] Inventory every built-in, Core-backed, MCP, channel, and integration-backed tool.
- [ ] Classify each tool as read-only, proposal-only, approval-required effect, asynchronous
      operation, or reconciliation operation.
- [ ] Normalize tool manifests, required capabilities, target selectors, approval class, timeout,
      output limits, and retry policy.
- [ ] Make the model proposal, authorization/readiness decision, handler execution, and final
      observation separate records.
- [ ] Route all provider-backed tools through one readiness and operation interface.
- [ ] Make blocked and unsupported results terminal for the current request.
- [ ] Ensure normal loops, graphs, decomposed activities, MCP, REST, and direct tool execution use
      the same invocation and outcome rules.

### 4. Integration and provider adapter module

- [ ] Define the smallest provider adapter interface that supports capability discovery, bounded
      execution, status observation, health, and reconciliation.
- [ ] Keep OAuth, connection mode, credential refresh, provider setup, and account identity inside
      the connection/provider implementation rather than agent prompts.
- [ ] Return normalized capability and connection snapshots without exposing raw provider scopes.
- [ ] Make account type and connection mode explicit where they affect capabilities, such as Meta
      Login versus Direct Instagram Login.
- [ ] Add adapter conformance tests for readiness, auth failure, rate limits, timeout, cancellation,
      provider-confirmed success, provider-confirmed failure, and unknown outcomes.
- [ ] Migrate social publishing, messaging, email, and media operations one adapter at a time.
- [ ] Keep a future remote MCP or plugin adapter behind the same seam and review/allowlist it before
      enabling organization-installed providers.

### 5. Durable external operations

- [ ] Define a durable operation record that connects the agent tool call, approval, provider
      request, receipt, attempts, and final observation.
- [ ] Give each effect a stable idempotency key and provider-side idempotency strategy where the
      provider supports one.
- [ ] Separate retryable transport failures, permanent provider failures, authorization failures,
      blocked readiness, and unknown outcomes.
- [ ] Define bounded polling and webhook observation policies for asynchronous providers.
- [ ] Schedule reconciliation as a first-class operation, not as an unbounded retry loop.
- [ ] Preserve partial-success semantics for fan-out actions. A batch is an aggregate of target
      operations, not evidence that every target succeeded.
- [ ] Add safe operator actions for retrying confirmed failures, reconciling unknowns, canceling
      queued work, and reopening a connection. Destructive or effectful controls require explicit
      application confirmation and authorization.

### 6. Agent Canvas, execution visuals, and observability

- [ ] Define the versioned agent design-graph contract, node taxonomy, edge relationships, nested
      groups, visibility policies, and compatibility rules for active runs.
- [ ] Generate a compact baseline graph for simple prompt/configuration-based agents so builders do
      not need to author unnecessary nodes manually.
- [ ] Map every durable node transition and meaningful internal operation to the shared event
      envelope, including model, knowledge, tool, approval, handoff, wait, operation, delivery,
      retry, and child-agent events.
- [ ] Define the event envelope and state-transition vocabulary before building charts.
- [ ] Project run, step, tool, approval, wait, operation, provider, and delivery records into
      queryable read models.
- [ ] Build separate design-graph and live-execution views using the same node identities without
      allowing a run to mutate the versioned agent definition.
- [ ] Provide a run overview with current state, last progress, deadline, agent/workflow version,
      release identity, model usage, and safe next action.
- [ ] Provide a timeline showing model decisions, tool proposals, readiness, approvals, waits,
      retries, provider calls, receipts, reconciliation, and user delivery.
- [ ] Provide a graph view showing sequential nodes, parallel branches, fan-in, paused work,
      blocked nodes, failed nodes, and the currently active step.
- [ ] Show root, parent, and child invocation relationships and whether each edge is attached,
      detached, a handoff, a tool, a human interaction, a provider effect, or compensation.
- [ ] Provide an operation detail view showing provider, connection, capability decision, attempt,
      timeout, provider request identifier, redacted error, receipt, and reconciliation state.
- [ ] Provide a per-target batch view with one lane per destination and an aggregate state that does
      not hide partial or unknown results.
- [ ] Provide a connection/capability view showing the account mode, current health, supported
      actions, missing access, and last verification time.
- [ ] Provide release identity on every run: agent version, tool catalog revision, workflow
      revision, worker build, Core/API build, configuration revision, and feature flags.
- [ ] Support live updates with replay from a cursor so reconnecting a browser does not lose events.
- [ ] Provide builder, tenant administrator, KasiTek operator, developer, and customer-facing
      visibility policies over the same projections and event stream.
- [ ] Add graph version diffing, test-run playback, collapsed child-agent groups, minimap/zoom,
      branch highlighting, synchronized timeline selection, and accessible text status labels.
- [ ] Redact prompts, tool arguments, outputs, tokens, and provider payloads according to data
      classification. Operators should see enough to diagnose without receiving secrets or full
      customer content by default.
- [ ] Add dashboards and alerts for stuck runs, missing heartbeats, unknown effects, reconciliation
      backlog, provider error rate, retry volume, event projection lag, and delivery failures.

### 7. Durable execution and workflow decomposition

- [ ] Use the existing Temporal workflow as the authoritative durable sequence.
- [ ] Split model calls, tool calls, approvals, external effects, observations, and completion into
      independently bounded activities where the current activity boundary can repeat unrelated work.
- [ ] Persist a checkpoint before and after every meaningful external or human-controlled step.
- [ ] Ensure worker replacement replays completed observations without invoking providers again.
- [ ] Make cancellation produce a known terminal result or `UNKNOWN` plus reconciliation rather than
      silently abandoning the run.
- [ ] Keep workflow state, product evidence, and visualization events versioned independently.
- [ ] Evaluate Restate or another runtime only through a narrow failure-recovery comparison; do not
      introduce a second runtime without an explicit ownership and migration decision.

### 8. Testing, release, and operational learning

- [ ] Add a fake provider adapter that can deterministically delay, fail, duplicate, drop, and
      reorder responses.
- [ ] Run worker-kill tests before and after model calls, tool calls, approvals, external requests,
      receipt persistence, reconciliation, and user delivery.
- [ ] Run provider contract tests for every adapter and record which guarantees are provider
      limitations rather than KasiTek failures.
- [ ] Test a batch with ready, blocked, failed, confirmed, processing, and unknown targets.
- [ ] Test event replay, duplicate events, out-of-order events, projection lag, and browser
      reconnect from a cursor.
- [ ] Test version mismatch detection across Agent Platform, Core, workers, provider adapters,
      tool catalogs, and agent installations.
- [ ] Add an operator runbook for stuck runs, unknown effects, expired credentials, provider outage,
      projection lag, and rollback.
- [ ] Use staged rollout and explicit feature flags for each new execution path. Preserve the
      compatibility path until recovery evidence is complete.

## Proposed delivery sequence

### Phase 0 — Contract and inventory

- [ ] Reconcile the existing action platform, readiness, batch publishing, and provider-adapter
      contracts into one vocabulary.
- [ ] Define the generic invocation envelope, lifecycle, graph-edge semantics, authority
      attenuation, hierarchical budgets, deadline propagation, and cancellation propagation.
- [ ] Map every Core dependency to an explicit owner and adapter category before moving any call.
- [ ] Define the first host identity and typed domain-capability interfaces from the existing Core
      behavior. Test them with an in-memory adapter before naming another production host.
- [ ] Inventory all external tool calls and record their current owner, timeout, retry behavior,
      provider effect, and failure evidence.
- [ ] Define the operation state machine, event envelope, reason-code registry, and release identity
      fields.
- [ ] Define the Agent Canvas graph contract, node taxonomy, edge semantics, nested-agent display,
      audience visibility levels, and design-graph versus live-run responsibilities.
- [ ] Select the first visual proof path: one simple customer-service agent and one tool-using
      agent, with enough events to trace input through final delivery.
- [ ] Select two representative adapters: one synchronous/read-heavy integration and one
      asynchronous/effectful integration.

### Phase 1 — Reliability kernel around existing adapters

- [ ] Assign root invocation identity to existing agent runs and parent-child identity to current
      tool, approval, MCP, provider, and compensation work before adding agent delegation.
- [ ] Route current Core-backed tools through the first-party Core adapter while retaining the
      existing authorization and resource-selection behavior.
- [ ] Add the shared operation coordinator around the current provider adapters.
- [ ] Enforce readiness, idempotency, bounded timeout, error classification, and terminal result
      behavior.
- [ ] Complete the provider-adapter conformance harness.
- [ ] Migrate the current social publishing path first because it exercises permissions, media
      processing, fan-out, partial results, and ambiguous provider outcomes.

### Phase 2 — Integrations and common tool execution

- [ ] Apply the same operation contract to messaging, media delivery, email, and other provider
      actions.
- [ ] Permit a hostless external installation to run Agent Platform-native and direct-provider
      capabilities without creating or contacting a Core tenant.
- [ ] Move connection health, capability snapshots, and remediation into the shared integration
      module.
- [ ] Add background connection verification and reauthorization state without automatically
      re-running the original effect.
- [ ] Review remote MCP and plugin installation against the same capability, egress, timeout,
      output, approval, revision, and audit requirements.

### Phase 3 — Execution Observatory

- [ ] Publish structured lifecycle events from Agent Platform, Temporal activities, Core, provider
      adapters, and channel delivery.
- [ ] Build the Agent Canvas design view and live execution overlay from the same versioned graph
      and event contracts.
- [ ] Build read projections for run overview, timeline, graph, operation detail, connection health,
      batch targets, and release identity.
- [ ] Add builder test-run playback, graph/version comparison, nested child-agent expansion, and
      role-based visibility for tenant administrators, operators, developers, and customers.
- [ ] Add live subscriptions, cursor replay, redaction, and access control.
- [ ] Add operator recovery controls only after the underlying operation transitions are proven.

### Phase 4 — Production hardening

- [ ] Run staged worker-loss, provider-fault, event-replay, and version-mismatch tests.
- [ ] Compare reliability, latency, retry, unknown-outcome, reconciliation, and user-delivery
      metrics against the compatibility path.
- [ ] Enable decomposed execution by workload class and organization/provider allowlist.
- [ ] Promote the exact tested artifact, configuration revision, and migration set.
- [ ] Complete a post-release review and remove compatibility paths only after their removal criteria
      are met.

## Success measures

The implementation is successful when the following can be demonstrated with automated tests and
staged runtime evidence:

- A blocked or unsupported action makes zero provider calls and returns one terminal result.
- A provider timeout never becomes an unqualified success or an automatic blind retry.
- A worker can die before or after every tool/effect checkpoint without duplicating a confirmed
  external effect.
- An unknown provider result becomes a visible reconciliation task with a clear next action.
- A batch shows confirmed, failed, blocked, processing, and unknown targets independently.
- A user and operator can follow one correlation chain from inbound message to agent run, tool call,
  provider operation, and final delivery.
- A current single-agent run appears as a root invocation with typed child edges, and its deadline,
  budget, authority, cancellation, and safety metadata remain consistent across those children.
- An external installation can run Agent Platform-native and provider-backed actions without a
  Core client, while a Core-owned action still uses Core authorization and domain rules through the
  first-party adapter.
- Every run identifies the exact agent, tool catalog, workflow, worker, Core/API, configuration, and
  release versions that executed it.
- A new provider adapter cannot be enabled without passing the shared conformance suite and declaring
  unsupported provider guarantees.
- Event projection lag, missing heartbeats, unknown effects, and delivery failures produce metrics,
  alerts, and actionable runbook entries.
- A builder can inspect a versioned agent design graph, an operator can follow a live execution graph,
  and a developer can expand nested work without reading unrelated service logs.

## Release record for future implementation

| Field | Initial decision |
| --- | --- |
| Change | Architecture improvement spanning invocation identity, future orchestration readiness, Agent Platform hostability, agent tool execution, provider integrations, durable external operations, and the Agent Canvas and Execution Observatory. |
| Owner | Agent Platform and Platform Integrations; Operations owns dashboards, alerts, and release gates. |
| Risk | High. The work changes authentication, external side effects, workflow recovery, and operator controls. |
| Affected services and user surfaces | Agents API, Agents worker, Temporal workflows, Core and future tenant-platform host adapters, provider workers, MCP Gateway, channel delivery, Connections, run/operation views, and operator tooling. |
| Platform release version or release ID | To be assigned per implementation tranche. Planning document only: not applicable. |
| API/schema/migration changes | Expected for invocation identity and graph edges, operation records, host-adapter linkage and revision, event projections, and version metadata; exact migrations are deferred to scoped implementation plans. |
| Feature flag or rollout method | Required. Use workload/provider/organization allowlists and preserve the compatibility path during rollout. |
| Analytics events and success metrics | Required. Add registry-backed lifecycle metrics for readiness, adapter selection, tool outcomes, provider effects, unknowns, reconciliation, projection lag, and delivery. |
| Logs, metrics, dashboards, and alerts | Required. Use structured redacted events and the existing OpenTelemetry contract; identify host adapter, Collector configuration, and release identity for each deployment. |
| User, API, internal, and operational documentation | Required for implementation releases. Public documentation is not applicable to this planning-only document. |
| Validation evidence | Required: unit, adapter contract, failure-injection, worker-loss, projection replay, staged runtime, provider smoke evidence, and tenant-platform host smoke evidence. |
| Rollback or disable plan | Disable the new execution path by flag, stop new admissions, leave in-flight operations on reconciliation, and promote the last tested compatibility artifact. No destructive rollback of durable evidence. |
| Post-release review date | To be assigned with each implementation tranche. |

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Durable runtime | Keep Temporal as the authoritative workflow runtime for now. | Agent Platform | Decided for planning |
| Integration runtime | Build a KasiTek-owned provider/integration module; do not add Nango as a hard dependency. | Platform Integrations | Decided for planning |
| Restate evaluation | Study Restate's journal, durable calls, parallelism, and approval model; run a focused comparison only if a concrete Temporal gap remains. | Agent Platform | Open |
| External-effect seam | Place readiness, idempotency, receipts, and reconciliation between action execution and provider adapters. | Agent Platform and Core | Decided for planning |
| Event source | Use authoritative operation/run records plus transactional events and read projections; do not build the visual layer from raw logs alone. | Agent Platform and Operations | Decided for planning |
| Trace standard | Use OpenTelemetry-compatible spans for cross-service traces while retaining KasiTek product events for state and recovery. | Operations | Proposed |
| Visual control scope | Start read-only. Add retry, reconcile, cancel, and reauthorize controls only after state transitions and authorization are verified. | Product and Operations | Open |
| Plugin/MCP scope | Keep organization-installed providers reviewed, revision-pinned, egress-limited, and capability-gated. Arbitrary code requires a separate sandbox module. | Agent Platform and Security | Decided for planning |
| Provider coverage | Prove the contract with two representative adapters before migrating the complete provider catalog. | Platform Integrations | Open |
| Multi-agent readiness | Build the generic invocation and graph contracts now; defer the child-agent adapter and `AgentOrchestrator` until a separately approved implementation plan. | Agent Platform | Decided for planning |
| Delegation policy | Define context selection, authority attenuation, child budget allocation, result contracts, and approval ownership before enabling agent-to-agent calls. | Agent Platform and Security | Open |
| Agent Platform hostability | Keep the Agent Platform separately deployable with its own durable state. Make Core a first-party host adapter rather than a universal runtime dependency. | Agent Platform and Core | Decided for planning |
| Host adapter design | Start with host identity, typed domain capability, and event/media/delivery adapters. Add a production seam only after a second real host varies across it. | Agent Platform and Core | Decided for planning |

## Related documents

- [Agent platform architecture audit](../../architecture/agent-platform-architecture-audit.md)
- [Action platform technical design](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/internal/architecture/action-platform-technical-design.md)
- [Calls Core consolidation](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/internal/architecture/calls-core-consolidation.md)
- [Agent workflow execution](../../architecture/workflow-execution.md)
- [Agent tool action readiness plan](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/plans/completed/AGENT_TOOL_ACTION_READINESS_PLAN.md)
- [Agent batch publishing plan](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/plans/completed/AGENT_BATCH_PUBLISHING_PLAN.md)
- [Agent platform comparison research](./AGENT_PLATFORM_COMPARISON_RESEARCH.md)
- [Multi-agent orchestration research](./AGENT_MULTI_AGENT_ORCHESTRATION_RESEARCH.md)
- [Agent execution, communication, and scaling architecture](./AGENT_EXECUTION_SCALING_AND_SESSION_ARCHITECTURE_PLAN.md)
- [Tenant platform execution plan](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/plans/completed/TENANT_PLATFORM_EXECUTION_PLAN.md)
- [Release process](https://github.com/Kasitek-Labs/kasitek-growth/blob/main/docs/internal/operations/release-process.md)
