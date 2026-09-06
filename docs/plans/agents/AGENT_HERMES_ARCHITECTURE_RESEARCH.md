# Hermes Architecture Research for KasiTek

**Status:** Research input; no implementation decision

**Owner:** Agent Platform and Platform Integrations

**Last updated:** 2026-09-06

**Scope:** Evaluate Nous Research's Hermes Agent as a source of runtime and product-design
patterns for KasiTek's agent platform. This document does not propose replacing Temporal, adopting
Hermes as a production dependency, or copying its implementation wholesale.

## Executive conclusion

Hermes is worth studying because it addresses several of the same failure modes we have been
seeing: context growth, tool-call coordination, channel delivery, long-running sessions, memory
boundaries, and specialist-agent delegation. Its strongest ideas are runtime patterns rather than
its infrastructure choice.

The useful direction for KasiTek is:

```text
Hermes runtime patterns
        |
        +-- context engine and compaction
        +-- model-visible result budgeting
        +-- observable and interruptible tool execution
        +-- durable delivery obligations
        +-- isolated specialist runs
        +-- platform-independent agent core
        |
        v
KasiTek Agent Platform
Temporal + PostgreSQL + capability policy + provider adapters + tenant boundaries
```

Hermes should therefore be treated as the reference architecture for the agent-runtime capabilities
we need to mature. The planning direction is to align KasiTek with those capabilities and
behavioral boundaries, then implement them using KasiTek's own durable execution, tenancy,
authorization, and provider infrastructure. Temporal remains the durable execution layer for this
direction; this work is not a proposal to replace it.

The distinction is important:

```text
Adopt the capability model and runtime patterns
        |
        v
Implement them with Temporal, PostgreSQL, KasiTek policy, and adapters
        |
        v
Validate the result against the same reliability and observability expectations
```

This is an alignment decision for planning, not an implementation authorization. Each capability
still needs a scoped design, compatibility assessment, migration path, and failure-injection
evidence before it is introduced into production.

## What Hermes is doing well

Hermes is structured around a shared agent runtime with multiple entry points: CLI, messaging
gateway, API, batch execution, and library use. Those entry points converge on an agent loop that
assembles prompts, resolves providers, dispatches tools, persists sessions, compresses context,
and emits progress. Its architecture documentation explicitly separates the core runtime from
gateway adapters, tool backends, storage, and delivery.

See the [Hermes architecture overview](https://hermes-agent.nousresearch.com/docs/developer-guide/architecture)
and the [official repository](https://github.com/NousResearch/hermes-agent).

### 1. It treats context as a managed runtime resource

Hermes does not assume that sending the entire accumulated transcript is the right way to preserve
continuity. Its loop performs preflight compression, prunes oversized old tool results, protects
recent turns, summarizes the middle of the conversation, and preserves tool-call/result pairing.
It also distinguishes stable prompt content from ephemeral per-call additions so that the stable
part can be cached and reused.

The important design idea is the `ContextEngine` seam: context assembly and compression are
policies that can be replaced or improved without rewriting the agent loop. Hermes also has a
typed failure path for provider context overflow; it does not continue sending doomed requests
indefinitely.

Sources: [agent loop](https://hermes-agent.nousresearch.com/docs/developer-guide/agent-loop),
[prompt assembly](https://hermes-agent.nousresearch.com/docs/developer-guide/prompt-assembly),
and [context compression and caching](https://hermes-agent.nousresearch.com/docs/developer-guide/context-compression-and-caching).

This is directly relevant to KasiTek. Our runtime already has a context builder with a message and
estimated-token budget, and the loop records tool results. That is a useful starting point, but a
fixed recent-message window is not the same as a context-management system. The platform needs to
decide what the model should see on each call, while retaining the full evidence separately for
audit, replay, and visualisation.

### 2. It separates active context, persistent memory, and session history

Hermes uses a bounded curated memory snapshot, user-profile information, searchable session
history, and the current working conversation as different concepts. Persistent memory is kept
small and is injected as a stable snapshot; past conversations are retrieved through search rather
than automatically replayed in full.

That distinction is more useful than treating “context” as one large bucket:

```text
Durable evidence       Full messages, tool results, receipts, traces
Working context        What the current model call is allowed to see
Persistent memory      Small, curated facts and preferences
Retrieved history      Relevant past exchanges selected for this turn
Execution state        Budgets, approvals, waits, retries, and checkpoints
```

Source: [Hermes persistent memory](https://hermes-agent.nousresearch.com/docs/user-guide/features/memory).

KasiTek should use this model when addressing token-budget failures. A conversation may retain its
complete history without forcing every future model call to carry every prior tool output.

### 3. Tool execution is a first-class runtime boundary

Hermes has a central tool registry and toolset selection model. Tool modules register their name,
schema, handler, environment requirements, and optional checks. The agent loop can execute
independent tool calls concurrently, preserve their original order in the conversation, and emit
callbacks for progress, reasoning, status, and completion.

This is not sufficient as KasiTek's authorization model, but it is a good runtime shape. KasiTek
already has stronger requirements around tenant scope, grants, approvals, idempotency, effect
receipts, and provider reconciliation. Hermes suggests that those concerns should be exposed
through one stable invocation boundary rather than being assembled differently by each channel or
provider.

Source: [Hermes tools runtime](https://hermes-agent.nousresearch.com/docs/developer-guide/tools).

### 4. It makes execution visible and interruptible

The Hermes loop exposes events for model calls, tool proposals, tool progress, tool completion,
status changes, streaming output, interruption, and compression. Its CLI and gateway consume the
same runtime callbacks. This is close to the event vocabulary KasiTek needs for the planned Agent
Canvas: the visual layer should consume execution events, not infer state from chat messages or
poll unrelated tables.

The design also treats cancellation and interruption as part of the loop contract. That matters
for approvals, handoffs, stuck provider calls, and operator actions.

### 5. It treats outbound delivery as a recoverable obligation

Hermes has a delivery ledger that records a delivery obligation before sending, tracks attempts,
and distinguishes pending, attempting, delivered, failed, and recovered states. Its recovery model
is deliberately honest about at-least-once delivery: after a crash, an “attempting” message may
have reached the provider, so the system records uncertainty rather than pretending it knows the
outcome.

Source: [Hermes delivery ledger](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/gateway/delivery_ledger.py).

This is highly relevant to KasiTek's website, Telegram, WhatsApp, and human-handoff failures. A
completed agent run and a delivered customer message must be separate facts. Hermes gives us a
concrete reference for the delivery side of that separation.

### 6. Its specialist-agent model starts with isolated profiles

Hermes Bot Mode treats a bot as a named profile containing role instructions, model settings,
memory, skills, credentials, and history. This provides role isolation without introducing a
second orchestration primitive. Hermes also supports delegated child runs with fresh context,
focused tasks, separate budgets, and a compact result returned to the parent.

Sources: [Hermes Bot Mode](https://hermes-agent.nousresearch.com/docs/user-guide/features/bot-mode)
and the [delegate tool implementation](https://raw.githubusercontent.com/NousResearch/hermes-agent/main/tools/delegate_tool.py).

For KasiTek, this maps well to future agent definitions, installations, roles, and Temporal child
workflows. It does not replace orchestration. A profile defines what an agent is; a durable parent
workflow defines how several agents coordinate, wait, approve, retry, and complete.

## Comparison with KasiTek

| Area | Hermes reference pattern | KasiTek direction |
| --- | --- | --- |
| Runtime | Shared agent loop behind CLI, gateway, API, and batch entry points | Shared agent runtime behind channel, UI, REST, MCP, and tenant-host adapters |
| Durability | Local session persistence and process-level recovery patterns | Temporal workflows plus PostgreSQL evidence, idempotency, receipts, and reconciliation |
| Context | Pluggable context engine, compaction, pruning, stable/volatile prompt layers | Add a first-class context policy that produces model-visible working context from durable evidence |
| Memory | Curated bounded memory plus searchable session history | Separate knowledge, long-term memory, recent conversation, retrieval results, and run evidence |
| Tools | Central registry, toolsets, concurrent execution, callbacks | Typed capabilities with grants, approvals, tenant scope, idempotency, provider adapters, and receipts |
| Channels | Gateway adapters share the same runtime and delivery path | Channel adapters should share one interaction lifecycle and durable delivery outbox |
| Observability | Runtime callbacks, progress events, trajectories, status commands | Structured execution events, materialized projections, live subscriptions, timeline and graph views |
| Specialist agents | Profiles and delegated child runs | Versioned agent definitions/installations plus bounded Temporal child runs |
| Safety | Local approvals, sandbox/backends, allow/deny rules | Multi-layer capability policy, human approval, tenant isolation, external-effect reconciliation |

Hermes is simpler because it is primarily a user-controlled agent process. KasiTek has to handle
multiple organizations, installations, actors, credentials, provider effects, approvals, and
durable recovery. We should borrow the seams and runtime contracts, not the storage or trust model.

## Hermes-aligned capability baseline for KasiTek

The following capabilities should become part of the target Agent Platform baseline. They are
architecture targets, not a checklist for immediate implementation:

| Capability to align | KasiTek implementation direction |
| --- | --- |
| Shared agent runtime | One runtime contract used by web chat, messaging channels, REST, MCP, scheduled runs, and future agent-to-agent calls |
| Context engine | A replaceable context policy that compacts, retrieves, budgets, and records provenance before each model call |
| Memory separation | Distinct stores and policies for conversation history, knowledge, long-term memory, retrieved context, and execution evidence |
| Tool registry and toolsets | Typed capability manifests selected by agent version and grants, with authorization and provider readiness checked before invocation |
| Concurrent tool execution | Parallelize independent read-only work while preserving deterministic ordering, budgets, approval boundaries, and durable receipts |
| Interruptible execution | Temporal signals, cancellation, timeouts, approvals, handoffs, and operator controls exposed through one run contract |
| Execution callbacks | Structured events emitted for model, context, tool, approval, wait, provider, delivery, retry, and terminal transitions |
| Durable delivery | PostgreSQL-backed outbox or delivery ledger coordinated with Temporal and channel adapters |
| Agent profiles | Versioned agent definitions and installations containing instructions, tools, memory policy, knowledge, model policy, and channel policy |
| Specialist delegation | Bounded Temporal child workflows with isolated context, explicit parent-child causation, and typed results |
| Runtime diagnostics | A common `doctor`/diagnostic surface for configuration, grants, provider readiness, delivery health, and stuck runs |

The baseline gives us a concrete standard for reviewing future features: a new channel, tool, agent
type, or orchestration feature should fit these boundaries rather than introduce a separate
execution path.

## Patterns KasiTek should study for the architecture rethink

### A. Introduce a real context engine boundary

The current context builder should evolve into a policy-driven component with explicit inputs and
outputs:

```text
Durable conversation + summaries + memory + retrieval + run state
                              |
                              v
                         Context policy
                              |
                              v
       Model-visible messages, tools, budget, omissions, provenance
```

The policy should support:

- preflight compaction before a model call;
- cheap pruning of old, repetitive, or oversized tool results;
- structured summaries of older turns;
- protected recent turns and intact assistant-tool pairs;
- separate limits for prompt tokens, output tokens, tool-result bytes, and total run cost;
- explicit provenance for omitted, summarized, and retrieved material;
- fail-closed recovery when the provider still rejects the request.

Full messages and tool outputs remain durable evidence. The model receives a bounded projection of
that evidence. This should be a central platform contract, not a special fix for KasiAI.

### B. Store model-visible output separately from durable output

Every tool result should have at least two representations:

1. a redacted, durable result used for audit, receipts, replay, and operator inspection;
2. a bounded model-facing result used in the next prompt.

The second representation may contain summaries, selected fields, pagination hints, counts, and a
reference to the full result. A tool must not force the model to ingest a 100-record list or a
large provider payload simply because the operator needs the complete evidence later.

### C. Use one execution event stream for runtime and visuals

The Agent Canvas should subscribe to a canonical event model with events such as:

```text
run admitted → context built → model started → tool proposed
→ approval requested → tool executing → tool completed
→ wait scheduled → provider effect pending → delivered
→ model resumed → run completed | failed | canceled
```

Each event needs tenant, installation, agent version, run, parent run, correlation, sequence,
causation, and timestamp fields. The graph UI can then render the same source used by operators,
developers, audit logs, and analytics. Hermes's callbacks are a useful reference, while KasiTek's
event model must additionally support durable ordering, replay, redaction, and multi-tenant access
control.

### D. Add a delivery ledger or outbox with explicit uncertainty

For every outbound message, handoff acknowledgement, approval prompt, and provider effect, record
the delivery obligation independently of the agent run. The state machine should distinguish:

```text
queued → sending → delivered
             ├→ retryable failure → retrying
             ├→ definitive failure
             └→ unknown outcome → reconciliation
```

This should drive customer-facing status, operator views, retries, and alerts. It should eliminate
the current class of failures where the platform creates a handoff request or completes a run but
does not reliably tell the person who needs to act.

### E. Make delegated agents children of a durable parent run

When multi-agent execution becomes necessary, use a narrow contract:

- the parent assigns a typed task and bounded context;
- the child has its own run ID, budget, tools, and event stream;
- the child returns a typed result or a typed failure;
- the parent can wait, cancel, retry, or compensate the child;
- the parent does not copy the child's entire transcript into its own context.

Hermes's fresh-context delegate pattern is a useful reference. Temporal child workflows can supply
the durability, timeout, retry, and cancellation semantics that a local process cannot provide.

### F. Make agent profiles explicit and versioned

An agent profile should own instructions, model policy, tool grants, memory policy, knowledge
sources, channel policy, and visual metadata. An installation should bind that profile to a tenant,
actor, credentials, and allowed resources. A run should record the exact profile and versions used.

This gives us the isolation Hermes gets from profiles while preserving KasiTek's tenant and
authorization boundaries.

## What we should not copy

- **Local SQLite as the system of record.** Hermes's storage model is appropriate for a local or
  single-user process. KasiTek needs PostgreSQL, Temporal, tenant scoping, migrations, and durable
  projections.
- **Uncontrolled self-modification.** Hermes can create and improve skills and maintain memory.
  KasiTek customer agents need versioning, review, audit, rollback, and explicit tenant policy
  before learned behavior changes production actions.
- **Open-ended autonomy as the default.** Hermes supports large iteration budgets and delegation.
  KasiTek should keep bounded iterations, tool calls, wall time, spend, concurrency, and provider
  effects, with approvals where required.
- **A plugin registry as the integration solution.** A registry helps discovery, but it does not
  solve OAuth, scopes, tenant grants, idempotency, retries, provider-side uncertainty, or
  reconciliation. KasiTek still needs the capability and adapter contracts in the main architecture
  plan.
- **Process-local delivery assumptions.** Channel delivery must survive worker loss, duplicate
  attempts, provider timeouts, and uncertain responses. It cannot depend on the agent process that
  happened to generate the reply.

## Proposed research-to-planning sequence

This is the recommended order for turning the Hermes study into architecture decisions:

1. Define the context-engine contract and measure current prompt composition, tool-result sizes,
   token failures, compression opportunities, and answer quality.
2. Define the canonical execution-event and delivery-obligation schemas before building the visual
   UI. Verify that one event stream can serve runtime, operator, developer, and analytics views.
3. Prototype model-visible tool-result projections against the largest current tools, especially
   list, inbox, booking, content, knowledge, and provider-status tools.
4. Map Hermes-style profiles and child runs to KasiTek agent versions, installations, Temporal
   workflows, approvals, and tenant boundaries.
5. Run failure-injection tests for model overflow, worker loss, provider timeout, duplicate
   delivery, unknown provider outcome, handoff acknowledgement, and child-agent cancellation.
6. Decide which improvements can be added incrementally and which require the broader architecture
   rethink already recorded in the [Agent Platform Architecture Improvement Plan](./AGENT_PLATFORM_ARCHITECTURE_IMPROVEMENT_PLAN.md).

The immediate recommendation is to implement none of these from this research note alone. First
turn the contracts and measurements into scoped architecture slices, then implement the highest
leverage reliability boundary: context management plus durable interaction delivery.

## Open decisions

| Topic | Question |
| --- | --- |
| Context | Should compaction happen inside the Temporal activity, in a reusable runtime module, or through a separate durable step? |
| Summaries | Which model or deterministic strategy is allowed to summarize context, and how is summary quality evaluated? |
| Evidence | How long do full tool outputs remain available, and which fields are safe for model-visible projections? |
| Events | What is the canonical event store and live-subscription mechanism for the Agent Canvas? |
| Delivery | Which outbound operations use the same delivery ledger, and how are unknown provider outcomes reconciled? |
| Profiles | Which profile fields are tenant-configurable, and which require platform-managed versions or review? |
| Delegation | Which tasks justify child agents, and what is the initial depth and concurrency limit? |
| Runtime | What measurable requirements would justify considering a change to the durable execution layer? |

## Release and implementation status

This document is planning research only. No production code, schema, provider, model, deployment,
or runtime dependency was changed. Release record, migration, rollout, rollback, analytics, and
operational changes are **not applicable** until a scoped implementation plan is approved.
