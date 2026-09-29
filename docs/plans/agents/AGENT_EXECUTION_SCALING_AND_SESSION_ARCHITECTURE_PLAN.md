# Agent Execution, Communication, and Scaling Architecture Plan

**Status:** Superseded architecture reference

**Owner:** Agent Platform

**Last updated:** 2026-09-04

**Planning note:** This document records a proposed architecture direction. It is not an
implementation checklist and does not authorize code, schema, deployment, or provider changes.
The canonical implementation direction is
[`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](./AGENT_PLATFORM_IMPLEMENTATION_PLAN.md).

## Objective

Give each agent installation durable, isolated conversation sessions and one communication model
for routing work between agents, humans, MCP providers, tools, and external systems. The design must
scale across many users while preserving ordered processing within one conversation.

The target behavior is:

- messages for the same conversation are durably queued and processed in order;
- messages for different conversations execute independently and in parallel;
- waiting for approval, an external event, or a timer does not occupy a worker process;
- capacity pressure produces visible queueing and fair scheduling rather than unexplained failures;
- agent, human, MCP, and external-system communication uses one durable invocation lifecycle;
- callers can submit, signal, cancel, and inspect work without learning each destination's internal
  delivery mechanism;
- operators can inspect one ordered execution journal and its parent-child invocation graph;
- pause, resume, cancel, force termination, retry, and compensation have distinct, audited behavior;
- every durable invocation has a pinned safety plan for approval, deadlines, retries, escalation,
  compensation, and uncertain effects;
- human and external waits use one durable interaction lifecycle rather than destination-specific
  callback flows;
- agent runs, approvals, tool effects, and provider outcomes retain their existing durable evidence;
- the system can scale workers without making a session dependent on one process or host.

Kasitek will keep Temporal as the durable execution runtime. This plan adopts the useful session
and concurrency properties demonstrated by Restate without adopting Restate as a dependency.

## Scope

### Included

- A durable session identity and per-session ordering model.
- A Temporal-native session coordinator for conversation-backed agent work.
- Durable queueing of messages and session requests.
- Independent execution of different session keys.
- Fair capacity control at organization, installation, agent, provider, and workload levels.
- A common durable invocation contract for agent-to-agent, agent-to-human, MCP, tool, and provider
  communication.
- Request-response, one-way, delayed, attach, signal, cancellation, and deadline semantics.
- Destination adapters behind one routing interface.
- A canonical, redacted execution journal and parent-child execution graph.
- Operator controls for safe pause, resume, cancellation, force termination, retry, and
  compensation.
- A versioned safety plan for approvals, deadlines, retries, escalation, compensation, and
  uncertain effects.
- A common durable interaction model for approvals, clarification, handoff, human tasks, and
  external results.
- End-to-end deadline propagation and durable, owned escalation work.
- Progress-based stuck-work detection and production observability requirements.
- Integration with the existing run, approval, effect-receipt, and reconciliation models.
- Worker scaling, task-queue separation, and session-level execution visibility.
- Migration, compatibility, rollout, and rollback design for the future implementation.

### Excluded

- Switching from Temporal to Restate.
- Replacing PostgreSQL with an embedded session key-value store.
- Rewriting the existing agent run, approval, or provider-effect lifecycle in this planning phase.
- Allowing concurrent writes inside one conversation.
- Treating a large worker-count setting as a substitute for admission control or fair scheduling.
- Defining every organization, plan, or provider quota before the session model is agreed.
- Implementing A2A interoperability before its authorization, trust, and readiness decisions are
  accepted.
- Treating agent-version rollback or effect reconciliation as execution rollback.

## Context and constraints

Restate models a stateful agent session as a keyed Virtual Object. State is isolated per key,
write handlers are serialized per key, different keys run in parallel, and requests to a busy key
are queued. Restate also keeps services stateless, journals execution, and can suspend waiting
handlers. These properties are described in the [Restate durable sessions documentation](https://docs.restate.dev/ai/patterns/sessions),
[service model](https://docs.restate.dev/foundations/services), and
[architecture documentation](https://docs.restate.dev/foundations/key-concepts).

Kasitek already has related foundations:

- conversations and messages are durable PostgreSQL records;
- each run has a unique run ID and a separate Temporal workflow;
- one active run is currently allowed per conversation;
- different conversations can already execute in parallel;
- approvals resume a waiting Temporal workflow through signals;
- provider effects use idempotency keys, receipts, and reconciliation states;
- worker activity and workflow concurrency are currently bounded in the Temporal worker;
- installation policy can currently define `maxConcurrentRuns`.

The important gap is that the current conversation admission rule rejects a second run with
`conversation_run_active`. It protects state, but it is not a durable per-session queue. The current
installation policy can also reject work at an active-run limit instead of representing the work as
queued capacity.

Kasitek also has several working communication paths, but they do not share one durable lifecycle:

- Temporal signals deliver approval, cancellation, expiration, and external-event controls to an
  existing run;
- the customer handoff module durably records offers, requests, ownership changes, and continuation;
- the MCP gateway accepts stateless MCP requests, while remote MCP providers are called through
  bounded HTTP requests with health and per-minute rate controls;
- REST, channel, and product ingress paths create agent runs;
- provider effects use idempotency keys, receipts, and reconciliation;
- Core delegation tokens authorize a specific capability invocation, but do not implement
  agent-to-agent messaging.

These paths solve individual problems. They do not yet form a durable communication layer with one
invocation identity, acknowledgement model, queue policy, cancellation path, or result contract.

Relevant implementation references from the assessed Growth source snapshot:

- [run admission](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/db/repositories/run-repository.ts#L70)
- [one-active-run guard](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/migrations/088_conversation_run_admission_guard.sql#L18)
- [Temporal workflow starter](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/temporal/client.ts#L24)
- [Temporal worker concurrency](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/temporal/worker.ts#L134)
- [Temporal recovery model](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/docs/internal/runbooks/agent-temporal-recovery.md#L204)
- [conversation ordering contract](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/docs/internal/architecture/agent-conversation-ordering.md#L27)
- [Core delegation token](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/core/delegation.ts#L3)
- [Temporal run signals](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/temporal/workflows.ts#L62)
- [remote MCP invocation](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/mcp/remote.ts#L87)
- [future A2A readiness position](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/docs/internal/architecture/action-platform-technical-design.md#L764)

## Architecture direction

The Temporal-native equivalent of a Restate Virtual Object is a long-lived, keyed
`ConversationSessionWorkflow`.

```text
organization + installation + conversation
                    |
                    v
        ConversationSessionWorkflow
          durable ordered session queue
                    |
        ┌───────────┼───────────┐
        v           v           v
     Run 1       Run 2       Run 3
  Temporal     Temporal     Temporal
  run          run          run
```

The session coordinator owns ordering and queue admission. The existing agent run workflow owns
agent execution. This keeps the module interface small for callers while hiding queue claims,
ordering, retries, capacity, and Temporal interaction inside the coordinator implementation.

The session key should be derived from the organization, installation, and conversation. A
conversation ID alone is not sufficient because all authorization and data ownership decisions
are organization- and installation-scoped.

## Communication and flow control

Restate combines communication and flow control in one invocation model. A handler can make a
request-response call, send a one-way message, schedule a delayed message, attach to a previous
invocation, send a signal, or cancel work. Calls can carry an idempotency key, a concurrency scope,
and a subgroup limit key. Keyed handlers serialize writes for one key while different keys execute
in parallel. Restate documents its current scope and limit-key flow control as a preview feature, so
Kasitek should adopt the design properties without copying that interface directly.

Kasitek has the transports and several local controls. What it lacks is one durable communication
module and one scheduler that apply the same lifecycle and capacity rules across those transports.

### Current comparison

| Area | Restate model | Kasitek currently | Required Kasitek direction |
| --- | --- | --- | --- |
| Agent-to-agent work | Durable calls and messages between keyed handlers | No first-class A2A execution protocol; Core delegation only signs capability authorization | Durable recipient inbox, request and result contracts, acknowledgement, deadline, cancellation, and parent-child execution links |
| Invocation styles | Request-response, one-way send, delayed send, attach, signal, and cancel | Mostly synchronous invocation or agent-run creation, with run-specific signals | Standard submit, signal, cancel, inspect, and attach behavior independent of destination |
| Same-session traffic | A busy key queues later writes | A second conversation run receives `conversation_run_active` | Accept and durably queue ordinary messages in session order |
| Human interaction | Durable workflow interaction can wait and resume | Approval and customer handoff are separate state machines | Keep their domain rules but route both through a common human-work lifecycle and invocation identity |
| MCP communication | Calls participate in the durable invocation model | Inbound MCP is stateless; remote MCP calls are bounded HTTP request-response operations | Durable MCP invocation evidence, asynchronous completion where supported, cancellation, retries, queueing, and consistent recovery |
| Capacity control | Scoped and hierarchical concurrency | Installation run limits, remote MCP rate limits, gateway limits, worker caps, and run-level branch leases are independent | One capacity scheduler with organization, installation, workload, destination, and operation scopes |
| Tenant fairness | Scope and subgroup controls can isolate callers | Installation limits do not provide organization-wide fairness | Organization and plan quotas, weighted fairness, reserved interactive capacity, and noisy-neighbour isolation |
| Worker isolation | Work can be routed and limited by invocation scope | One Temporal task queue has hard-coded workflow and activity concurrency | Separate task queues and autoscaling signals for interactive, batch, provider, model, and maintenance work |
| Backpressure | Accepted work waits until its scope has capacity | Admission commonly returns a conflict or concurrency failure | Return an accepted invocation ID with queued state, queue age, deadline, and a defined overflow result |
| End-to-end control | An invocation can be attached to, signalled, or cancelled by ID | Controls target individual agent runs; nested calls have no common control path | Propagate deadlines and cancellation through agent, human, MCP, tool, and provider descendants |
| Execution visibility | Nested invocations share a durable call graph | Correlation evidence exists, but communication paths expose different records | Build one parent-child execution graph with queued, running, waiting, retrying, unknown, failed, and completed states |

### Invocation router module

The proposed `InvocationRouter` should be a deep module with a small interface. Callers should not
need to know whether the destination uses a Temporal workflow, a PostgreSQL human task, an MCP HTTP
request, or a provider adapter.

```text
Agents / channels / humans / MCP clients
                    |
                    v
             InvocationRouter
        submit | signal | cancel | inspect
                    |
                    v
       Durable inbox and admission scheduler
 session ordering | quotas | priority | deadlines
                    |
        +-----------+------------+
        |           |            |
        v           v            v
 Agent adapter  Human adapter  MCP and tool adapter
        |           |            |
        +-----------+------------+
                    |
                    v
        Durable result and execution graph
```

The external interface should stay close to four operations:

- `submit` accepts a durable invocation and returns `accepted`, `already_accepted`, or a defined
  admission failure;
- `signal` delivers an approval, clarification, external event, or other control to existing work;
- `cancel` requests cancellation and propagates it to descendants where the destination supports it;
- `inspect` returns status and bounded result evidence for the caller and operator views.

Each invocation should carry:

- invocation, correlation, causation, and optional parent invocation IDs;
- organization, installation, conversation, actor, and authorization context;
- destination, capability, and contract version;
- idempotency key and bounded payload reference;
- priority, deadline, and queue policy;
- retry, cancellation, and result-delivery policy;
- trace context and the agent or platform release identity used for execution.

The router implementation should use destination adapters. Agent adapters can start or signal
Temporal workflows. Human adapters can create approval, clarification, or handoff work records and
resume the waiting workflow. MCP and tool adapters can execute bounded activities, record attempts,
and reconcile uncertain results. External provider adapters keep their provider-specific receipt
logic behind the same invocation lifecycle.

### Unified flow-control model

The capacity scheduler should admit work through hierarchical scopes rather than independent limits
hidden in each caller. A future invocation may consume capacity from several scopes at once:

```text
platform
  -> organization
    -> plan or entitlement
      -> installation or agent
        -> workload class
          -> destination provider or MCP server
            -> operation type
```

The scheduler must distinguish waiting work from executing work. An approval or human response can
remain durable for days without consuming an activity slot or provider lease. Interactive messages
should retain reserved capacity so a large batch or failing MCP provider cannot block every
conversation. Provider and MCP limits need separate concurrency, rate, and failure controls.

Backpressure should normally produce an accepted queued invocation. It should reject work only when
the queue is full, the deadline cannot be met, policy forbids the request, or the destination is
unavailable under an explicit admission rule. Every outcome must be visible to the caller and in the
execution graph.

### Communication work required in a future implementation

The communication work should proceed as design and implementation slices, not as a single rewrite.

First, define the invocation envelope and lifecycle. This includes acknowledgement, deduplication,
result delivery, parent-child relationships, ordering, deadlines, cancellation, and terminal states.

Next, place the `InvocationRouter` in front of new communication paths and adapt existing run
creation, approval, external-event, handoff, and MCP invocation paths gradually. Existing domain
rules remain authoritative during migration.

Then add durable inbox and outbox records where PostgreSQL must expose product or operator evidence.
Temporal remains responsible for workflow coordination and durable waits. PostgreSQL remains
responsible for tenant-owned records, audit evidence, queue projections, and external-effect
receipts.

After that, add the capacity scheduler with organization fairness, workload priority, queue limits,
and per-destination capacity pools. Replace ordinary same-conversation rejection with durable
queueing only after its acknowledgement and ordering contract is tested.

Then split Temporal task queues by workload and publish queue depth, queue age, schedule-to-start
latency, capacity use, throttling, and noisy-neighbour metrics. Configure worker concurrency and
autoscaling from measured demand instead of hard-coded limits alone.

Finally, expose the invocation tree in the execution visualizer. Operators should be able to follow
one request through agent runs, human waits, nested agent work, MCP calls, tools, provider effects,
retries, and reconciliation without joining records manually.

This section covers communication and flow control only. The following sections assess
observability, execution control, and production safety.

## Observability and control

Restate presents observability and execution control through one invocation model. Its UI and
introspection data expose invocation state, pending inbox work, retry state, journal entries, stored
state, deployment identity, and nested calls. Operators can pause, resume, cancel, kill, restart,
and inspect an invocation by one identity. Restate treats rollback as durable compensation, not as
changing a deployment version or editing the recorded outcome of an external effect.

Reference behavior is documented in [Restate Observability and Control](https://docs.restate.dev/ai/patterns/observability-control),
[Managing Invocations](https://docs.restate.dev/services/invocation/managing-invocations),
[Introspection](https://docs.restate.dev/services/introspection), and
[Rollback on Failures](https://docs.restate.dev/ai/patterns/rollback).

Kasitek already persists much of the evidence needed for a comparable operator experience. The
problem is fragmentation. Run events, run steps, model calls, tool calls, approvals, workflow
checkpoints, effect receipts, delivery attempts, Temporal state, and OpenTelemetry traces use
related identifiers but do not form one canonical execution journal or control lifecycle.

### Existing foundations

Kasitek currently has:

- durable `agent_events` ordered by a run-local sequence number;
- run steps, model operations, tool invocations, approval records, workflow checkpoints, effect
  receipts, provider delivery attempts, and reconciliation records;
- a run timeline endpoint that joins events, steps, tool calls, and effect receipts;
- a client run-detail view with a live server-sent event timeline and redacted execution evidence;
- Temporal signals for approval, cancellation, expiration, and external events;
- durable operator commands with idempotency keys, expected-state checks, audit records, and
  approval requirements;
- run cancellation, retry-as-new, effect reconciliation, budget reconciliation, installation
  suspension, schedule pause, incident holds, feature flags, and scoped kill switches;
- OpenTelemetry traces, metrics, and logs with correlation and release identity propagation;
- operator projections for failed runs, old queued runs, unknown effects, failed deliveries,
  failed model calls, provider failures, and projection lag.

Relevant current implementation references:

- [run timeline endpoint](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/http/app.ts#L4557)
- [run detail view](<https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/client/apps/client/src/app/(dashboard)/agents/activity/[runId]/page.tsx#L22>)
- [live run timeline](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/client/apps/client/src/components/dashboard/agents/agent-run-live-timeline.tsx#L20)
- [operator commands](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/http/operator-commands.ts#L18)
- [operator projections](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/http/operator-projections.ts#L36)
- [run cancellation signal](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/temporal/client.ts#L45)
- [workflow cancellation handling](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/agents/src/temporal/workflows.ts#L62)
- [kill-switch controls](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/client/apps/client/src/components/dashboard/agents/agent-kill-switch-controls.tsx#L10)
- [OpenTelemetry architecture](https://github.com/Kasitek-Labs/kasitek-growth/blob/ec9190819b5f202df60fa67cc6ed8a6764a9bf18/docs/internal/operations/observability.md#L16)

These foundations reduce the amount of new runtime machinery required. The future work should
join and standardize them rather than create a second evidence system.

### Current comparison

| Area | Restate model | Kasitek currently | Required Kasitek direction |
| --- | --- | --- | --- |
| Execution journal | One ordered durable journal contains every invocation step | Run events, steps, model calls, tool calls, approvals, effects, checkpoints, and deliveries are separate records | Build one canonical ordered and redacted journal projection without discarding the authoritative source records |
| Invocation state | Pending, ready, running, backing off, suspended, and completed states are inspectable | Run state exists, but Temporal retry timers, workflow state, queue blockers, and provider waits are not joined | Define one normalized execution state and preserve the underlying Temporal and domain state |
| Nested calls | Parent and child calls appear in one execution graph | Correlation and causation identifiers exist, but there is no navigable call tree | Add parent invocation identity and graph edges for agents, MCP, humans, tools, providers, and compensation work |
| Stored state | Invocation journal and keyed state can be inspected together | PostgreSQL business state and Temporal coordination state require separate investigation | Expose a bounded state projection with source, revision, ownership, and redaction metadata |
| Pause | Operators can pause active or retrying invocations | `pauseRun` is an internal transition for approvals, handoffs, and external events | Add an operator pause request that stops new steps at a safe checkpoint and preserves resumable state |
| Resume | A paused invocation can continue, including an explicit deployment override | Approval and external events resume specific waits; run retry creates a new run | Resume the same paused run and define when a newer worker deployment may continue it safely |
| Cancel | Cooperative cancellation reaches the call tree and permits cleanup | A signal is checked by the workflow, commonly after the current activity completes | Propagate cancellation into active activities and descendant invocations, then record cleanup and unresolved effects |
| Kill | Immediate termination stops the invocation tree without cleanup | Kill switches block capability execution by scope but do not immediately terminate a running invocation | Add a last-resort force-termination control and keep kill switches as a separate admission policy |
| Retry and restart | Operators can resume retries, restart as new, or restart from a journal prefix | Retry creates a new run from the original input | Support retry-current-step, resume-from-checkpoint, restart-as-new, and later restart-from-safe-prefix |
| Rollback | Durable compensation actions undo completed effects in reverse dependency order | Version rollback changes the selected agent version; reconciliation records an uncertain effect outcome | Add typed, idempotent compensation actions with approval, evidence, and reconciliation |
| Stuck detection | Operators can inspect retries, blockers, pending inbox work, and last journal progress | Projections count failures, old queued runs, and unknown effects | Detect lack of progress using the current step, last progress time, retry count, wait age, queue blocker, and worker dispatch state |
| Tracing | Durable steps and nested calls produce one connected trace | OpenTelemetry and correlation propagation exist | Add spans for every logical operation and link traces to journal and invocation identities |
| Production retention | Runtime introspection has explicit retention and purge behavior | The production telemetry destination, retention, access policy, dashboards, and alert ownership remain undecided | Approve and operate a durable telemetry destination while PostgreSQL keeps authoritative product evidence |
| Operator safety | Controls target one invocation identity and expose their outcome | Operator commands are durable and audited, but control semantics differ by target | Put run and descendant controls behind one interface with consistent preconditions and outcomes |

### Control terminology and invariants

The design must keep these controls distinct. Reusing one word for different behavior would make
incident response unsafe.

| Control | Required behavior | External-effect rule |
| --- | --- | --- |
| Pause | Stop scheduling new logical steps at the next safe checkpoint and retain resumable state | Do not claim that an in-flight provider request stopped; wait for its outcome or mark it unknown |
| Resume | Continue the same paused invocation from its recorded checkpoint | Reuse completed operation results and effect receipts |
| Cancel | Cooperatively stop the invocation tree and run registered cleanup or compensation | Record the outcome of every cleanup action and reconcile uncertain effects |
| Force terminate | Stop workflow execution when cancellation cannot complete | Mark every unresolved started effect as unknown; never imply that external work was undone |
| Retry step | Retry one failed transient operation within the same logical invocation | Require the same operation identity and provider idempotency protection |
| Restart as new | Create a new invocation from the original request | Do not inherit partial progress unless the operator explicitly selects a safe checkpoint strategy |
| Restart from checkpoint | Create or resume execution using a verified durable checkpoint | Replay completed evidence and reject incompatible code or contract versions |
| Compensate | Execute registered inverse actions for completed effects | Compensation is a new external effect with its own approval, idempotency key, receipt, and reconciliation state |
| Kill switch | Block admission or capability execution for a configured scope | It does not prove that already-started work stopped or rolled back |

A control request must never rewrite or delete historical evidence. It appends a new journal entry,
records the actor and reason, and produces its own durable outcome. Force termination and
compensation require stronger authorization than ordinary cancellation.

### Canonical execution journal

The journal should be a projection over existing authoritative records, not another uncontrolled
event stream. Each entry should have:

- a stable journal entry ID and monotonic sequence within the invocation;
- invocation, parent invocation, run, organization, installation, conversation, and correlation
  identifiers where applicable;
- a normalized operation type such as model call, tool call, approval, human wait, MCP call,
  provider effect, delivery, control, compensation, or workflow transition;
- lifecycle state, attempt number, start time, finish time, duration, next retry time, and deadline;
- bounded and redacted input, output, error, and provider evidence references;
- idempotency, effect, approval, checkpoint, and deployment identifiers;
- actor, authorization decision, policy decision, and control-request identifiers;
- replay status that distinguishes newly executed, replayed, reconciled, compensated, skipped, and
  unknown work;
- source-record type, source-record ID, and source revision so an operator can verify the projection.

The journal must preserve gaps and projection lag explicitly. It must not invent a clean sequence
when a source record is delayed or unavailable. Raw prompts, credentials, tokens, message bodies,
and unrestricted provider payloads must not enter operator or telemetry views by default.

### Execution graph

The communication section introduces a durable invocation identity and parent-child relationship.
The execution graph should use those same identifiers:

```text
Session request
      |
      v
Primary agent invocation
      |
      +-- model operation
      |
      +-- tool invocation
      |       |
      |       +-- approval wait
      |       |
      |       +-- provider effect
      |               |
      |               +-- reconciliation or compensation
      |
      +-- delegated agent or MCP invocation
              |
              +-- nested operations
```

Each node should show state, attempts, duration, deadline, current blocker, worker or deployment
identity, and whether the operator may control it. Each edge should state why the child exists and
whether cancellation propagates. Detached one-way work must appear as detached, not as a child that
will automatically stop with its parent.

The product view and the operator view should use the same graph projection. The product view can
hide internal and sensitive entries. The operator view can expose more evidence under explicit
permissions and audit.

### Execution control module

The proposed `ExecutionControl` module should hide Temporal commands, database transitions,
provider cancellation, approval cleanup, compensation execution, and audit recording behind one
interface.

```text
Operator UI / automation / incident response
                       |
                       v
                ExecutionControl
 inspect | pause | resume | cancel | terminate | recover
                       |
                       v
              Invocation and journal graph
                       |
        +--------------+--------------+
        |              |              |
        v              v              v
 Temporal adapter  Human adapter  MCP and provider adapters
        |              |              |
        +--------------+--------------+
                       |
                       v
              Audited control outcome
```

The interface should remain small:

- `inspect` returns normalized invocation state, journal progress, descendants, blockers, and
  available controls;
- `requestControl` accepts pause, resume, cancel, or terminate with expected state and revision;
- `recover` accepts retry-step, restart-as-new, restart-from-checkpoint, or compensate with an
  explicit recovery policy;
- `inspectControl` returns acknowledgement, progress, affected descendants and effects, and the
  final control outcome.

The implementation should translate a control request through adapters. The Temporal adapter owns
workflow signal, cancellation, termination, query, history, and reset interaction. Human-work
adapters close or preserve approvals and handoffs according to the selected control. MCP, tool, and
provider adapters attempt cancellation only where the destination supports it. The effect module
marks unresolved outcomes as unknown and opens reconciliation work.

Every control request should record:

- target invocation and selected descendants;
- expected invocation state and journal revision;
- actor, reason, source, and authorization decision;
- requested mode and cleanup or compensation policy;
- acknowledgement, start, timeout, and completion timestamps;
- affected activities, approvals, human tasks, and external effects;
- operations that stopped, completed before the control took effect, could not be stopped, or
  became unknown;
- source and target deployment identity for resume or checkpoint recovery;
- final outcome and any required follow-up reconciliation.

### Pause, resume, and cancellation design

An operator pause should set a durable pause request and prevent the workflow from scheduling its
next logical operation. If a model, tool, MCP, or provider activity is already running, the control
view should report `pause_pending` until that operation finishes or reaches its cancellation
deadline. A paused invocation should not hold model, tool, provider, or worker capacity.

Resume should verify that the agent version, workflow contract, tool contracts, checkpoint schema,
and target worker deployment can interpret the recorded state. Continuing on a newer deployment is
allowed only through an explicit compatibility decision. An incompatible change should require
restart-as-new or a version-specific migration rather than an unsafe resume.

Cancellation should be cooperative first. It should propagate to attached descendants, signal
cancellable activities, cancel pending approvals and human waits, and run registered cleanup or
compensation. A timeout should move the request to `cancellation_stalled`, not silently mark the run
cancelled. The operator can then reconcile the blocker or request force termination.

Force termination is a last resort. It stops Temporal execution and prevents further workflow
steps, but cannot recall an external request already accepted by a provider. The control module
must identify every started effect without a confirmed outcome and mark it unknown before releasing
the invocation's execution lease.

### Compensation and rollback

Execution rollback should use a saga-style compensation model. An effect-producing capability can
declare an optional compensation capability and the data required to invoke it. After a forward
effect succeeds, the workflow registers a durable compensation record. If later work fails or an
authorized operator requests rollback, compensation executes in reverse dependency order.

Compensation must not be automatic for every failure. The policy depends on the operation:

- reversible low-risk effects may compensate automatically after a terminal workflow failure;
- privileged or financially material effects may require human approval;
- irreversible effects must report that rollback is unsupported and identify manual recovery;
- an unknown forward effect must be reconciled before compensation, because the system cannot undo
  an action it cannot prove occurred;
- a failed or unknown compensation creates its own reconciliation case.

Each compensation action needs a stable operation ID, idempotency key, authorization decision,
approval record where required, effect receipt, provider result, and journal entries. Retrying a
compensation must not duplicate the inverse action.

Agent-version rollback remains a deployment operation. It selects an earlier agent version for new
work and does not rewind an existing run. Effect reconciliation remains an evidence operation. It
records what happened and does not undo it. The UI and operator documentation must keep these three
meanings separate.

### Stuck-work detection

The system should classify stuck work from durable progress evidence rather than age alone. A
detector should consider:

- current normalized state and the last journal progress timestamp;
- expected duration and deadline for the current operation type;
- Temporal schedule-to-start age, activity heartbeat, attempt count, backoff, and next retry time;
- session queue age and the invocation that currently blocks promotion;
- approval, human, and external-event wait age compared with their explicit expiry;
- model, MCP, tool, provider, and delivery timeout state;
- unknown external effects and unresolved reconciliation work;
- worker availability, task-queue backlog, deployment reachability, and release identity;
- cancellation or pause requests that have not reached a safe checkpoint;
- parent and child disagreement, such as a completed parent with an attached active child.

The detector should classify work as healthy waiting, capacity queued, retrying, blocked by human,
blocked by dependency, cancellation stalled, reconciliation required, orphaned, or stuck. Each
classification should explain the evidence and suggest only controls that are safe in that state.

Alerts should use age and severity thresholds by workload. An interactive conversation and a
scheduled batch do not share the same acceptable delay. Alert deduplication should key on the
invocation and stuck classification, and recovery should close or downgrade the alert.

### Telemetry and retention

OpenTelemetry should complement the durable journal. It should not become the authoritative source
for product state or external-effect safety. Logical operations should emit spans carrying
invocation ID, parent invocation ID, run ID, operation ID, organization-safe scope, workflow and
activity identity, attempt, status, release ID, and bounded error code.

The execution view should link from a journal operation to its trace and from a trace back to the
durable operation. Sampling must not remove the journal. Sensitive content remains governed by
application redaction even when the Collector also redacts attributes.

Before this work can support production incident response, Kasitek must choose and operate a
durable telemetry destination. The decision must include retention, access roles, tenant and staff
privacy, deletion, region, cost controls, dashboard ownership, alert ownership, staging separation,
and an exporter-disable procedure. The current debug Collector proves transport only.

### Observability and control work required in a future implementation

First, define the normalized invocation lifecycle, journal entry contract, graph edge types,
control terminology, authorization rules, and redaction policy. Map every existing run, event,
step, model, tool, approval, checkpoint, effect, delivery, and Temporal state into that model.

Next, build the journal and execution-graph projections over existing records. Add explicit source
identity, revisions, projection lag, and gaps. Upgrade the current run-detail page to consume this
projection before introducing new destructive controls.

Then introduce the `ExecutionControl` module and route current cancellation, retry, reconciliation,
holds, installation suspension, schedule pause, and kill-switch actions through it where their
semantics match. Keep broad kill switches and deployment rollback as separate control types.

After that, implement true safe-point pause and same-run resume. Add cancellation propagation into
activities and attached descendants. Record cleanup progress and require reconciliation for effects
that remain uncertain.

Then add force termination with strict authorization, confirmation, audit, unknown-effect handling,
and recovery guidance. It should be unavailable until the system can enumerate affected descendant
work and started effects reliably.

Next, define the compensation contract and add it to a small set of reversible capabilities. Prove
reverse-order execution, idempotent compensation, approval behavior, unknown-effect blocking, and
compensation reconciliation before widening support.

Then add retry-current-step, restart-as-new, and checkpoint recovery. Restart from a selected
journal prefix should remain deferred until operation replay, version compatibility, and effect
safety can be proven.

Finally, add progress-based stuck detection, workload-specific alerts, the joined operator view,
and links between journal entries and OpenTelemetry traces. Approve the production telemetry
destination, retention, access policy, dashboards, alerts, and runbooks as a separate operational
release decision.

This section covers observability and execution control. The next section defines the safety policy
that governs those controls and the outcomes of approvals, timeouts, retries, escalation, and
compensation.

## Production safety

Restate combines approvals, durable waits, timeouts, retry exhaustion, and compensation with its
invocation runtime. A handler can create a durable promise, suspend without holding a worker, and
resume when an authenticated external request resolves it. Timeouts and retry exhaustion remain
part of the recorded invocation, while rollback is implemented as durable, reverse-order
compensation rather than history deletion.

Reference behavior is described in [Human-in-the-loop with durable
promises](https://docs.restate.dev/ai/patterns/human-in-the-loop), [Error handling and
timeouts](https://docs.restate.dev/guides/error-handling), and [Rollback on
failures](https://docs.restate.dev/ai/patterns/rollback).

Kasitek has a strong approval foundation. An approval is bound to the capability version,
arguments hash, resource snapshot, preview revision, policy revision, permitted effect key,
approver, and expiry. Approval consumption and effect start are atomic. Channel actions use signed,
expiring tokens, and the system reauthorizes the action before executing the effect. The platform
also has bounded run and tool execution, customer handoff records, operator commands, effect
receipts, reconciliation, scoped kill switches, and some domain-specific inverse operations.

The missing part is a common production-safety model. Approval delivery, expiry, handoff,
clarification, external results, timeout outcomes, retry exhaustion, escalation, and compensation
are implemented through separate flows. Their individual rules work, but each new durable wait or
failure policy requires repeated callback and workflow plumbing.

### Current comparison

| Area | Restate model | Kasitek current state | Required direction |
| --- | --- | --- | --- |
| Approval wait | Durable promise suspends and resumes the invocation | Durable approval record plus channel-specific delivery, callback handling, and Temporal signals | Preserve approval integrity behind one durable interaction interface |
| Approval binding | Application policy controls what the approval authorizes | Strong binding to capability, arguments, resource, preview, policy, effect, approver, and expiry | Retain the current binding as the authoritative approval contract |
| Human delivery | Resolution endpoint is independent of workflow code | Telegram, Discord, Core, and WhatsApp paths branch in activity code | Move delivery and fallback behavior behind adapters |
| Decision types | One durable primitive supports arbitrary external decisions | Approval, handoff, clarification, and external events use different records and handlers | Use one typed durable interaction lifecycle |
| Timeout policy | Invocation and handler timeouts are runtime-visible | Activity timeouts, HTTP timeouts, graph limits, and approval expiry are configured separately | Compile one deadline hierarchy and pass remaining time to child work |
| Retry exhaustion | Runtime retry policy can pause or terminate work | Retry limits exist, but exhaustion outcomes are mostly local error handling | Define a policy outcome for each terminal retry class |
| Rollback | Durable compensation runs completed inverse actions in reverse order | Reconciliation and a few inverse domain actions exist; no common saga contract | Add typed, idempotent compensation declarations and records |
| Escalation | Suspended work can remain addressable until externally resolved | Customer handoff and operator notifications exist, but escalation is not a general safety primitive | Create durable, owned escalation work with acknowledgement deadlines |
| Safety visibility | Invocation state and journal expose waits, retries, and controls | Evidence is distributed across approvals, runs, events, effects, handoffs, and Temporal | Project the pinned safety plan and every safety transition into the execution journal |

### Callback plumbing gap

Today, a new human or external wait commonly requires most of this chain:

```text
create domain record
        |
        v
deliver destination-specific request
        |
        v
receive callback and authenticate it
        |
        v
validate and update the record
        |
        v
signal the Temporal workflow
        |
        v
branch for resolution, expiry, cancellation, and audit
```

Approval and customer handoff each implement variations of this chain. Adding another interaction
type would repeat it. Temporal can still provide the durable wait, but Kasitek needs a deep module
that hides record creation, callback tokens, delivery, signals, deduplication, expiry, fallback,
and evidence from the workflow that requested the interaction.

### Pinned safety plan

A `SafetyPolicy` module should compile a versioned `SafetyPlan` when an invocation is admitted. The
plan is pinned to that invocation so a policy deployment cannot silently change the behavior of
already admitted work.

```text
invocation + capability + tenant policy
                  |
                  v
             SafetyPolicy
                  |
                  v
              SafetyPlan
        /         |          \
 approval     deadlines     retries
 escalation   compensation  uncertain effects
```

The plan should define:

- whether approval is required, the approval type, eligible approvers, delegation rules, and the
  evidence that must be bound to the decision;
- the invocation deadline, child-operation budgets, queue expiry, provider confirmation window,
  and human-decision expiry;
- transient and terminal error classes, retry limits, backoff, and the outcome when retries are
  exhausted;
- compensation eligibility, approval requirements, ordering, and irreversible conditions;
- escalation triggers, destination, severity, acknowledgement deadline, reassignment, and expiry;
- behavior for an unknown external effect, including when reconciliation blocks all further work;
- cancellation, force-termination, cleanup, and evidence-retention requirements.

The execution journal should record the safety-plan ID and revision on admission and expose the
specific rule responsible for every blocked, timed-out, escalated, compensated, or terminated
state.

### Durable interaction module

The target interface should be small:

```text
DurableInteraction.open(type, subject, policy, payload)
DurableInteraction.resolve(interactionId, actor, decision)
DurableInteraction.cancel(interactionId, reason)
DurableInteraction.inspect(interactionId)
```

It should support approval, clarification, escalation, human task, handoff, and external-result
interactions. Internally it may use PostgreSQL records, Temporal signals and timers, signed action
tokens, delivery adapters, and fallback channels. Callers should not need to know those mechanics.

Resolution must validate tenant ownership, actor eligibility, revision, expiry, expected state,
decision schema, and deduplication key before resuming the workflow. Late, duplicate, conflicting,
or unauthorized responses must be recorded but must not change the completed decision.

### Deadline and timeout model

Kasitek currently has broad Temporal Activity timeouts, heartbeat settings, retry limits, local
provider timeouts, graph execution limits, and commonly hard-coded approval expiry. These controls
do not form one end-to-end deadline. A retry can therefore consume time without every nested call
knowing how much of the original request budget remains.

The future deadline hierarchy should cover:

```text
invocation deadline
  -> queue wait
  -> model operation
  -> tool operation
  -> provider request
  -> provider confirmation
  -> human decision
  -> compensation
```

Each child receives the remaining parent budget; retries do not reset it. Every timeout must have
an explicit policy outcome: retry, pause, ask for clarification, escalate, compensate, mark the
effect unknown, fail safely, or terminate after a grace period. A timeout must never leave the run
in an unexplained processing state.

### Durable escalation

Escalation should be an owned work item, not only a notification. Customer handoff remains a
domain-specific adapter, while the common escalation record supports agent operations and other
workloads.

Escalation triggers should include failed approval delivery, approval nearing expiry, retry
exhaustion, provider circuit or outage, unknown external effects, stuck runs, stalled cancellation,
compensation failure, and budget exhaustion. Each escalation should record its trigger, severity,
eligible responders, primary and fallback channels, acknowledgement deadline, claim state,
deduplication key, escalation level, reassignment or expiry rule, resolution, and links to the
blocked invocation and journal entries.

Notifications remain delivery attempts. They do not prove that an escalation was received,
claimed, or resolved.

### Compensation safety

Rollback cannot mean deleting execution history or assuming that an external effect can be undone.
Each reversible capability should declare its forward capability, compensation capability,
required receipt fields, approval policy, deadline, and irreversible conditions. A successful
forward effect creates a durable compensation record that can later be executed in reverse order.

The policy should distinguish:

- low-risk reversible effects that may compensate automatically;
- privileged compensation that requires a fresh approval;
- irreversible effects that require manual recovery rather than a false rollback claim;
- unknown forward effects that must be reconciled before compensation;
- failed or unknown compensation that creates its own reconciliation and escalation work.

Compensation is itself an external effect and needs an idempotency key, receipt, retries,
reconciliation, journal entries, and an explicit terminal state.

### Production safety work required in a future implementation

The future implementation should first define and version `SafetyPolicy` and `SafetyPlan`, then
introduce `DurableInteraction` without changing the existing approval contract. Approval and
customer handoff can migrate behind that interface one path at a time.

Next, propagate one invocation deadline through queues, model work, tools, provider calls, human
waits, and compensation. Replace generic retry exhaustion with policy outcomes that are visible in
the journal.

Then introduce durable escalation work and migrate current operator notifications and eligible
handoff cases into its delivery adapters. Pilot compensation on a small set of reversible
capabilities before allowing general saga execution.

Finally, add the safety-plan view, durable interactions, timeout decisions, escalation ownership,
and compensation state to the execution visualizer. Validation must cover duplicate and late human
responses, delivery fallback, deadline exhaustion, worker loss while waiting, cancellation races,
unknown provider effects, reverse-order compensation, and failed compensation.

This completes the initial assessment of the five Restate claims: durable execution, state and
session coordination, communication and flow control, observability and control, and production
safety. The resulting direction remains Temporal-native and keeps PostgreSQL as the authoritative
product and audit store.

## Durable step recovery and effect-safe replay

Durable recovery is a separate architecture pillar from session coordination. A session queue
prevents concurrent state corruption; durable step recovery prevents a worker failure from losing
progress or repeating work that has already produced a known result.

Restate describes this as journaling each step and replaying completed results after a crash. The
Temporal-native Kasitek equivalent is a stable logical operation for every model call, tool
invocation, and provider effect:

```text
Temporal workflow
        |
        v
durable model operation
        |
        v
durable tool operation
        |
        v
durable external effect
        |
        v
confirmed | failed | unknown -> reconciliation
```

Every logical operation should have:

- a stable operation ID and idempotency key where applicable;
- persisted, bounded, and redacted input and output evidence;
- an explicit transient or terminal failure classification;
- a bounded retry policy with observable attempts and backoff;
- a completion record that can be replayed instead of executing the operation again;
- a provider-effect receipt and reconciliation path when the external outcome is uncertain.

Temporal records completed Activity results in workflow history and reuses them during workflow
replay. An Activity whose completion was not recorded may execute more than once, including when a
worker fails after an external system accepted a request but before Temporal received the Activity
result. Write Activities therefore cannot rely on Temporal retries alone. They must be idempotent,
or be protected by a durable effect receipt and provider-supported idempotency key. When neither a
provider result nor reconciliation proves the outcome, Kasitek must record `UNKNOWN` and must not
blindly repeat the effect.

Kasitek already has stable model and tool operation keys, completed tool invocation replay,
approval records, effect receipts, provider idempotency keys, and reconciliation-required states.
The remaining concern is granularity: some compatibility paths perform several model and tool
operations inside a larger `executeLoop` Activity. Temporal only journals the Activity as one
workflow step, so recovery of completed internal operations depends on Kasitek's own operation
records. The target design is that each logical model, tool, and effect operation is independently
observable, replay-safe, and recoverable even when it remains inside a larger compatibility
Activity during migration.

The execution view should distinguish operations that were completed normally, replayed from
durable evidence, retried after a transient failure, blocked by policy, or left unknown for
reconciliation. A recovered run must not claim that a provider effect was repeated or completed
unless the corresponding durable evidence proves it.

## Target behavior

### Same session

Only one write-producing run is active for a session at a time. A later ordinary message is stored
as a queued session request and processed after the current run reaches a terminal state.

Approval actions, cancellation actions, and operator controls are not ordinary messages. They are
routed directly to the relevant waiting run or session coordinator. This prevents an approval
button from being delayed behind the message it is intended to approve.

### Different sessions

Different conversation keys have independent Temporal workflow histories and can execute in
parallel. A customer conversation waiting for approval must not block another customer
conversation using the same agent installation.

### Ordering and delivery

The session queue owns a monotonically increasing sequence for ordinary inbound work. Outbound
responses are associated with their run and delivered in session order. Redelivered provider events
are deduplicated by provider identity and idempotency key.

### Versioning

Each queued request is pinned to the agent version selected at admission. A deployment does not
change the behavior of an already admitted run. New requests can use the latest published version.
This preserves the existing agent-version ownership model and avoids mixing instructions or tool
contracts within one run.

## Temporal and PostgreSQL responsibilities

Temporal owns:

- session coordinator workflow identity and lifecycle;
- durable waiting for new work, approval, cancellation, timers, and child-run completion;
- scheduling workflow and activity tasks across workers;
- workflow replay and recovery after worker loss;
- continuation-as-new for long-lived session histories.

PostgreSQL owns:

- conversations, messages, session queue records, and business state;
- idempotency and provider-event uniqueness;
- run, approval, effect-receipt, and reconciliation evidence;
- authorization, installation policy, quotas, and audit records;
- read projections used by the product and operator views.

The Temporal workflow should store queue cursors, IDs, and bounded coordination state rather than
the complete conversation transcript. PostgreSQL remains the source of truth for tenant data and
large or sensitive records.

## Proposed modules and seams

### Session admission module

The admission interface should accept an authenticated session request and return a durable result
such as `accepted`, `already_queued`, or `queue_full`. It should hide idempotency, sequence
allocation, version pinning, and queue persistence from channels, REST, MCP, and UI callers.

### Session coordinator module

The coordinator should expose the minimum operations needed to start or signal a session, inspect
its queue, and route control events. Its implementation should claim the next request atomically,
start the corresponding run, wait for completion, release capacity, and continue with the next
request.

### Run execution module

The existing `agentRunWorkflow` remains responsible for model/tool execution, approvals, external
events, effect receipts, retries, and reconciliation. It should not become responsible for
discovering or ordering unrelated messages in the same conversation.

### Capacity scheduler module

Capacity should be represented separately from session ordering. The scheduler should account for
interactive work, batch work, model calls, provider effects, and provider-specific limits. A full
capacity pool should leave work queued, subject to an explicit queue-depth or deadline policy.

## Work sequence for a future implementation

The work should proceed as several separately reviewable design and implementation slices.

First, define session identity, queue semantics, approval routing, message ordering, version
pinning, maximum queue age, and behavior during human handoff. This decision must be made before a
schema is introduced.

Next, add the durable session-request record and admission module behind the existing ingress paths.
The first release should support idempotent queueing while retaining the current run workflow.

Then add the keyed session coordinator and connect it to the existing run workflow. The coordinator
should use Temporal Signal-with-Start or an equivalent race-safe start-or-signal operation. It
should use continue-as-new to bound workflow history and should recover safely if a worker fails
between queue claim, run start, and completion.

After that, replace normal same-conversation rejection with queueing. Keep the current database
invariant as a safety guard for active execution, but allow multiple queued requests outside the
active execution lease.

Then introduce capacity scheduling and task-queue separation. Interactive conversation work,
background jobs, batch publishing, and provider effects should not compete as one undifferentiated
pool. Worker concurrency should become configuration and deployment capacity, not the only form of
backpressure.

Finally, add session queue and execution projections, run load tests, and roll out behind a feature
flag. Existing runs should continue under the current workflow path during migration; new session
admission should move gradually to the coordinator.

## Comparison with Restate

| Restate property | Temporal-native Kasitek design |
| --- | --- |
| Session key provides serialization and queueing | `ConversationSessionWorkflow` owns one durable queue per scoped conversation key |
| Same-session request is queued | Session requests are persisted and claimed in order instead of returning `conversation_run_active` |
| Different keys execute in parallel | Different session workflows execute independently on shared Temporal task queues |
| Runtime journals durable steps | Temporal journals workflow execution; Kasitek operation records replay completed model and tool results; PostgreSQL stores product and provider evidence |
| Recovery skips completed work | Stable operation IDs reuse completed results; uncertain provider effects enter reconciliation instead of being blindly repeated |
| Built-in flow control | A Kasitek capacity scheduler manages quotas, leases, priorities, and provider limits |
| Stateless replicas scale horizontally | Temporal workers remain stateless and scale by task queue and workload |
| Waiting does not occupy a worker | Temporal conditions, signals, timers, and child-workflow waits are durable |
| Embedded key-value session state | PostgreSQL remains authoritative; workflows retain only bounded coordination state |
| Runtime per-key consistency | Temporal workflow identity plus PostgreSQL sequence, idempotency, and claim constraints |
| Immutable deployment routing | Agent version is pinned per admitted request and deployment identity is recorded |
| One inspectable invocation journal | A Kasitek journal projection joins authoritative run, operation, approval, effect, delivery, checkpoint, control, and Temporal state records |
| Nested call inspection | Parent invocation IDs and graph edges connect agent, human, MCP, tool, provider, and compensation work |
| Pause and resume | Safe-point pause and same-run resume preserve checkpoint and operation evidence |
| Cooperative cancellation | `ExecutionControl` propagates cancellation through attached descendants and records cleanup outcomes |
| Immediate kill | Force termination is a separate last-resort control that marks unresolved effects unknown |
| Restart and rollback controls | Kasitek distinguishes retry, restart, checkpoint recovery, deployment rollback, reconciliation, and durable compensation |
| Durable human decisions | `DurableInteraction` provides one authenticated, expiring, deduplicated lifecycle for approvals, clarification, handoff, escalation, and external results |
| Runtime safety policy | A pinned `SafetyPlan` defines approval, deadlines, retries, escalation, compensation, cancellation, and uncertain-effect behavior per invocation |
| End-to-end time budget | The invocation deadline is propagated to queues and child operations; retries consume rather than reset the remaining budget |
| Retry-exhaustion control | Each terminal retry class produces a declared outcome such as pause, escalation, reconciliation, compensation, or safe failure |
| Durable rollback | Typed inverse capabilities execute from durable compensation records in reverse order, with their own approval and effect evidence |
| Escalation without callback-specific workflow code | Durable escalation work owns acknowledgement, assignment, fallback delivery, expiry, and resolution while Temporal suspends the blocked invocation |

The difference is that Restate packages the session queue, state store, and durable execution
coordination into one runtime. Kasitek would keep those responsibilities explicit because its
PostgreSQL model also carries organization isolation, provider connections, permissions, approvals,
effect receipts, analytics, and product history.

## Decisions still requiring separate planning

| Topic | Current position | Status |
| --- | --- | --- |
| Durable runtime | Keep Temporal | Direction agreed |
| Session key | Organization + installation + conversation | Proposed |
| Same-session messages | Queue ordinary messages; route approvals and controls directly | Proposed |
| Run ownership | Session coordinator orders work; existing run workflow executes it | Proposed |
| Queue storage | PostgreSQL authoritative queue records | Proposed |
| Queue overflow | Needs a product and operations decision: bounded queue, expiry, or plan-based limits | Open |
| Fairness | Add organization and installation scheduling, not only installation active-run limits | Open |
| Worker scaling | Separate task queues and autoscaling signals | Open |
| Long-lived workflow history | Use continue-as-new and bounded workflow state | Proposed |
| Customer-visible status | Expose queued, running, waiting, blocked, failed, and completed states | Open |
| Message behavior during approval | Define whether later messages wait, append context, or can cancel the pending proposal | Open |
| Cross-conversation shared work | Define whether duplicate work can be coalesced or must remain isolated | Open |
| Journal source of truth | Keep domain records authoritative and build a canonical projection | Proposed |
| Execution graph | Use invocation identity and explicit parent-child or detached edges | Proposed |
| Safe-point pause | Stop before the next logical operation and expose `pause_pending` for active work | Proposed |
| Same-run resume | Verify workflow, agent, tool, and checkpoint compatibility before continuation | Proposed |
| Cancellation propagation | Cooperatively cancel attached descendants and record cleanup | Proposed |
| Force termination | Last resort with strict authorization and unknown-effect handling | Proposed |
| Compensation | Typed, idempotent, policy-controlled inverse capabilities | Proposed |
| Safety-plan source | Define how platform defaults, tenant policy, capability metadata, and incident controls compile into one pinned plan | Open |
| Durable interaction ownership | PostgreSQL stores product and audit state; Temporal owns suspension, timers, and resumption | Proposed |
| Approver eligibility | Define roles, delegation, separation of duties, fallback approvers, and emergency override rules | Open |
| Deadline hierarchy | Define defaults and maximums for admission, queueing, operations, providers, human waits, and compensation | Open |
| Retry exhaustion | Define the safe terminal outcome for each workload and failure class | Open |
| Escalation routing | Define ownership, severity, acknowledgement targets, fallback channels, reassignment, and expiry | Open |
| Compensation eligibility | Classify reversible, approval-gated, irreversible, and reconciliation-blocked capabilities | Open |
| Restart from journal prefix | Defer until replay and effect safety are proven | Open |
| Stuck-work thresholds | Define by workload, operation type, deadline, and blocker | Open |
| Production telemetry destination | Retention, access, dashboards, and alert ownership need a separate decision | Open |

## Release impact when implementation begins

This will be a high-risk platform change because it changes message admission, database state,
Temporal workflow ownership, queue behavior, operator controls, durable interactions, deadlines,
escalation, execution recovery, compensation, observability, and user-visible latency.

The future implementation release record must identify:

- **Owner:** Agent Platform, with Platform Operations and Product review.
- **Affected surfaces:** channel ingress, website conversations, MCP/REST invocation where
  conversation-backed, agent runs, approvals, operator views, run timelines, reconciliation,
  handoff, durable interactions, escalation, execution controls, telemetry, and worker deployment.
- **Schema changes:** additive session queue, sequence, claim, invocation graph, journal projection,
  safety plan, durable interaction, escalation, control request, compensation, and migration
  records.
- **Rollout:** feature flag with staged organization or installation rollout.
- **Analytics:** admission, queued, dequeued, capacity-limited, session-busy, paused, resumed,
  cancelled, termination-requested, compensated, recovery-started, completed, and aged-queue events
  plus approval-delivery failure, interaction expiry, deadline outcome, retry exhaustion,
  escalation creation, acknowledgement, reassignment, and resolution using the registered
  analytics contract.
- **Observability:** queue depth and age, schedule-to-start latency, active sessions, last journal
  progress, stuck classification, control latency, cancellation and termination outcomes,
  interaction age, remaining deadline, retry-exhaustion outcomes, unacknowledged escalations,
  compensation failures, run handoff, worker capacity, provider throttling, and session ordering
  failures. Logs and traces must carry the pinned safety-plan revision.
- **Documentation:** internal architecture, recovery and execution-control runbooks, compensation
  guidance, safety-policy and escalation references, configuration reference, operator control
  semantics, and public behavior documentation once queueing or controls are user-visible.
- **Validation:** concurrency integration tests, duplicate delivery tests, worker-loss tests,
  approval-resume tests, duplicate, late, conflicting, and unauthorized decisions, delivery
  fallback, deadline propagation and exhaustion, retry-exhaustion policy, escalation ownership,
  pause and cancellation races, force-termination tests, descendant propagation, compensation order
  and idempotency, checkpoint compatibility, projection gaps, migration tests, load tests, and
  provider-effect safety tests.
- **Rollback:** disable new admission and control routing, drain or safely resume queued work,
  durable-interaction routing, and escalation automation; retain the old approval and handoff paths;
  retain the old run timeline; and preserve all run, approval, interaction, escalation, control,
  compensation, and effect evidence. No destructive queue or journal migration should be required
  for rollback.
- **Release identity:** record the platform release ID, commit SHA, migration version, Temporal
  worker artifact, workflow and checkpoint compatibility version, telemetry configuration revision,
  safety-policy revision, and deployed agent-version behavior.

Until those decisions are made, this document remains an architecture proposal rather than a build
plan.
