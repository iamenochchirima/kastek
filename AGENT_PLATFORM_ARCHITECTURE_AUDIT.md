# Agent platform architecture audit

Status: engineering assessment
Date: 2026-09-01
Scope: hosted agents, external-connected agents, agent runtime, workflow execution, tools, memory, knowledge, data isolation, customization, operations, and scaling
Reference implementation: `/home/enoch/aworkspace/agents/waku-agent`

## Purpose

This document assesses whether the KasiTek Agent Platform has the system design needed for users
to create distinct, customizable agents safely at scale.

Waku is used as a reference for the internal anatomy of an agent. The comparison is not about
copying Waku's local process, SQLite database, or deployment model. It asks whether KasiTek has the
same useful agent capabilities, then whether the platform adds the control plane, isolation,
durability, security, and operations required for a multi-tenant product.

This is an audit and implementation backlog. It does not authorize or record a production change.
Each implementation tranche must create its own plan and release record under
[`docs/internal/operations/release-process.md`](docs/internal/operations/release-process.md).

## Executive assessment

The platform has the right base. It is not a thin chat wrapper. The strongest modules are the
bounded agent loop, typed capability registry, approval and external-effect controls, Temporal run
ownership, channel adapters, versioned agent records, and durable operational evidence.

The platform is not ready to claim that every advertised agent capability works correctly. Four
problems need immediate attention:

1. Publishing a user-created agent version does not deploy it to existing installations.
2. The workflow graph has reproducible correctness failures and advertises an `agent_loop` node
   that production does not wire.
3. One retryable Temporal activity executes an entire loop or graph even though its timeout can be
   shorter than the work inside it.
4. Memory has a strong schema but no production conversation-to-memory write and consolidation
   path.

Agent data is logically isolated by organization, definition, installation, conversation, and
user scope. That is the intended meaning of agent isolation in this document. It does not mean one
Docker container per agent. The platform now has a database-backed defense-in-depth boundary for
all 63 runtime tables: each reports `FORCE ROW LEVEL SECURITY`, while the administrative
`schema_migrations` table is inaccessible to runtime and application roles. Full background-process
matrix coverage, legacy constraint validation, and untrusted-code sandboxing remain open.

The recommended direction is to keep the existing control plane and bounded loop, repair the
deployment and workflow contracts, complete memory as a real module, and add stronger database and
execution isolation where the risk requires it.

## Terms and required invariants

### Agent definition

The stable identity and ownership record for an agent. It names the agent and determines whether
the organization or platform owns it.

### Agent version

An immutable behavior specification containing instructions, model configuration, runtime limits,
workflow configuration, and policy. A published version is eligible for deployment. Publication
alone must not be confused with deployment.

### Agent installation

The deployed instance of an agent version within an organization, user, or business scope. The
installation owns settings, capabilities, resources, connectors, channels, and runtime status.

### Agent run

One durable execution against one installation and one exact version. Historical runs must never
change version after execution.

### Agent isolation

Agent isolation means all runtime and data access stays inside the run's effective scope:

```text
organization
  -> agent definition
    -> installation
      -> conversation or user when applicable
```

The required invariant is stronger than "most queries include an organization ID." Every read,
write, search, deletion, tool grant, credential lookup, and workflow transition must prove the
same organization, agent, installation, and narrower namespace where applicable.

### Platform safety policy

Mandatory policy owned by KasiTek. Users cannot remove or weaken it by editing instructions,
templates, workflows, tools, or model settings.

### Agent specification

A proposed typed interface for the complete user-editable agent configuration. It should cover
identity, behavior, models, capabilities, knowledge, memory, channels, limits, workflows, skills,
and release policy. Templates should compile into ordinary agent specifications instead of
creating a separate runtime type.

## Current platform shape

The hosted execution path is structurally sound:

```text
agent definition and immutable version
  -> installation, settings, and grants
  -> channel or platform message
  -> durable Temporal workflow
  -> scoped context assembly
  -> bounded model and tool loop, or configured graph
  -> capability and approval enforcement
  -> durable response, events, usage, and channel delivery
```

The platform runs shared, stateless process types:

- Agent API for authenticated control-plane and runtime requests.
- Temporal worker for model, tool, workflow, transcription, and recovery work.
- MCP gateway for stateless protocol forwarding.
- Analytics publisher for outbox delivery.

User-created agents are records and durable runs inside these shared process types. They do not
receive separate operating-system processes or databases. That is the correct default for hosted
model-and-tool agents. Untrusted user code and arbitrary extensions would require a separate
sandboxed execution module.

## Capability assessment

| Agent-system capability | Status | Assessment |
| --- | --- | --- |
| Agent identity and instructions | Implemented | Versioned definitions and instructions are a sound base. |
| Working conversation context | Implemented | Recent messages, summaries, channel context, and token budgets exist. |
| Bounded agent loop | Implemented | Strong limits, model fallback, tool control, and durable evidence. |
| Model abstraction | Implemented | Multiple providers, BYOK credentials, retry, pricing, and circuit breaking. |
| Tool and capability registry | Implemented | Typed input/output, grants, risk, approvals, audit, redaction, and idempotency. |
| Semantic memory | Structural only | Storage and retrieval exist; automatic durable fact creation does not. |
| Episodic memory | Structural only | The type exists; conversation consolidation does not. |
| Procedural skills | Partial | Instructions and workflows exist; reusable, selectively loaded skills do not. |
| Knowledge ingestion | Baseline implemented | Text, files, URLs, websites, provenance, and scoped retrieval exist. |
| Retrieval quality | Partial | Full-text search and a narrow retrieval gate limit relevance. |
| Graph workflows | Unsafe | Several advertised contracts fail under direct reproduction. |
| Durable execution | Implemented with risks | Temporal owns runs and waits, but activity granularity and cancellation need work. |
| Human approval and handoff | Implemented | Exact argument binding, durable approval, consent, and resumption exist. |
| Channels | Implemented baseline | Platform, website, WhatsApp, Telegram, Discord, REST, and MCP paths exist. |
| Agent observability | Implemented baseline | Runs, steps, model calls, tool calls, events, traces, and analytics outbox exist. |
| Evaluations | Partial | Deterministic assertions exist; broad quality and adversarial gates do not. |
| User customization | Substantial | Identity, model, limits, knowledge, graph, integrations, and channels are exposed. |
| Multi-agent data isolation | Defense-in-depth implemented; operational hardening open | Scoped queries, ownership triggers, a restricted runtime role, and `FORCE ROW LEVEL SECURITY` cover 63 of 64 public base tables; migration-ledger privilege separation and broader process-matrix/legacy validation remain. |
| Untrusted extension isolation | Missing | No sandboxed custom-code or arbitrary plugin execution plane exists. |

## What should remain

The following modules provide the right base and should be extended rather than replaced:

- The definition, version, installation, and run domain model.
- The bounded loop in [`agents/src/runtime/loop.ts`](agents/src/runtime/loop.ts).
- The capability interface and registry in
  [`agents/src/tools/types.ts`](agents/src/tools/types.ts) and
  [`agents/src/tools/registry.ts`](agents/src/tools/registry.ts).
- Capability grants, resource scopes, approval records, and effect receipts.
- Temporal workflow ownership of a run and durable approval, handoff, and event signals.
- Provider adapters and model credential resolution.
- Conversation, channel, media, delivery, and handoff records.
- Analytics outbox and structured run evidence.
- Agent-scoped memory and knowledge ownership fields and database consistency triggers.
- External-connected installations for agents that run outside KasiTek but consume scoped REST or
  MCP capabilities.

The platform does not need a wholesale rewrite. The immediate work is concentrated in several
interfaces whose documented guarantees are stronger than their implementations.

## Priority 0: production correctness and safety

Priority 0 work fixes behavior that can mislead users, lose workflow state, repeat execution, or
violate configured budgets.

### Checklist conventions

- `[ ]` means no implementation evidence has been recorded in this document.
- Mark an item complete only after its code, tests, and required release evidence are committed.
- Add the pull request, migration, runbook, or test reference beside a completed item.
- Do not mark a parent section complete while any required verification item remains open.
- Start each priority section with a plan in `docs/plans/active/` and move that plan to
  `docs/plans/completed/` only after release verification.

### P0.1 Deploy published versions to installations

#### Finding

[`AgentRepository.publishVersion`](agents/src/db/repositories/agent-repository.ts) retires the old
published version and publishes a draft. It does not update existing user-created installations.
The only explicit rollout method is `rolloutSystemVersion`, which applies to system agents.

The workflow editor reports that the new version "is now live" after publication in
[`agent-workflow-page-client.tsx`](client/apps/client/src/components/dashboard/agents/agent-workflow-page-client.tsx),
even though an existing installation remains pinned to its previous `agent_version_id`.

#### Impact

- A user edits and publishes an agent, but live conversations may continue using old instructions,
  tools, limits, knowledge behavior, or workflow configuration.
- Rollback changes publication state without necessarily changing the deployed installation.
- The UI and audit trail can report a state that does not match runtime behavior.

Implementation is tracked in the [agent version deployment plan](docs/plans/active/AGENT_VERSION_DEPLOYMENT_PLAN.md).

#### Required design

Separate publication from deployment and make installation behavior explicit:

- `pinned`: the installation stays on one selected version.
- `follow_published`: publishing deploys the new version to the installation.
- `staged`: a release owner selects installations or a percentage for canary deployment.

Introduce a version deployment module with a small interface that owns:

- deployment eligibility;
- installation updates;
- optimistic concurrency;
- canary selection;
- audit and analytics records;
- rollback to the previous deployed version;
- protection of in-flight and historical runs.

#### Minimum fix

1. Add an organization-scoped operation to move an installation to a published version belonging
   to the same agent definition.
2. Make the user creation flow select `follow_published` or explicitly create a pinned
   installation.
3. Change UI copy so publication and deployment are reported separately.
4. Display both published version and deployed version.
5. Ensure new runs snapshot the installation's current version transactionally.

#### Required verification

- Publishing updates `follow_published` installations and leaves pinned installations unchanged.
- A run started before deployment keeps its original version.
- A run started after deployment uses the new version.
- Rollback moves eligible installations back and records the previous and next version IDs.
- Cross-organization and cross-definition deployment attempts fail at the repository and database
  levels.
- Deployment failure cannot leave the UI claiming the version is live.

#### Implementation checklist

- [x] Write the version-deployment domain rules and choose the default for existing installations.
- [x] Add deployment mode and deployed-version fields with a backward-compatible database
      migration.
- [x] Implement one organization-scoped version deployment module with deploy, canary, and rollback
      operations ([agent-deployment-repository.ts](agents/src/db/repositories/agent-deployment-repository.ts)).
- [x] Make run creation snapshot the deployed version in the same transaction that admits the run
      ([run-repository.ts](agents/src/db/repositories/run-repository.ts)).
- [x] Update publication, rollback, and installation routes to use the deployment module
      ([agent-repository.ts](agents/src/db/repositories/agent-repository.ts)).
- [x] Separate published and deployed state in the workflow editor and agent detail UI.
- [x] Add repository and database tests for organization, definition, installation, and version
      ownership ([agent-lifecycle.integration.test.ts](agents/test/agent-lifecycle.integration.test.ts),
      [hosted-agent-boundaries.integration.test.ts](agents/test/hosted-agent-boundaries.integration.test.ts)).
- [x] Add integration tests for pinned, follow-published, staged, failed, and rolled-back
      deployments ([agent-lifecycle.integration.test.ts](agents/test/agent-lifecycle.integration.test.ts)).
- [x] Emit version publication, deployment, failure, and rollback events through the analytics
      registry and structured logs ([agent-deployment-repository.ts](agents/src/db/repositories/agent-deployment-repository.ts),
      [analytics-producer.test.ts](agents/test/analytics-producer.test.ts)).
- [x] Update internal agent lifecycle documentation, user documentation, migration notes, and the
      deployment runbook ([agent-connection-guide.md](docs/public/docs/api/agent-connection-guide.md),
      [AGENT_VERSION_DEPLOYMENT_PLAN.md](docs/plans/active/AGENT_VERSION_DEPLOYMENT_PLAN.md)).
- [ ] Release behind an explicit rollout control and record the post-release published-versus-
      deployed mismatch rate.

### P0.2 Replace or constrain the workflow graph executor

#### Verified bugs

The graph implementation in
[`agents/src/workflows/executor.ts`](agents/src/workflows/executor.ts) has the following reproduced
failures:

1. `stateSchema` is parsed but never enforced during execution. A field declared as a number can
   receive a string and the graph completes.
2. Edge-level `maxIterations` is parsed and accepted by validation but ignored by the executor. A
   self-loop configured with a limit of two ran until the global 2,000-step fallback.
3. Fan-out branches receive complete state snapshots and merge their complete final states with
   `Object.assign`. A later branch can restore an older value and discard a valid sibling write.
4. A downstream join node runs once inside each branch instead of once after all branches finish.
5. The schema advertises `agent_loop`, but production graph execution in
   [`agents/src/temporal/activities.ts`](agents/src/temporal/activities.ts) does not provide the
   executor's `agentLoop` dependency. The node fails as unconfigured.
6. Graph model nodes do not apply the bounded loop's aggregate `maxModelCalls`, total-token,
   estimated-cost, or wall-clock checks.
7. Graph completion reports only the last model response's usage rather than aggregate graph
   usage.
8. The complete graph executes inside one activity instead of checkpointing completed node work
   durably.

The current workflow tests pass because they do not exercise these contracts. The completed
platform plan also overstates the implementation by marking safe fan-out, bounded edges, and
agent-loop nodes complete.

#### Immediate containment

Until the executor satisfies its interface:

- prevent publication of fan-out, fan-in, cycle, and `agent_loop` nodes;
- allow only the verified linear subset of deterministic, route, model, tool, approval, wait, and
  handoff nodes;
- mark the visual workflow feature as preview if users can still access it;
- reject graphs whose configured limits cannot be enforced by the current runtime.

#### Target graph module

The replacement or repaired module must own these guarantees behind one execution interface:

- compile and validate state schemas before publication;
- validate state before and after every node;
- enforce node, edge, graph-step, token, cost, tool, model-call, and wall-clock limits;
- track branch deltas instead of merging complete snapshots;
- reject overlapping branch writes before execution;
- execute one fan-in after all required branches finish;
- checkpoint node completion and workflow state durably;
- support a bounded loop node through the same loop module used outside graphs;
- aggregate model and tool usage across the entire graph;
- preserve exact pause and resume state for approval, handoff, and external events;
- make every side-effecting node idempotent or explicitly reconcilable.

#### Required verification

Add contract tests for:

- invalid initial, intermediate, and final state;
- node and edge iteration limits;
- disjoint and overlapping branch writes;
- one fan-in after multiple branches;
- nested fan-out;
- branch failure and cancellation;
- approval and event pause after partial progress;
- worker crash after every node type;
- loop node completion and limits;
- aggregate token, cost, and model-call budgets;
- deterministic replay and trace ordering.

#### Implementation checklist

- [x] Add regression tests for the reproduced graph bugs and their repaired contracts
      ([workflow-graph.test.ts](agents/test/workflow-graph.test.ts)).
- [x] Add publication-time containment that rejects unsupported fan-out forms, cycles, and
      `agent_loop` configurations, while requiring a valid fan-out/fan-in contract
      ([graph.ts](agents/src/workflows/graph.ts)).
- [x] Define the graph module interface, durable state format, error model, and compatibility rules
      ([executor.ts](agents/src/workflows/executor.ts), migration 080).
- [x] Compile `stateSchema` once and validate initial, intermediate, resumed, and final state
      ([graph.ts](agents/src/workflows/graph.ts), [executor.ts](agents/src/workflows/executor.ts)).
- [x] Enforce node, edge, graph-step, model-call, token, cost, tool, and wall-clock limits
      ([executor.ts](agents/src/workflows/executor.ts)).
- [x] Replace whole-snapshot fan-out merges with branch deltas and overlapping-write validation
      ([executor.ts](agents/src/workflows/executor.ts)).
- [x] Implement one-time fan-in after all required branches complete
      ([executor.ts](agents/src/workflows/executor.ts), [workflow-graph.test.ts](agents/test/workflow-graph.test.ts)).
- [ ] Wire `agent_loop` through the same bounded loop module used by normal hosted runs.
- [x] Persist node checkpoints, pause state, branch state, and idempotency keys
      ([workflow-checkpoint-repository.ts](agents/src/db/repositories/workflow-checkpoint-repository.ts),
      migration 080).
- [x] Aggregate model and tool usage across every node and branch
      ([executor.ts](agents/src/workflows/executor.ts)).
- [ ] Add crash, replay, cancellation, approval, handoff, and external-event contract tests.
- [ ] Update workflow schema documentation, preview labels, migration guidance, runbooks, metrics,
      and rollback controls.

### P0.3 Split Temporal work into retry-safe activities

#### Finding

[`agents/src/temporal/workflows.ts`](agents/src/temporal/workflows.ts) gives activities a one-minute
`startToCloseTimeout` and up to five attempts. `executeLoop` can run a complete multi-model,
multi-tool loop or complete graph inside that activity.

The loop itself can consume one minute by default. Registered tools may allow up to 120 seconds.
Model calls perform their own retries. Activities do not heartbeat, and Temporal cancellation does
not abort an in-flight model or tool request.

#### Impact

- Temporal can retry the entire loop after an activity timeout.
- Model calls, reads, drafts, and completed graph nodes can repeat.
- External-effect receipts reduce some duplication risk but do not make the whole activity
  replay-safe.
- Cancellation prevents later workflow steps but does not promptly stop current provider spend or
  tool execution.
- A configured tool timeout may exceed the enclosing activity timeout.

#### Required design

Move durability to the meaningful execution steps:

```text
build context
  -> reserve and execute model call
  -> persist proposal
  -> execute one tool with an idempotency key
  -> persist observation
  -> checkpoint loop or graph state
  -> repeat or complete
```

Each remote operation should have its own timeout, retry classification, heartbeat behavior, and
cancellation signal. Temporal workflow state should coordinate the sequence. PostgreSQL should
hold product evidence and idempotency records, not act as a replacement workflow engine.

#### Required verification

- Kill a worker before and after each model, tool, approval, and completion checkpoint.
- Prove no external effect executes twice.
- Prove model usage and credit reservation reconcile after retries.
- Prove cancellation aborts supported provider and tool requests.
- Prove unsupported cancellation records an unknown outcome rather than claiming reversal.
- Prove activity timeouts exceed the maximum work they enclose.

#### Implementation checklist

- [x] Inventory every Temporal activity, its enclosed remote calls, retry policy, and maximum
      duration ([agent-temporal-recovery.md](docs/internal/runbooks/agent-temporal-recovery.md));
      `executeLoop` remains the large decomposition boundary.
- [ ] Define retry-safe activity interfaces for context, model calls, tool calls, checkpoints, and
      completion.
- [ ] Move loop and graph coordination into Temporal workflow code without placing non-deterministic
      work there.
- [x] Give each model and tool operation a stable idempotency key and durable outcome state
      ([model-call-repository.ts](agents/src/db/repositories/model-call-repository.ts),
      [tool-invocation-repository.ts](agents/src/db/repositories/tool-invocation-repository.ts));
      provider-side reconciliation is still required for unknown outcomes.
- [x] Align activity, provider, tool, heartbeat, schedule-to-close, and workflow timeouts
      ([workflows.ts](agents/src/temporal/workflows.ts), [activities.ts](agents/src/temporal/activities.ts)).
- [x] Propagate cancellation to provider and tool adapters that support it
      ([loop.ts](agents/src/runtime/loop.ts), [types.ts](agents/src/tools/types.ts)).
- [x] Record `unknown_outcome` and schedule reconciliation when cancellation cannot prove the
      remote outcome.
- [ ] Add worker-kill tests around every model, tool, approval, effect, and completion checkpoint.
- [x] Add retry, timeout, cancellation, and reconciliation metrics with bounded structured logs
      ([spans.ts](agents/src/telemetry/spans.ts), [worker.ts](agents/src/temporal/worker.ts)).
- [x] Update the Temporal operations runbook ([agent-temporal-recovery.md](docs/internal/runbooks/agent-temporal-recovery.md)).
- [ ] Release the decomposed orchestration path behind a controlled flag.

### P0.4 Apply graph budgets and usage accounting

This may ship with P0.2, but it remains a separate release concern because it controls customer
spend.

Every execution mode must use one run-budget module. The module should reserve and capture model
credits, enforce aggregate limits, expose remaining budget to each node, and persist one canonical
usage total. Hosted loops, graph model nodes, loop nodes, external-connected operations, and future
skills must cross the same interface.

Completion criteria:

- The configured maximum applies regardless of execution mode.
- Parallel model nodes reserve budget atomically.
- Reported usage equals the sum of durable model-call records.
- A retry cannot capture the same reservation twice.
- Cost-limit failures stop future model and tool work.

#### Implementation checklist

- [x] Define one run-budget interface and canonical usage record for every execution mode
      ([run-budget-repository.ts](agents/src/db/repositories/run-budget-repository.ts), migration 082).
- [x] Implement atomic reserve, capture, release, and reconcile operations. Stale reservations are
      marked `unknown` and can be resolved only through an explicit provider-outcome decision
      ([run-budget-repository.ts](agents/src/db/repositories/run-budget-repository.ts), migration 083).
- [x] Pass the remaining budget into graph model, tool, and nested loop nodes
      ([activities.ts](agents/src/temporal/activities.ts), [loop.ts](agents/src/runtime/loop.ts)).
- [ ] Reserve parallel branch capacity before launching work.
- [x] Replace last-response usage reporting with aggregation from durable model-call records
      ([model-call-repository.ts](agents/src/db/repositories/model-call-repository.ts), [activities.ts](agents/src/temporal/activities.ts)).
- [x] Add over-budget and reconciliation tests ([run.integration.test.ts](agents/test/run.integration.test.ts));
      parallel reservation, worker-retry, and provider-side reconciliation tests remain open.
- [x] Add budget exhaustion metrics, customer-safe errors, operator diagnostics, and a reconciliation
      runbook ([spans.ts](agents/src/telemetry/spans.ts), [app.ts](agents/src/http/app.ts),
      [agent-temporal-recovery.md](docs/internal/runbooks/agent-temporal-recovery.md)).
- [ ] Compare billed, reserved, captured, and provider-reported usage during staged rollout.

## Priority 1: memory, isolation, and reliable agent behavior

### P1.1 Complete the memory lifecycle

#### Finding

[`MemoryRepository`](agents/src/db/repositories/memory-repository.ts) supports scoped creation,
search, quarantine, expiry, revalidation, and deletion. A durable consolidation worker now creates
review-first semantic and episodic candidates from bounded run-bound conversation evidence for
`reviewed` and `automatic` installations. Model-backed extraction and automatic activation remain
open. Explicit memory and knowledge deletion now physically removes the canonical rows, embedded
vectors, PostgreSQL search vectors, source chunks, and affected conversation summaries in the same
transaction; there is no separate vector or cache store active in this deployment.

The current retrieval gate in [`agents/src/runtime/context.ts`](agents/src/runtime/context.ts) is a
regular expression for phrases such as `remember`, `previous`, and `last time`. It misses ordinary
queries that need personal or project memory without using those words.

Memory and knowledge retrieval use PostgreSQL full-text search. The accepted memory ADR describes
hybrid PostgreSQL and pgvector retrieval, but vector ranking is not active.

#### Target memory module

The memory module should own a complete lifecycle:

```text
conversation evidence
  -> policy decision to extract or skip
  -> candidate facts and episodes
  -> provenance, confidence, sensitivity, and expiry classification
  -> poisoning and contradiction checks
  -> automatic write, review queue, or rejection
  -> scoped retrieval and ranking
  -> correction, revalidation, expiry, and deletion
```

The module needs one interface for the runtime and internal adapters for PostgreSQL full-text,
pgvector, and future dedicated stores if measured scale requires them.

#### Memory policy

Each agent installation should declare:

- whether memory is disabled, explicit-only, review-before-save, or automatically inferred;
- allowed namespaces and memory types;
- retention and revalidation periods;
- whether user-private memory may be used;
- whether organization-shared memory may be read or written;
- sensitivity limits;
- extraction and retrieval budgets.

Organization-shared memory must be an explicit policy choice. It is the one namespace intended to
cross installation boundaries inside an organization and must not be mistaken for accidental
cross-agent access.

#### Required verification

- Agent A cannot search, list, update, or delete Agent B's private memory.
- Organization A cannot access Organization B's memory through any repository or HTTP route.
- Installation-private, user-private, and conversation memory remain isolated.
- Explicit corrections supersede stale inferred facts.
- Deleted memory disappears from keyword, vector, summary, and derived stores.
- Prompt-injection content is quarantined and never becomes procedural policy.
- Retrieval evaluation covers paraphrases that contain no trigger keywords.
- Memory writes record the source run, message, model, policy, and extraction version.

#### Implementation checklist

- [x] Add a typed installation memory policy with disabled, explicit, reviewed, and automatic
      modes ([policy.ts](agents/src/memory/policy.ts)).
- [x] Define the memory module interface for extraction, review, storage, retrieval, correction,
      expiry, and deletion ([lifecycle.ts](agents/src/memory/lifecycle.ts)); extraction, review,
      and correction adapters remain open.
- [x] Implement bounded conversation evidence selection and conservative candidate fact or episode
      extraction ([consolidation.ts](agents/src/memory/consolidation.ts)); model-backed extraction
      remains open.
- [x] Store provenance, confidence, sensitivity, expiry, source run, source messages, and
      extraction version for inferred candidates ([consolidation.ts](agents/src/memory/consolidation.ts),
      [lifecycle.ts](agents/src/memory/lifecycle.ts)). The first deterministic adapter records
      `model: null`; model-backed extraction remains open.
- [x] Add review-first inferred writes, quarantine, rejection, correction, and revalidation paths
      through the lifecycle and existing review routes ([consolidation-worker.ts](agents/src/memory/consolidation-worker.ts),
      [memory-repository.ts](agents/src/db/repositories/memory-repository.ts)). Automatic activation
      remains intentionally disabled.
- [x] Run consolidation after an explicit inbound-message threshold through an idempotent,
      leased queue ([089_memory_consolidation_jobs.sql](agents/migrations/089_memory_consolidation_jobs.sql),
      [memory-consolidation-job-repository.ts](agents/src/db/repositories/memory-consolidation-job-repository.ts)).
- [x] Apply organization, agent, installation, user, conversation, and namespace scope to every
      runtime memory search and explicit write ([memory-repository.ts](agents/src/db/repositories/memory-repository.ts),
      [lifecycle.ts](agents/src/memory/lifecycle.ts)).
- [x] Make deletion remove keyword, vector, summary, cache, and other derived representations.
      Memory and knowledge deletion now purges row-owned embedding and full-text index data,
      knowledge chunks, and affected conversation summaries through scoped repository paths;
      active legal holds block the purge. No independent vector or cache store is deployed yet,
      so those adapters are not applicable until such stores are introduced.
- [x] Add lifecycle, policy-mode, extraction, threshold, replay, review, and poisoning tests
      ([memory-policy.test.ts](agents/test/memory-policy.test.ts),
      [memory-consolidation.test.ts](agents/test/memory-consolidation.test.ts),
      [memory-consolidation-worker.test.ts](agents/test/memory-consolidation-worker.test.ts),
      [memory-consolidation.integration.test.ts](agents/test/memory-consolidation.integration.test.ts));
      deletion and legal-hold coverage is included in the memory, retention, platform-chat, and
      operator-command integration tests; multi-turn poisoning remains open.
- [x] Add consolidation job, candidate, threshold-skip, and failure metrics
      ([spans.ts](agents/src/telemetry/spans.ts), [consolidation-worker.ts](agents/src/memory/consolidation-worker.ts));
      acceptance and scope-rejection metrics remain open; derived-deletion outcomes are recorded by
      `kasitek.memory.deletion.count`.
- [x] Update memory architecture, safety runbook, migration, and runtime policy documentation
      ([agent-memory-lifecycle.md](docs/internal/architecture/agent-memory-lifecycle.md),
      [agent-memory-safety.md](docs/internal/runbooks/agent-memory-safety.md)); privacy, user
      controls, model evaluation, and RLS documentation remain open.

### P1.2 Add PostgreSQL row-level security

#### Finding

Repositories usually include organization and agent predicates. Migration 057 adds ownership
triggers for memory, knowledge, installations, and runs. This is a strong application-level base.

PostgreSQL row-level security is now enabled across four tranches. Migrations 091 through 094
cover 63 of the 64 public base tables, including memory, knowledge, conversations, runs,
credentials, channels, effects, approvals, lifecycle sidecars, analytics, and operator control
data. All 63 runtime tables use `FORCE ROW LEVEL SECURITY`; `schema_migrations` is deliberately
not runtime data and has no privileges for the runtime or application roles. Some ownership
constraints remain `NOT VALID`, so legacy rows have not been proven to satisfy every invariant.
The production Agents runtime previously connected as the `postgres` superuser; it now uses a
restricted login without `SUPERUSER` or `BYPASSRLS`, and API, worker, publisher, webhook, and
Temporal paths set transaction-local tenant context.

The table and parent-path inventory is recorded in
[`agents-tenant-isolation-inventory.md`](docs/internal/architecture/agents-tenant-isolation-inventory.md).
The production ownership audit found no ordinary agent/organization mismatches; the two apparent
installation and knowledge-source mismatches are protected system-agent rows required by the
system-installation design.

#### Required design

1. Inventory every tenant-owned table and classify its organization, agent, installation,
   conversation, and user ownership.
2. Migrate or quarantine legacy rows that do not satisfy current ownership invariants.
3. Validate all ownership constraints.
4. Enable RLS in staged migrations. Migrations 091 through 094 now cover all runtime tables;
   retain the administrative privilege boundary for `schema_migrations`.
5. Set trusted organization and actor context on every transaction.
6. Use a distinct migration and operator role that can bypass RLS deliberately.
7. Prevent application roles from silently bypassing RLS.

#### Required verification

- Run the repository suite using the same restricted database role as production.
- Add negative cross-organization and cross-agent tests for every protected table.
- Test background workers, operators, migrations, and retention jobs separately.
- Audit any query that intentionally spans organizations.

#### Implementation checklist

- [x] Produce a tenant-owned table inventory with ownership paths and intentional cross-tenant
      operations ([agents-tenant-isolation-inventory.md](docs/internal/architecture/agents-tenant-isolation-inventory.md)).
- [x] Audit existing rows and write a report for orphaned or inconsistent ownership; production
      exceptions are protected system-agent rows, while local legacy test data remains outside
      production validation ([agents-tenant-isolation-inventory.md](docs/internal/architecture/agents-tenant-isolation-inventory.md)).
- [x] Provision a restricted runtime group/login and move API and worker connections off the
      PostgreSQL superuser ([090_agents_runtime_role.sql](agents/migrations/090_agents_runtime_role.sql),
      [AGENT_RLS_ROLLOUT_PLAN.md](docs/plans/active/AGENT_RLS_ROLLOUT_PLAN.md)).
- [ ] Repair or quarantine invalid legacy rows before validating constraints.
- [x] Add transaction-scoped organization and actor context to API, worker, publisher, and operator
      database adapters, including legacy Temporal activity scope recovery
      ([context.ts](agents/src/db/context.ts), [pool.ts](agents/src/db/pool.ts)).
- [x] Add the first RLS policy tranche for memory and knowledge with restricted-role negative
      coverage ([091_memory_knowledge_rls.sql](agents/migrations/091_memory_knowledge_rls.sql)).
- [x] Add the conversation/run RLS tranche with parent-scope checks and restricted-role coverage
      ([092_conversation_run_rls.sql](agents/migrations/092_conversation_run_rls.sql)).
- [x] Add parent-validated RLS for identity, credentials, channels, integrations, effects,
      approvals, schedules, kill switches, and replay state
      ([093_identity_credentials_effects_rls.sql](agents/migrations/093_identity_credentials_effects_rls.sql)).
- [x] Add RLS for lifecycle sidecars, preferences, analytics, retention, legal holds, feature
      flags, and operator control-plane tables; revoke runtime access to `schema_migrations`
      ([094_control_plane_and_lifecycle_rls.sql](agents/migrations/094_control_plane_and_lifecycle_rls.sql)).
- [x] Remove RLS bypass from the application runtime role and document the restricted runtime and
      one-shot migration boundary ([deployment-topology.md](docs/internal/operations/deployment-topology.md));
      a dedicated long-lived migration role remains open.
- [x] Run focused repository and integration suites with a production-equivalent restricted role
      for all four released RLS tranches; the complete production process matrix remains open.
- [ ] Add negative isolation tests for every protected table and every background process type.
- [ ] Add a staged rollout, policy-disable procedure, migration rollback plan, and isolation alerting.
- [x] Record the complete runtime policy inventory and approved platform-operator query scope in
      internal documentation ([agents-tenant-isolation-inventory.md](docs/internal/architecture/agents-tenant-isolation-inventory.md));
      legacy constraint validation, alerting, and the full process matrix remain open.

### P1.3 Replace the retrieval gate and add hybrid ranking

Use a cheap classifier, deterministic intent model, or retrieval-aware model call that returns:

- whether retrieval is needed;
- a normalized search query;
- target namespaces;
- expected source types;
- a bounded reason code for observability.

Fail open or closed according to agent policy. A personal assistant may prefer retrieval on gate
failure. A public support agent may prefer knowledge-only retrieval and prohibit user-private
memory.

Combine keyword and vector candidates, apply ownership filters before ranking, rerank only a
bounded candidate set, and return structured evidence instead of one concatenated string.

#### Implementation checklist

- [x] Define the retrieval decision and structured evidence interfaces
      ([retrieval.ts](agents/src/memory/retrieval.ts)).
- [x] Build an evaluation set containing direct references, paraphrases, unrelated requests, and
      restricted-scope cases ([retrieval.test.ts](agents/test/retrieval.test.ts)).
- [x] Replace the duplicate regex gates with a bounded deterministic classifier; model-based
      semantic classification remains unnecessary until the evaluation set shows this threshold
      is insufficient.
- [ ] Enable pgvector storage and index migrations with measured dimension and index settings.
- [x] Apply existing organization, agent, installation, conversation, user, namespace, expiry,
      and sensitivity filtering before ranking.
- [x] Implement bounded lexical multi-source ranking, deduplication, source diversity, and policy
      token budgeting; vector hybrid ranking remains open ([retrieval.ts](agents/src/memory/retrieval.ts),
      [policy.ts](agents/src/memory/policy.ts)).
- [x] Return provenance and score evidence separately from prompt rendering
      ([retrieval.ts](agents/src/memory/retrieval.ts), [activities.ts](agents/src/temporal/activities.ts)).
- [x] Add retrieval rate, source-count, relevance, and empty-result metrics; latency and explicit
      scope-rejection metrics remain open ([spans.ts](agents/src/telemetry/spans.ts)).
- [x] Document retrieval failure behavior for each current memory policy mode
      ([agent-memory-lifecycle.md](docs/internal/architecture/agent-memory-lifecycle.md)).

### P1.4 Strengthen memory poisoning controls

The current detector matches four regular-expression patterns. Keep it as a cheap first pass, but
do not treat it as a complete poisoning defense.

Add:

- source trust levels;
- contradiction detection against existing facts;
- procedural-memory prohibition for untrusted sources;
- sensitivity and secret detection;
- review states and operator/user review UI;
- extraction-model versioning;
- adversarial tests for indirect and encoded instructions;
- retrieval-time marking of all memory and knowledge as untrusted evidence.

#### Implementation checklist

- [x] Define source trust, sensitivity, review, quarantine, contradiction, and supersession states
      ([poisoning.ts](agents/src/memory/poisoning.ts), [memory-repository.ts](agents/src/db/repositories/memory-repository.ts), migrations 085 and 087).
- [x] Prevent untrusted content from creating procedural memory or changing agent policy ([memory-repository.ts](agents/src/db/repositories/memory-repository.ts), [agent-memory-lifecycle.md](docs/internal/architecture/agent-memory-lifecycle.md)).
- [x] Add secret and personal-data classification before memory persistence ([poisoning.ts](agents/src/memory/poisoning.ts), [memory-repository.ts](agents/src/db/repositories/memory-repository.ts)).
- [x] Implement contradiction checks and explicit supersession links between facts
      ([memory-repository.ts](agents/src/db/repositories/memory-repository.ts), migration 087); conflicting
      facts remain review-pending until an active target is explicitly superseded.
- [x] Add user and operator review actions with complete audit records ([app.ts](agents/src/http/app.ts), [operator-commands.ts](agents/src/http/operator-commands.ts)).
- [x] Mark retrieved memory and knowledge as untrusted evidence in context assembly ([activities.ts](agents/src/temporal/activities.ts)).
- [x] Build adversarial tests for direct, indirect, encoded, and translated poisoning ([memory-poisoning.test.ts](agents/test/memory-poisoning.test.ts)); multi-turn poisoning remains open.
- [x] Add quarantine-rate and review-outcome monitoring ([spans.ts](agents/src/telemetry/spans.ts)); contradiction signals are retained in scoped provenance for review and audit.
- [x] Document incident response and bulk quarantine or deletion procedures ([agent-memory-safety.md](docs/internal/runbooks/agent-memory-safety.md)).

### P1.5 Define conversation ordering explicitly

Messages receive transactional sequence numbers, but different runs for one conversation need a
documented execution policy. Choose and enforce one of these rules:

- one active run per conversation with later messages queued;
- explicit interruption and supersession;
- concurrent runs with deterministic merge rules.

The current default is one active run per conversation with explicit admission backpressure.
Different conversations may run in parallel. Platform requests and channel deliveries that arrive
while a run is active receive `conversation_busy`; channel providers must redeliver the same event
after the run reaches a terminal state. This keeps the current API contract honest while avoiding
silent transcript loss. A durable queued-message table remains a separate decision because it needs
an acknowledgement, promotion, cancellation, and ordering contract.

Admission is protected by a conversation-row transaction lock, the database-backed
`agent_runs_one_active_conversation_uidx` guard, and one Temporal workflow identity per run.

#### Implementation checklist

- [x] Record one-active-run-per-conversation as the default ordering invariant and document explicit
      backpressure/redelivery behavior ([agent-conversation-ordering.md](docs/internal/architecture/agent-conversation-ordering.md)).
- [x] Define received, queued, interrupted/cancelled, superseded, and completed message behavior;
      conversation supersession is not used, while memory supersession remains lineage-based.
- [x] Choose and document the durable ownership mechanism: conversation row lock, unique active-run
      index, and stable Temporal workflow identity ([agent-conversation-ordering.md](docs/internal/architecture/agent-conversation-ordering.md), migration 088).
- [x] Implement atomic admission so two API replicas cannot start competing runs
      ([run-repository.ts](agents/src/db/repositories/run-repository.ts), [platform-chat-repository.ts](agents/src/db/repositories/platform-chat-repository.ts), migration 088).
- [x] Preserve sequence order when retries, channel redelivery, or delayed media completion occurs;
      sequence allocation remains under the conversation row lock.
- [x] Add tests for simultaneous messages and channel redelivery, plus worker replacement and
      cancellation recovery ([platform-chat.integration.test.ts](agents/test/platform-chat.integration.test.ts),
      [temporal-recovery.integration.test.ts](agents/test/temporal-recovery.integration.test.ts)).
- [x] Add bounded admission, busy, retry, and redelivery metrics; durable queue depth, wait-time,
      and stale-ownership metrics remain open until a queued-message mechanism exists.
- [x] Update channel behavior and conversation recovery runbooks
      ([agent-temporal-recovery.md](docs/internal/runbooks/agent-temporal-recovery.md)).

## Priority 2: customization and agent composition

### P2.1 Introduce a typed agent specification

The version `configuration` and `policy` fields currently accept broad records. The UI understands
many fields that the domain schema does not describe as one coherent contract.

Define a versioned `AgentSpec` with typed sections:

```text
identity
behavior
model policy
runtime budgets
capability policy
knowledge collections
memory policy
skills
workflow
channels
handoff policy
release policy
```

Compilation should produce the immutable agent version, grants, validation evidence, and
publication requirements. Platform safety policy remains separate and is applied after user
configuration.

Completion criteria:

- Unknown fields fail validation rather than being ignored.
- Every UI control maps to one typed field.
- Runtime code reads one normalized specification.
- Templates produce ordinary agent specifications.
- Specification migrations are versioned and testable.

#### Implementation checklist

- [ ] Inventory every configuration and policy field used by the API, worker, UI, and templates.
- [ ] Define versioned `AgentSpec` schemas, defaults, compatibility rules, and validation errors.
- [ ] Define one compiler interface that produces an immutable agent version and validation
      evidence.
- [ ] Keep platform safety policy outside user-editable specification fields.
- [ ] Migrate existing versions without rewriting their historical meaning.
- [ ] Make runtime code consume only the normalized compiled specification.
- [ ] Map every creation and editor control to a typed field and reject unknown fields.
- [ ] Convert templates into ordinary specification inputs.
- [ ] Add schema, compilation, migration, round-trip, unknown-field, and historical-version tests.
- [ ] Publish the supported specification contract and internal migration guide.

### P2.2 Add first-class procedural skills

Waku demonstrates the useful behavior: match reusable instructions to the current request and
load them only when relevant. KasiTek should implement this at platform scale.

A skill should contain:

- stable identity and version;
- platform, organization, or user ownership;
- matching metadata;
- instruction content;
- required capabilities and connectors;
- optional knowledge references;
- compatible channels and agent audiences;
- evaluation scenarios;
- release and deprecation status.

An agent version selects allowed skills. The context module loads only matched skills for a run.
Skill instructions remain subordinate to platform safety policy and must not gain tools outside the
installation's effective grants.

#### Implementation checklist

- [ ] Define skill identity, ownership, version, matching, dependency, evaluation, and lifecycle
      schemas.
- [ ] Define the skill registry and matcher interfaces with deterministic test adapters.
- [ ] Add platform, organization, and user ownership rules with database constraints.
- [ ] Add skill selection to `AgentSpec` and pin selected skill versions to agent versions.
- [ ] Load only matched skills within the context token budget.
- [ ] Intersect skill requirements with installation grants and reject undeclared capabilities.
- [ ] Add draft, publish, deprecate, revoke, and migration operations.
- [ ] Add matching, precedence, token-budget, policy-conflict, revocation, and isolation tests.
- [ ] Add skill-match, load, rejection, latency, and evaluation metrics.
- [ ] Document skill authoring, security rules, versioning, and release behavior.

### P2.3 Add a tool-provider and remote MCP interface

The current integration catalog is compiled into application code. Users can grant registered
tools but cannot add arbitrary remote MCP providers as hosted-agent tools.

Introduce a tool-provider module that can support:

- platform-owned capabilities;
- organization-installed remote MCP providers;
- reviewed third-party providers;
- a test adapter for conformance;
- future sandboxed code packages.

Provider installation must include schema discovery, pinning, authentication, egress policy,
timeouts, rate limits, approval classification, output size limits, redaction, health, revocation,
and audit evidence. Tool names and schemas must be pinned to an agent version or installation
revision so a remote provider cannot silently change behavior.

#### Implementation checklist

- [ ] Define one tool-provider interface shared by platform, remote MCP, test, and future sandbox
      adapters.
- [ ] Define provider installation, authentication, ownership, health, revision, and revocation
      records.
- [ ] Implement MCP discovery with schema normalization, size limits, and an immutable manifest.
- [ ] Pin provider and tool revisions to the agent version or installation revision.
- [ ] Apply egress policy, timeouts, rate limits, approval classification, redaction, and output
      limits before invocation.
- [ ] Store credentials through the existing encrypted credential path without exposing them to
      prompts or logs.
- [ ] Add conformance tests that every provider adapter must pass.
- [ ] Add schema-change, provider-down, timeout, revocation, oversized-output, and malicious-server
      tests.
- [ ] Add provider health, invocation, rejection, latency, and schema-drift metrics and runbooks.
- [ ] Release organization-installed providers behind review and allowlist controls.

### P2.4 Add a sandboxed execution module before custom code

Do not run user code inside the shared Temporal worker. Use a dedicated execution pool for custom
code, shell access, browser automation, or unreviewed extensions.

The sandbox interface should accept an immutable execution package and bounded run context, then
return structured output and evidence. The implementation should enforce:

- no platform or database credentials;
- scoped short-lived capability tokens;
- CPU, memory, time, process, and filesystem limits;
- deny-by-default network egress;
- per-run temporary storage;
- output and log limits;
- image and dependency provenance;
- termination and reconciliation behavior.

Choose the concrete isolation technology only after a threat-model and operations spike. Normal
hosted model-and-tool agents should continue using shared workers.

#### Implementation checklist

- [ ] Write the custom-code threat model and classify supported workloads.
- [ ] Define the sandbox execution interface, package format, evidence, and error states.
- [ ] Compare isolation options against startup latency, cost, operations, and escape resistance.
- [ ] Build a disposable proof of concept with no platform or database credentials.
- [ ] Issue scoped short-lived capability tokens for permitted platform operations.
- [ ] Enforce CPU, memory, wall time, process, filesystem, network, output, and log limits.
- [ ] Pin images and dependencies and record provenance for every execution.
- [ ] Add escape, credential, egress, resource exhaustion, termination, and reconciliation tests.
- [ ] Separate sandbox workers, queues, credentials, scaling, logs, and incident controls from hosted
      workers.
- [ ] Complete security review and operational readiness before exposing custom code to users.

### P2.5 Make customization testable before publication

The creation and workflow UI should provide:

- a draft test conversation isolated from live channels;
- visible effective tools and unavailable dependencies;
- memory and knowledge retrieval evidence;
- estimated model and tool budget;
- deterministic workflow validation;
- evaluation results;
- a diff between deployed and candidate versions;
- publication and deployment as separate actions.

#### Implementation checklist

- [ ] Define an isolated draft-run mode that cannot deliver to live channels or mutate live memory.
- [ ] Add an effective configuration view for model, tools, connectors, memory, knowledge, limits,
      workflow, and skills.
- [ ] Add deterministic dependency and workflow validation before model execution.
- [ ] Record retrieval, tool-selection, budget, trace, and evaluation evidence for draft runs.
- [ ] Add a candidate-versus-deployed specification and capability diff.
- [ ] Separate save draft, validate, evaluate, publish, canary deploy, and deploy actions.
- [ ] Add loading, error, accessibility, and responsive behavior for the complete flow.
- [ ] Add end-to-end tests proving draft runs cannot affect production state.
- [ ] Add funnel and failure analytics without recording private prompt or response content.
- [ ] Update user documentation for the final behavior only when it is released.

## Priority 3: scale, fairness, and operations

### P3.1 Separate workload classes

The worker currently uses one Temporal task queue and hard-coded concurrency. Interactive chat,
scheduled work, graph batches, media transcription, recovery, and maintenance have different
latency and resource requirements.

Create separate queues and worker deployments for at least:

- interactive conversations;
- scheduled and batch agents;
- media and transcription;
- long-running integrations;
- maintenance and reconciliation.

Make concurrency configurable and size each worker against provider limits, database pools, and
memory use.

#### Implementation checklist

- [ ] Measure current queue latency, activity duration, worker memory, and concurrency by workload.
- [ ] Define task queue names, ownership, routing rules, and service-level targets.
- [ ] Split interactive, batch, media, integration, and maintenance workers incrementally.
- [ ] Make concurrency, pollers, provider limits, and database pool sizes configurable per worker.
- [ ] Route every workflow and activity to an explicit workload class.
- [ ] Give each worker type separate health, readiness, scaling, and deployment controls.
- [ ] Add queue backlog, schedule latency, execution latency, saturation, and failure alerts.
- [ ] Load test each class and mixed traffic before production rollout.
- [ ] Document queue routing, capacity planning, failure isolation, and rollback procedures.

### P3.2 Add organization fairness and quotas

Installation-level `maxConcurrentRuns` is useful but does not provide organization-wide fairness.
Add:

- organization and plan-level concurrent-run limits;
- request, token, credit, tool, and external-effect quotas;
- queue admission control;
- priority classes;
- per-provider and per-credential rate limits;
- bounded retries and retry budgets;
- noisy-neighbor metrics;
- explicit 429 or queued outcomes.

Parallel workflows must reserve capacity before launching branches.

#### Implementation checklist

- [ ] Define quota dimensions, plan defaults, reset periods, priority classes, and error outcomes.
- [ ] Implement an atomic admission module for organization, installation, provider, and credential
      limits.
- [ ] Reserve capacity before starting runs or parallel branches and release it on every terminal
      path.
- [ ] Add request, token, credit, model, tool, effect, concurrency, and retry budgets.
- [ ] Return explicit queued, rejected, exhausted, and retry-after responses.
- [ ] Add operator overrides with expiry, ownership, reason, and audit evidence.
- [ ] Add concurrency, race, retry, crash, reconciliation, and noisy-neighbor tests.
- [ ] Add quota utilization, rejection, queue time, fairness, override, and leakage metrics.
- [ ] Document plan behavior, customer-visible errors, support actions, and reconciliation runbooks.

### P3.3 Make circuit and rate-limit state distributed where needed

Model circuit breakers currently live in worker memory. Each replica therefore has an independent
view of provider health. Keep process-local protection for fast failures, but add shared provider
health and rate-limit state when multiple replicas must coordinate.

BYOK credentials need tenant-scoped circuits. Platform-funded credentials need provider and model
scope shared across workers.

#### Implementation checklist

- [ ] Define circuit and rate-limit keys for BYOK and platform-funded credentials.
- [ ] Define the shared state interface, expiry rules, failure classes, and local fallback behavior.
- [ ] Implement a distributed adapter with atomic updates and bounded failure impact.
- [ ] Keep process-local short-circuiting for immediate failures without making it authoritative.
- [ ] Add half-open probing, recovery, stale-state, and provider-degradation handling.
- [ ] Add multi-replica tests for coordinated limits, recovery, partition, and shared-store failure.
- [ ] Add circuit state, open duration, probe outcome, limit wait, and fallback metrics.
- [ ] Document operator override and provider incident procedures.

### P3.4 Protect PostgreSQL as the platform scales

- Budget database connections across every API, worker, gateway, and publisher replica.
- Add PgBouncer or an equivalent pooler before horizontal scaling exhausts PostgreSQL connections.
- Measure hot indexes for runs, messages, memory, knowledge, approvals, and outbox queues.
- Partition or archive high-volume append-only tables only after measured pressure.
- Keep canonical text and ownership in PostgreSQL even if vector search moves to another store.
- Test backup, point-in-time recovery, migration rollback, and tenant-scoped deletion.

#### Implementation checklist

- [ ] Inventory maximum database connections for every service and production replica count.
- [ ] Set explicit pool budgets and alerts before adding replicas.
- [ ] Capture slow-query and index-use evidence for the highest-volume agent tables.
- [ ] Add or tune indexes only against measured query plans and representative data.
- [ ] Test PgBouncer or an equivalent pooler with transactions, prepared statements, migrations,
      workers, and RLS context.
- [ ] Define retention, archive, and partition thresholds based on measured table growth.
- [ ] Run restore, point-in-time recovery, migration rollback, and tenant deletion drills.
- [ ] Load test API, interactive workers, batch workers, and analytics delivery together.
- [ ] Document capacity limits, pool ownership, query review, backup, restore, and scaling runbooks.

### P3.5 Deepen oversized orchestration modules

The main HTTP application, Temporal activities file, and agent repository currently contain
thousands of lines and many unrelated responsibilities. This increases the chance of missed
authorization predicates and makes tests depend on broad setup.

Split them around deep domain modules, not route-shaped pass-through files. Good candidates are:

- agent lifecycle and deployment;
- hosted run execution;
- graph execution;
- capability acceptance and invocation;
- memory lifecycle;
- knowledge ingestion and retrieval;
- channel ingestion and delivery;
- handoff coordination;
- operator controls;
- evaluation and publication.

Each module should expose one small interface, own its invariants, and accept adapters for remote
owned systems or external providers.

#### Implementation checklist

- [ ] Record current callers, dependencies, invariants, and tests for each oversized file.
- [ ] Choose one domain module at a time and define its external interface before moving code.
- [ ] Keep authorization, transactions, idempotency, and error translation inside the owning
      module.
- [ ] Pass database and provider adapters into modules instead of constructing them inside.
- [ ] Move existing contract tests to the module interface before deleting old paths.
- [ ] Replace callers directly instead of layering permanent pass-through wrappers.
- [ ] Remove dead routes, duplicate validation, and obsolete helpers after each migration.
- [ ] Track file size, dependency direction, interface size, and test setup as review signals.
- [ ] Update architecture and ownership documentation after each extracted module lands.

## Priority 4: evaluations and release control

### P4.1 Make evaluations part of publication

The current deterministic assertion engine is useful but too small to judge an agent release.
Every candidate version should run:

- deterministic policy and workflow tests;
- golden conversation scenarios;
- tool-selection and argument tests;
- prompt-injection and tool-abuse tests;
- memory retrieval and poisoning tests;
- cross-agent and cross-organization isolation tests;
- channel formatting and delivery tests;
- budget and termination tests;
- regression comparisons against the currently deployed version.

Model-judged quality may supplement deterministic tests. It must record the evaluator model,
rubric, prompt version, evidence, and uncertainty.

#### Implementation checklist

- [ ] Define evaluation suites by agent type, capability risk, channel, and release change class.
- [ ] Add versioned fixtures for golden conversations, tools, memory, attacks, budgets, and channels.
- [ ] Run deterministic checks first and make blocking criteria explicit.
- [ ] Add model-judged checks only where deterministic assertions cannot measure the requirement.
- [ ] Store evaluator model, rubric, prompt version, inputs, outputs, scores, and uncertainty.
- [ ] Compare every candidate against its deployed version and flag material regressions.
- [ ] Prevent publication when required suites fail or evidence is incomplete.
- [ ] Add flake detection, retry limits, cost budgets, and evaluator drift checks.
- [ ] Add evaluation pass rate, regression, latency, cost, and override metrics.
- [ ] Document suite ownership, review cadence, exception approval, and failure investigation.

### P4.2 Define publication and deployment gates

A version may progress through:

```text
draft
  -> validated
  -> evaluation_passed
  -> published
  -> canary_deployed
  -> deployed
  -> retired
```

The product does not need to expose every internal state, but the control plane must distinguish
them. High-risk changes to tools, workflows, memory policy, or model funding should require stronger
gates than copy-only instruction changes.

#### Implementation checklist

- [ ] Define the state machine, transition permissions, required evidence, and terminal states.
- [ ] Classify change risk from specification diffs rather than trusting a user-selected label.
- [ ] Store immutable validation, evaluation, approval, publication, and deployment records.
- [ ] Enforce transitions in one lifecycle module used by every route and worker.
- [ ] Require stronger review for tools, memory policy, model funding, workflows, and external
      effects.
- [ ] Add optimistic concurrency and idempotency to every transition.
- [ ] Add transition, permission, stale-write, replay, failure, and rollback tests.
- [ ] Show concise current, blocked, and next states in the UI without exposing internal process
      details.
- [ ] Emit lifecycle analytics and structured logs and update user and operator documentation.

### P4.3 Add canary, rollback, and post-release evidence

- Deploy candidate versions to selected installations or test conversations.
- Compare completion, error, latency, cost, handoff, approval, and user-feedback metrics.
- Preserve the exact tested version, capability manifest, model policy, and workflow revision.
- Roll back installation deployment without rewriting historical runs.
- Record the platform release ID separately from the customer-created agent version.

#### Implementation checklist

- [ ] Define canary selection by installation, test conversation, organization, and percentage.
- [ ] Capture an immutable deployment manifest for the tested agent and platform artifacts.
- [ ] Define success thresholds and automatic halt or rollback conditions before deployment.
- [ ] Implement progressive rollout with pause, resume, abort, and rollback operations.
- [ ] Preserve historical run versions while moving future runs to the selected version.
- [ ] Compare error, completion, latency, cost, approval, handoff, and feedback metrics against the
      current deployment.
- [ ] Add rollout race, partial failure, worker restart, metric outage, and rollback tests.
- [ ] Add deployment dashboards, alerts, structured events, and an operator runbook.
- [ ] Record the platform release ID, agent version, manifest, migration, configuration revision,
      owner, and post-release review result.

## Waku-derived capabilities to preserve

Waku remains useful as a reference for these system-design choices:

- a small, understandable observe, reason, act loop;
- a clear context-building step before model execution;
- retrieval only when memory helps;
- semantic and episodic consolidation after enough evidence exists;
- reusable procedural skills loaded when relevant;
- deterministic routing outside model control;
- explicit loop and graph termination limits;
- parallel branches that cannot silently overwrite each other;
- adapters for memory implementations behind one interface;
- tests that run the same contract against every adapter.

KasiTek should retain its stronger platform features around that anatomy:

- multi-tenant identity and ownership;
- versioned installations and grants;
- Temporal durability;
- approval and effect records;
- channels and delivery;
- REST and MCP parity;
- billing and usage evidence;
- operator controls;
- analytics, retention, and audit.

## Suggested execution sequence

### Tranche 1: stop misleading or unsafe behavior

- [ ] Fix publication versus deployment semantics.
- [ ] Constrain graph publication to the verified subset.
- [ ] Add failing tests for every reproduced graph bug.
- [ ] Align activity timeouts with enclosed work and prevent whole-loop retries from repeating work.
- [ ] Correct graph budget and usage accounting.

- [ ] Exit evidence recorded: published and deployed versions match the UI, and no enabled workflow
      node can violate state, limit, merge, or budget contracts.

### Tranche 2: rebuild workflow durability

- [ ] Implement node-level durable graph execution.
- [ ] Wire the bounded loop as a real graph node.
- [ ] Add branch deltas and one-time fan-in.
- [ ] Add heartbeat and cancellation behavior.
- [ ] Run crash recovery tests at every non-terminal state.

- [ ] Exit evidence recorded: a worker can die after any node or tool boundary and another worker
      resumes without lost state, repeated effects, or incorrect usage.

### Tranche 3: complete agent memory and isolation

- [ ] Add memory policy to the agent specification.
- [ ] Add conversation extraction and consolidation.
- [ ] Replace the regex retrieval gate.
- [ ] Enable hybrid keyword and vector retrieval.
- [ ] Validate legacy ownership constraints.
- [x] Add the four staged RLS tranches and restricted-role negative isolation tests for runtime
      table groups; `schema_migrations` remains administrative and privilege-revoked
      ([091_memory_knowledge_rls.sql](agents/migrations/091_memory_knowledge_rls.sql),
      [092_conversation_run_rls.sql](agents/migrations/092_conversation_run_rls.sql),
      [093_identity_credentials_effects_rls.sql](agents/migrations/093_identity_credentials_effects_rls.sql),
      [094_control_plane_and_lifecycle_rls.sql](agents/migrations/094_control_plane_and_lifecycle_rls.sql)).
- [ ] Validate legacy ownership constraints and complete negative coverage for every background
      process type.

- [ ] Exit evidence recorded: agents learn only under declared policy, retrieve relevant evidence,
      and cannot access another agent's private data if an application query omits a tenant
      predicate.

### Tranche 4: improve composition and customization

- [ ] Introduce the typed agent specification.
- [ ] Convert templates to specification inputs.
- [ ] Add procedural skills.
- [ ] Add remote MCP tool providers.
- [ ] Add draft evaluation and deployment diff UI.

- [ ] Exit evidence recorded: users can compose materially different agents without editing untyped
      records or requiring a platform deployment for every reviewed integration.

### Tranche 5: add sandboxing and scale controls

- [ ] Build the isolated execution spike and threat review.
- [ ] Separate Temporal workload classes.
- [ ] Add organization fairness and distributed provider controls.
- [ ] Add database connection management and load tests.
- [ ] Add canary deployment and publication gates.

- [ ] Exit evidence recorded: untrusted extensions cannot reach platform credentials or other
      tenants, and one organization cannot consume unbounded worker, provider, or database
      capacity.

## Verification performed for this audit

- `pnpm --dir agents run build` passed.
- Full Agent Platform test suite passed with 483 tests and 45 environment-dependent tests skipped.
- Targeted runtime, workflow, memory-poisoning, context, and evaluation tests passed.
- Direct graph reproductions confirmed ignored state schemas, ignored edge iteration limits,
  fan-out state loss, and repeated join execution.
- Source tracing confirmed no production conversation-to-memory creation call.
- Source tracing confirmed user-version publication does not roll existing installations forward.
- Source tracing confirmed production graph execution does not inject an `agentLoop` adapter.
- Retrieval evidence tranche `6215196e` passed targeted retrieval/policy tests (`11/11`), the full
  non-database Agents suite (`85 passed, 18 skipped`; `533 passed, 52 skipped`), typecheck, and
  build. Its three Railway service deployments reached `SUCCESS` and health/readiness smoke checks
  returned `200`.
- Tenant context/RLS tranche `2031a0ca` and compatibility follow-up `b831e1c3` passed the full
  Agents suite (`542 passed, 57 skipped`),
  typecheck, build, transaction-context integration, and restricted-role RLS integration (`3/3`).
  Production deployments for API, worker, and Gateway reached `SUCCESS`; production migration
  `091` is recorded and all four first-tranche tables report both RLS and FORCE RLS. Compatibility
  follow-up `b831e1c3` adds scope recovery for legacy workflows and is deployed successfully on all
  three Agents services.
- Conversation/run isolation migration `092` is recorded in production. Its 21 tables report both
  RLS and FORCE RLS, production ownership audits returned zero mismatches, and the restricted-role
  production probe hid tenant A from tenant B, rejected a valid wrong-context write, and allowed
  both rows only under explicit platform-operator scope.
- Identity/credential/channel/effect isolation migration `093` is recorded in production. Its 23
  tables report both RLS and FORCE RLS; the local restricted-role suite passed four tests, and the
  production ownership audit returned zero mismatches for the covered parent paths. The compatible
  Agents API, worker, and Gateway deployments from commit `41c8fc97` reached `SUCCESS`.
- Lifecycle/control-plane isolation migration `094` is recorded in production. Production reports
  64 public base tables, 63 with both RLS and FORCE RLS, and only `schema_migrations` outside RLS
  because runtime and application roles cannot access it. The local lifecycle suite passed three
  restricted-role tests; the production probe showed tenant-specific sidecars/outbox visibility
  and operator-only control-plane visibility. The API live/ready and Gateway ready checks returned
  `200`; the worker reached `RUNNING` after the same successful deployments.

Passing tests do not invalidate the verified findings. The current suite does not cover those
contracts.

## Release requirements for implementation work

Every tranche above is a non-trivial platform change. Its implementation plan and pull request
must record:

- owner and risk level;
- affected process types and user flows;
- schema, migration, and compatibility changes;
- feature flag or rollout method;
- analytics events and success metrics;
- structured logs, metrics, alerts, and runbook updates;
- validation evidence;
- rollback or disable path;
- platform release ID, commit, artifact, and migration versions;
- post-release review date.

High-risk changes require staging or an equivalent isolated environment. Workflow, memory, RLS,
and sandbox changes need explicit migration and rollback drills before production rollout.

## Final position

KasiTek already has the main modules of a serious agent platform. The bounded hosted loop with
reviewed tools is the most trustworthy execution path today. The data model also has the right
concepts for keeping agents separate inside shared infrastructure.

The next phase should not add more advertised node types or broad customization fields. It should
make the existing contracts true. Fix version deployment, graph correctness, retry safety, memory
lifecycle, and database-enforced isolation first. Then add skills, remote tool providers,
sandboxing, fair scheduling, and publication gates on top of those guarantees.
