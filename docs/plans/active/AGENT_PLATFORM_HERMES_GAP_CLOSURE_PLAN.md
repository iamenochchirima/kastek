---
id: agent-platform-hermes-gap-closure
title: Agent Platform Hermes gap closure and runtime rework
sidebar_label: Hermes gap closure
slug: /hermes-gap-closure
description: Implementation plan for reworking the Agent Platform around the mature Hermes runtime patterns that KasiTek still lacks.
---

# Agent Platform Hermes gap closure and runtime rework

**Status:** Active; immediate runtime durability block implemented with integration gaps explicitly tracked

**Owner:** Agent Platform

**Last updated:** 2026-09-07

**Depends on:** [`Agent Platform Hermes-Aligned Runtime Reliability`](./AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md)

**Reference implementation:** `/home/enoch/aworkspace/agents/hermes-agent`, revision
`9a84bee265daad14340a80d7585928cd8ea1f9eb`, reviewed 2026-09-07.

**Related plan:** [`Agent Platform Implementation Plan`](../agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md)

## Objective

Rework the Agent Platform runtime around the mature parts of Hermes that are still missing or too
shallow in KasiTek. The result must make context, token budgets, sessions, tools, extensions,
MCP, durable operations, and child agents predictable under retries, worker loss, reconnects, and
provider failures.

This is an implementation plan, not a proposal to vendor Hermes. We adopt the useful contracts and
failure behaviour, then adapt them to Temporal, PostgreSQL, tenant isolation, hosted credentials,
approvals, provider reconciliation, and KasiTek's channel model.

The existing agent UI is not the control point for this work. The runtime contracts come first.
The visual Playground consumes those contracts later, while the separate UI work can continue
without being treated as the source of truth for execution.

## Immediate runtime completion block

This block must be completed before the Agent Platform moves to the agent-creation interface or
the Playground interface. It covers the five remaining runtime gaps that can otherwise produce
duplicate child work, unsafe plugin execution, lost context decisions, or stale workers writing
after they have lost ownership.

Agent creation and visualization are deliberately out of scope here. They will consume these
runtime seams after this block is certified. Existing local data may be discarded during the
rewrite; the invariants and verification evidence are what must survive.

### A. Temporal child activation

The bounded child kernel is currently host-neutral. This section activates it through Temporal
without copying child transcripts into the parent or holding a worker while a child waits.

- [x] Define the durable child workflow input/output contract: parent scope, child version,
  attenuated grants, child session key, idempotency key, budgets, timeout, and operation identity.
- [x] Register a child workflow and activities in the Temporal worker with explicit task-queue and
  retry policies. The workflow must be deterministic and must not call providers directly.
- [x] Add a Temporal adapter behind the child kernel that starts or reuses a child workflow by
  deterministic identity, waits durably, and returns typed success, failure, cancellation, timeout,
  or partial-result outcomes.
- [x] Expose child invocation to the harness as one capability. The parent model cannot choose
  organization, installation, credentials, or grants outside the admitted parent scope; the child
  host executor remains an explicit adapter and fails closed when not configured.
- [x] Persist parent/child lineage, progress, and terminal evidence through the execution journal;
  progress delivery must not change the child outcome when a subscriber is disconnected.
- [ ] Add worker-loss, duplicate-start, parent-cancel, child-timeout, partial-result, depth, fan-out,
  and budget-reconciliation tests against the Temporal adapter. Unit coverage is present; the
  Temporal/PostgreSQL failure-injection matrix remains environment-dependent.

### B. Durable MCP and session operation coordination

The MCP boundary and session lease repository now share a durable operation coordinator. This
section makes provider uncertainty, retry semantics, and session ownership explicit at the same
seam; bounded queues and infrastructure failure matrices remain open.

- [x] Define one operation identity and lifecycle contract for model calls, native tools, MCP calls,
  approvals, and channel delivery: proposed, running, completed, failed, interrupted, or unknown.
- [x] Add a durable operation repository/adapter with idempotency conflict detection, attempt number,
  provider request identity, response receipt, retry decision, and reconciliation metadata.
- [x] Route MCP calls through the durable operation coordinator, including snapshot checksum,
  operation identity, retry classification, timeout, cancellation, and unknown-outcome handling.
- [x] Route session admission, heartbeat, and release through the same coordinator interface without
  making PostgreSQL or Temporal details visible to callers. Queued-turn promotion still belongs to
  the session queue work below.
- [ ] Add explicit bounded backpressure and queue outcomes (`queued`, `limited`, `rejected`) with
  age, depth, and stale-owner metrics.
- [ ] Add restart and worker-loss tests at before-call, during-call, after-call-before-receipt, and
  after-receipt points for MCP and session-owned operations.

### C. Plugin execution isolation

Plugin manifests and package snapshots define what may be selected, but executable plugin code must
not run inside the Temporal worker or import the Agent Platform's internal modules.

- [x] Define an approved plugin runtime descriptor: package digest, entrypoint, protocol version,
  declared capabilities, resource limits, timeout, cancellation, and allowed environment references.
- [x] Add an isolated plugin adapter with a narrow request/response protocol. The adapter supports
  subprocess or worker isolation, bounded input/output, crash detection, cancellation, and no secret
  or prompt logging.
- [x] Enforce package checksum, runtime compatibility, granted permissions, and tenant scope again at
  execution time; publication readiness is not execution authorization.
- [x] Add plugin process supervision and cleanup for startup failure, crash, timeout, cancellation,
  worker loss, and orphaned child processes.
- [x] Expose plugins through the capability registry as ordinary tools with the same approval,
  idempotency, redaction, and durable-operation rules as native tools.
- [ ] Add the full adversarial matrix for import escape, undeclared capability use, oversized output,
  secret leakage, duplicate execution, and stale snapshot use. Boundary tests cover protocol,
  digest/grant/scope rejection, output limits, crash, timeout, cancellation, and redacted evidence;
  duplicate-execution and published-snapshot integration tests remain.

### D. Durable context compaction

The provider-aware planner now bounds requests, and compaction decisions have a durable adapter.
This section makes context reduction replayable and safe when a summary model is unavailable.

- [x] Define a durable context-decision record containing turn identity, planner revision, input
  accounting, selected/omitted ranges, protected pairs, tool/result truncations, and outcome.
- [x] Add a deterministic compaction fallback that produces a bounded, clearly marked summary from
  durable messages without claiming facts that were not present. Durable history must remain intact.
- [x] Add an optional summary-provider adapter with its own operation identity and fallback path;
  an unavailable summary provider must not block the turn indefinitely.
- [x] Persist and replay compaction results by turn/context revision so a Temporal retry sends the
  same model-facing projection instead of compacting differently on each attempt.
- [ ] Replace the remaining in-memory ContextEngine lifecycle state with a durable adapter while
  retaining a fast in-memory implementation for unit tests.
- [ ] Add context-pressure, summary-provider failure, worker-loss, replay, protected-pair, and
  provider-usage reconciliation tests with journal assertions.

### E. Fencing-token propagation

Database-backed session leases issue monotonic fencing tokens, and the token now flows through the
session-owned Temporal write paths. This section closes the remaining stale-worker test and matrix
gaps.

- [x] Add the acquired session key and fencing token to the admitted execution scope and durable
  operation context; they remain runtime metadata and never enter model messages or tool arguments.
- [x] Add one repository/helper assertion for current, unexpired owner and fencing token, with a
  typed `SESSION_LEASE_FENCED` result instead of a generic database error.
- [x] Require the token on session-owned run transitions, message writes, tool/model evidence,
  delivery obligations, approvals, workflow checkpoints, and journal appends. Long-running model,
  tool, MCP, and graph paths renew and assert the lease before durable callbacks.
- [x] Make lease heartbeat/release and terminal transitions idempotent while rejecting stale owners;
  a stale worker must stop before starting another model/tool/effect operation.
- [ ] Add concurrent-owner, expiry/reacquisition, stale-write, retry, reconnect, and terminal-release
  tests across PostgreSQL and the in-memory conformance adapter. Unit coverage is present; the
  clean PostgreSQL/Temporal matrix remains to be run.

### Completion gate for this block

- [ ] Every item above has code, focused tests, and a link to verification evidence. The completed
  runtime seams have commit evidence below; the remaining matrix items are not being marked done.
- [ ] Temporal worker-loss and PostgreSQL integration matrices pass in a clean local environment.
- [ ] No plugin, MCP, child, context, or session path can hang indefinitely without a typed terminal
  or waiting state.
- [ ] The runtime exposes enough redacted journal evidence for the later Playground, but no UI work
  is required to close this block.

### Current implementation evidence

The runtime work completed so far is split into reviewable commits rather than one unbounded change:

| Area | Evidence | Verification |
| --- | --- | --- |
| Temporal child activation | `a270980f` and `202579f2` | child contract, deterministic workflow adapter, lineage/progress path, and harness capability tests |
| Durable operations and MCP | `3894f4a6` and `202579f2` | durable lifecycle tests, MCP boundary tests, and full agent suite |
| Session coordination and fencing | `f2f2bead`, `03ccb569`, `202579f2`, `42a976ed` | scope, lease, session coordinator, and workflow fencing tests |
| Plugin isolation | `698e6f4f` and `202579f2` | 12 plugin protocol/isolation/capability tests |
| Durable context compaction | `07132fed`, `6e6d97df`, and `202579f2` | context compaction, context planning, replay, and build verification |

The current local verification baseline is `pnpm --dir agents test`: **149 test files passed,
28 skipped; 839 tests passed, 88 skipped**. The skips are database/Temporal integration suites that
require the local infrastructure matrix. `pnpm --dir agents run build` and `git diff --check` also
pass. The full Temporal child executor host adapter and the clean PostgreSQL/Temporal failure matrix
remain open; the worker fails closed rather than silently running a child without an execution host.

## What changes in this pass

We are not preserving accidental behaviour from the current agent implementation. Existing local
data may be discarded while developing this rewrite. Old code paths may be removed once the new
contract has coverage. Compatibility is kept only where an external protocol or release decision
requires it.

The work must not create another layer of wrappers around the current loops. Each gap gets one
deep module with a small interface, one durable owner, and conformance tests for the adapters.

## Hermes adoption map

| Hermes reference | KasiTek decision | Work required |
| --- | --- | --- |
| `agent/context_engine.py`, `context_compressor.py` | Adopt the context-engine lifecycle; adapt persistence and provider contracts | Replace scattered token estimates with one request-budget planner, bounded projections, deterministic pruning, compaction, and explicit limited outcomes |
| `agent/conversation_loop.py` and turn phase modules | Adopt one turn state machine; adapt it to bounded Temporal activity slices | Make model calls, tool rounds, retries, empty responses, interruptions, and continuation use one state machine |
| `tools/registry.py`, `tool_result_storage.py`, `tool_output_limits.py` | Adopt a narrow capability registry and result boundary | Make every tool result bounded, redacted, persisted, and model-projectable before it enters context |
| `skills/`, `skill_bundles.py`, `skill_manager_*` | Adopt skills as versioned procedural extensions | Add install, publish, pin, readiness, selection, provenance, revocation, and safe loading contracts |
| `hermes_cli/plugins_loader.py` and plugin manifests | Adopt explicit plugin packages; adapt execution to isolated approved adapters | Define plugin package lifecycle, dependency checks, capability declarations, permissions, runtime compatibility, and tenant-safe activation |
| MCP configuration, discovery, schema, OAuth, and lifecycle modules | Adopt MCP as a managed extension transport | Add server lifecycle, schema caching, reconnect, timeout, cancellation, orphan cleanup, and scoped credentials behind one adapter |
| `tui_gateway/session_lifecycle.py`, active-session leases, persistence | Adopt session ownership and single-writer rules | Replace ad hoc active-run limits with durable session admission, leases, queued turns, reconnect ownership, and bounded backpressure |
| `tools/approval*`, gateway waits, interrupts | Adopt fail-closed approval and human-wait behaviour | Make approval, cancellation, expiry, and disconnect wakeups durable and visible to every channel |
| `tools/delegate_tool*`, `agent/subagent_lifecycle.py` | Adopt fresh-context delegation and progress isolation | Activate bounded child workflows with attenuated authority, result contracts, budgets, and parent/child evidence |
| Hermes status, trace, stream, and progress modules | Adopt explicit runtime status and progress events | Extend the journal so the later Playground can render a complete execution graph without reading private tables |

## Target runtime shape

```text
Channel / API / host
        |
        v
Session admission and ownership
        |
        v
Agent creation snapshot -> AgentHarness
        |
  +-----+------------------+-------------------+
  |                        |                   |
Context engine       Turn state machine   Capability registry
  |                        |                   |
  +-----------+------------+-------------------+
              |
       Operation coordinator
              |
  +-----------+------------+-------------------+
  |                        |                   |
Journal and events   Delivery obligations   Child workflows
              |
       Provider/channel adapters
              |
       Later: Agent Playground
```

The model must never receive or choose organization, installation, credential, or scope IDs from
untrusted tool arguments. The runtime derives scope from the admitted session and pinned agent
version.

## Implementation workstreams

### 1. Context and token execution kernel

This is the first implementation target because every other runtime feature depends on a reliable
model request boundary.

- [x] Define the `ContextEngine` lifecycle seam for turn start, request planning, provider usage
  accounting, and turn completion, with content-free diagnostics and a journal observer seam.
  Evidence: `agents/src/runtime/context-engine.ts` and `agents/test/context-engine.test.ts`.
- [x] Extend the engine with durable compaction/pruning state and a provider-independent summary
  fallback. Evidence: `agents/src/runtime/context-compaction.ts`,
  `agents/src/db/repositories/context-compaction-repository.ts`, migration `118_agent_context_compaction_revisions.sql`,
  and the Temporal turn wiring.
- [x] Replace fixed `estimateTokens` decisions at the final model boundary with a provider-aware
  planner that reserves output capacity, bounds schemas/results, protects tool pairs, and reconciles
  provider-reported usage. Evidence: `agents/src/runtime/context-planning.ts`,
  `agents/src/runtime/loop.ts`, and `agents/test/context-planning-loop.test.ts`.
- [x] Replace the remaining fixed `estimateTokens` decisions in context assembly with the same
  planner contract. It now accounts for system instructions, history, summaries, retrieved evidence,
  tool schemas, tool results, requested output, and provider overhead through the shared planner.
  Evidence: `agents/src/runtime/context.ts` and `agents/test/context.test.ts`.
- [ ] Make the planner return a typed decision: `ready`, `compact`, `prune`, `limited`, or
  `cannot_fit`, with exact accounting and omitted-content reasons.
- [x] Add deterministic tool-result limits before model dispatch. Full results remain durable only
  in the durable run evidence; the model receives a bounded projection. Evidence: context planner
  tests and the model-boundary integration test.
- [x] Add protected message-pair handling so assistant tool calls and tool results cannot be split
  by the new model-boundary planner. Evidence: `agents/test/context-planning.test.ts`.
- [x] Add one compaction implementation with a deterministic fallback when the summary provider is
  unavailable. Compaction never deletes durable history; the projection is persisted separately.
- [x] Add bounded same-model empty-response recovery and a terminal typed outcome so a provider
  cannot produce an unbounded zero-response loop. Evidence: `agents/src/runtime/loop.ts`,
  `agents/test/empty-response-recovery.test.ts`, and the runtime terminal-outcome test.
- [ ] Complete the Hermes-style recovery ladder with interrupted-stream recovery, reasoning
  prefill where supported, fallback-provider policy, and per-attempt retry budgets.
- [x] Persist context decisions, token usage, compaction count, and limited reasons in the journal
  projection. Evidence: `executeLoopForRun` context-step output and `agent.context.built` event.
- [x] Add provider contract tests for exact-fit, oversized history, oversized tool schema, large
  tool output, and provider-usage reconciliation. Evidence: `agents/test/context-planning.test.ts`,
  `agents/test/context-overflow-recovery.test.ts`, and `agents/test/context-planning-loop.test.ts`.
- [x] Add provider contract tests for overflow response, empty response, and retry exhaustion.
  Evidence: `agents/test/context-overflow-recovery.test.ts`,
  `agents/test/empty-response-recovery.test.ts`, and `agents/test/runtime.test.ts`.
- [ ] Add interrupted-stream recovery tests and provider-specific recovery behaviour.

Hermes references: `agent/context_engine.py`, `agent/context_compressor.py`,
`agent/turn_preflight_gate.py`, `agent/turn_empty_response.py`, and `tools/tool_output_limits.py`.

### 2. Session state, admission, and flow control

- [x] Define the session ownership contract and a deterministic in-memory conformance adapter for
  queueing, lease expiry, heartbeat, fencing, FIFO ordering, and idempotent submission. Evidence:
  `agents/src/runtime/session-ownership.ts`, `agents/src/runtime/in-memory-session-ownership.ts`,
  and `agents/test/session-ownership.test.ts`.
- [ ] Introduce a durable session key separate from the conversation display record. A session key
  identifies the ordered interaction stream; a conversation remains a product record.
- [x] Add the first database-backed session lease with owner, heartbeat, expiry, monotonic fencing
  token, RLS, fail-closed acquisition, and terminal release. It is integrated with conversation
  admission and bounded Temporal slices. Evidence: migration `116_agent_session_leases.sql`,
  `SessionLeaseRepository`, `RunRepository.canAcquireConversationTurn`, and Temporal activities.
- [x] Propagate the acquired fencing token through session-owned writes so a stale worker is rejected
  at the activity boundary and at long-running model/tool/graph callback boundaries. Evidence:
  `SessionLeaseGuard`, `RunRepository.assertConversationLease`, and the Temporal activity callbacks.
- [ ] Move same-session ordering, queue age, cancellation, and backpressure into one session
  coordinator instead of spreading them across route handlers and run admission.
- [ ] Make reconnects resume from a journal cursor and preserve one active writer per session.
- [ ] Add bounded queue policies for per-installation and organization flow control, with explicit
  `queued`, `limited`, and `rejected` outcomes and operator metrics.
- [ ] Ensure human approval, external-event waits, channel disconnects, and session shutdown wake
  the durable owner without leaving an activity or thread hanging.

Hermes references: `tui_gateway/session_lifecycle.py`, `session_reaper.py`, `session_auto_continue.py`,
`session_persistence.py`, and active-session lease modules.

### 3. Skills, plugins, and agent extension management

- [x] Define and export a validated extension package manifest for declarative skills, executable
  plugin declarations, and MCP stdio/HTTP adapters. It includes runtime compatibility, dependency
  ranges, permissions, configuration schema, checksums, and typed readiness failures. Evidence:
  `agents/src/extensions/package-manifest.ts`, `agents/src/extensions/index.ts`, and
  `agents/test/extension-package-manifest.test.ts`.
- [x] Reconcile the new package manifest with the persisted extension-package repository and the
  immutable agent-version snapshot; the runtime now requires exact package identity, version,
  checksum, lifecycle state, and grant selection, while preserving legacy declarations. Evidence:
  `agents/src/db/repositories/extension-snapshot-repository.ts`,
  `agents/src/extensions/resolver.ts`, and
  `agents/test/extension-snapshot-canonical-packages.test.ts`.
- [x] Add typed extension package selection to the agent authoring contract, including checksums,
  configuration, and explicit permission grants. Evidence: `agents/src/domain/agent-spec.ts` and
  `agents/test/agent-spec-extensions.test.ts`.
- [ ] Make publication resolve those selected packages through the persisted package catalog and
  fail closed when a package is unavailable, revoked, or not ready. The current typed selection is
  intentionally not treated as a runtime grant until this reconciliation is complete.
- [ ] Separate declarative skills from executable plugins. Skills may provide instructions, examples,
  and procedural memory. Plugins must run through an approved adapter or isolated service and may
  not import the worker's internal modules.
- [ ] Add extension install, validate, publish, pin, revoke, and delete operations with immutable
  version records and checksums.
- [ ] Resolve dependencies before publication, not during a live run. A run receives an immutable
  extension snapshot and provenance for every selected extension.
- [ ] Add readiness checks for missing secrets, unavailable connectors, incompatible runtime
  versions, revoked packages, and missing grants.
- [ ] Add skill selection and loading limits so a large skill catalogue does not become a large
  prompt. Record why a skill was selected or omitted.
- [ ] Add safe reload rules. A running session keeps its snapshot; new sessions use the new
  published version.
- [ ] Expose a customer agent creation flow based on agent profile plus extension registry. Do not
  make ordinary agents into n8n-style block graphs.

Hermes references: `skills/`, `agent/skill_bundles.py`, `tools/skills_tool.py`,
`hermes_cli/plugins_loader.py`, and plugin manifest tests.

### 4. MCP and external capability management

- [ ] Make MCP server configuration a versioned extension with scoped credential references,
  allowed tools, transport, timeout, and lifecycle policy.
- [x] Add a host-neutral MCP operation boundary for scoped snapshots, schema/result bounds,
  redaction, cancellation, timeout, and typed retryable/terminal/unknown outcomes. Evidence:
  `agents/src/mcp/operation-boundary.ts`, the signal-aware `agents/src/mcp/remote.ts`, and
  `agents/test/mcp-operation-boundary.test.ts`.
- [ ] Add one MCP adapter for discovery, schema caching, call execution, timeout, cancellation,
  reconnect, and structured error classification.
- [ ] Supervise stdio MCP processes and clean up orphaned children. A dead or hung server must
  produce a visible typed capability state, not an indefinite agent wait.
- [ ] Bound schemas and results before they enter the context engine.
- [x] Persist MCP operation identity and provider uncertainty through the same operation coordinator
  used by native capabilities. Evidence: `agents/src/mcp/operation-boundary.ts`,
  `RemoteMcpProviderRepository`, and migration `117_durable_operations.sql`.
- [ ] Add credential revocation and server reload tests that prove active runs retain their snapshot
  while new runs see the change.

Hermes references: `tools/mcp_tool_lifecycle.py`, `mcp_tool_config.py`, `mcp_schema_cache.py`,
`mcp_tool_errors.py`, and `mcp_death_supervisor.py`.

### 5. Durable execution and external effects

- [x] Define the operation coordinator contract for model calls, native tools, MCP calls, approvals,
  channel sends, and Core effects. The current pass has durable repository ownership for MCP and
  session operations; native model/effect/delivery migration remains a subsequent work item.
- [x] Add explicit operation states for proposed, running, completed, failed, interrupted, and
  unknown. Unknown means a provider may have performed an effect and requires reconciliation.
- [x] Persist provider request identity, attempt number, response receipt, and retry decision before
  retrying an uncertain operation.
- [ ] Add bounded retry and timeout policies by operation class. No retry may repeat a confirmed
  external effect.
- [ ] Route every channel/provider send through the delivery obligation coordinator and reconcile
  unknown sends after restart.
- [ ] Add worker-loss tests at before-call, during-call, after-call-before-receipt, and after-receipt
  points for native, MCP, Core, and channel operations.

### 6. Multi-agent execution

- [x] Add a host-neutral bounded child execution kernel with attenuated grants, depth/fan-out/
  concurrency limits, separate budgets, cancellation, timeout, partial results, and progress
  evidence. Evidence: `agents/src/children/execution-kernel.ts` and
  `agents/test/child-execution-kernel.test.ts`.
- [x] Make child invocation a first-class capability with a pinned child version, attenuated grants,
  separate budgets, and a parent operation identity. Fresh child context/session execution is owned
  by the host executor contract, not copied into the parent prompt.
- [x] Activate the Temporal child workflow path from an agent turn. The parent waits durably through
  the workflow adapter without holding a worker; the production worker fails closed until its host
  child executor is configured.
- [x] Define typed child results, progress events, failure, cancellation, timeout, and partial-result
  behaviour. The complete child transcript is not copied into the parent prompt.
- [x] Bound depth, fan-out, total child budget, and tool permissions. A child cannot create an
  unrestricted swarm.
- [ ] Add parent/child replay and worker-loss tests, plus a customer-facing creation model for
  role-based teams later.

Hermes references: `tools/delegate_tool.py`, `delegate_tool_child_run.py`,
`delegate_tool_dispatch.py`, `async_delegation.py`, and `agent/subagent_lifecycle.py`.

### 7. Agent creation and configuration rewrite

- [ ] Rebuild agent creation around a small agent profile: purpose, instructions, model policy,
  context policy, extension packages, grants, channels, memory/knowledge policy, and limits.
- [ ] Keep graph configuration optional. A normal support, sales, or research agent should not
  require nodes and edges to be useful.
- [ ] Validate the complete profile before publication. Surface missing credentials, unavailable
  tools, incompatible extensions, unsafe permissions, and impossible budgets before a run exists.
- [ ] Publish an immutable agent version and extension snapshot. Draft changes never mutate a live
  version or running session.
- [ ] Make the creation flow produce a testable Playground candidate later, without coupling runtime
  correctness to the current UI implementation.

### 8. Execution visualization and Playground handoff

This work is intentionally later than the runtime kernel. The current UI work may proceed, but it
must consume the event contracts below rather than inventing its own execution state.

- [ ] Define event categories for session admission, context decisions, model calls, tool calls,
  MCP lifecycle, approvals, waits, child runs, delivery, retries, unknown effects, and terminal
  outcomes.
- [ ] Make every event cursor-replayable, tenant-scoped, redacted, and linked by parent operation
  ID.
- [ ] Build the Playground as a real execution environment with separate resources and credentials,
  not mocks. Promotion activates the exact tested candidate and extension digests.
- [ ] Add graph/timeline views, operation inspector, live reconnect, pause/cancel/retry controls,
  and evidence-backed promotion after the runtime work is complete.

## Verification gates

Each workstream is complete only when code, tests, and evidence exist.

- Context: provider-budget matrix, context-pressure tests, empty-response tests, and journal
  assertions.
- Sessions: concurrent same-session writers, reconnect, lease expiry, cancellation, queue limits,
  and worker-loss tests.
- Extensions: install/publish/revoke/pin tests, snapshot isolation, dependency failures, and
  customer-agent profile tests.
- MCP: live server, dead server, timeout, restart, schema limit, credential revocation, and
  orphan-process tests.
- Durability: operation matrix covering confirmed, failed, and unknown external outcomes.
- Multi-agent: parent/child worker-loss, scope attenuation, bounded budgets, cancellation, and
  partial result tests.
- Creation: invalid profile rejection, immutable publication, dry configuration validation, and
  run admission against the published snapshot.
- Visualization: cursor replay and redacted event projection tests before UI acceptance.

## Immediate implementation order

1. Finish the remaining runtime matrix: child host executor, bounded queues, MCP/provider restart
   cases, duplicate plugin execution, and clean PostgreSQL/Temporal failure injection.
2. Rework extension packages and agent creation around immutable profiles and snapshots.
3. Move remaining native model, Core-effect, approval, and channel delivery paths behind the
   operation coordinator.
4. Connect the execution journal to the Playground and promotion flow.

## Release record

| Field | Decision |
| --- | --- |
| Change | Hermes gap closure and Agent Platform runtime rework. |
| Owner | Agent Platform; Operations owns release and recovery evidence. |
| Risk | High. This is a runtime and data-contract rewrite. |
| Affected services and surfaces | Agents API, Temporal worker, PostgreSQL, Core adapters, MCP, skills/plugins, channels, customer agent creation, and later Playground. |
| Platform release version or ID | Not applicable during local implementation. |
| API/schema/migration changes | Added repeatable migrations `117_durable_operations.sql` and `118_agent_context_compaction_revisions.sql`; the session lease migration `116_agent_session_leases.sql` is part of the same local rewrite. API contracts remain runtime-first and the interface is deferred. |
| Feature flag or rollout | Local rewrite first. Production rollout requires an explicit cutover or fresh-environment decision. |
| Analytics | Runtime facts now include context compaction, MCP operation outcomes, child progress/outcomes, plugin evidence, session fencing, and durable-operation state. Queue-age and provider-level analytics remain open. |
| Logs, metrics, dashboards, and alerts | Structured evidence is present for the runtime paths; queue age, provider retries, unknown effects, MCP health, worker loss, and stuck-session dashboards remain required before rollout. |
| Documentation | Update architecture, agent creation, extension, MCP, runtime, and operator documentation per workstream. |
| Validation | Unit and full agent-suite validation pass locally. PostgreSQL migration, Temporal worker-loss, and provider failure-injection validation require the local infrastructure matrix and remain open. |
| Rollback | During local rewrite, reset the disposable database. A production cutover requires a tested artifact and explicit data/operation rollback decision. |
| Post-release review | Required after each high-risk workstream. |
