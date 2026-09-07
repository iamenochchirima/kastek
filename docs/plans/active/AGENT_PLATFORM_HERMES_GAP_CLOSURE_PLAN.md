---
id: agent-platform-hermes-gap-closure
title: Agent Platform Hermes gap closure and runtime rework
sidebar_label: Hermes gap closure
slug: /hermes-gap-closure
description: Implementation plan for reworking the Agent Platform around the mature Hermes runtime patterns that KasiTek still lacks.
---

# Agent Platform Hermes gap closure and runtime rework

**Status:** Active; runtime kernel foundations landed, durable integration in progress

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
- [ ] Extend the engine with durable compaction/pruning state and a provider-independent summary
  fallback; the current engine is deliberately in-memory and does not claim persistence.
- [x] Replace fixed `estimateTokens` decisions at the final model boundary with a provider-aware
  planner that reserves output capacity, bounds schemas/results, protects tool pairs, and reconciles
  provider-reported usage. Evidence: `agents/src/runtime/context-planning.ts`,
  `agents/src/runtime/loop.ts`, and `agents/test/context-planning-loop.test.ts`.
- [ ] Replace the remaining fixed `estimateTokens` decisions in context assembly with the same
  planner contract. It must account for system instructions, history, summaries, retrieved evidence,
  tool schemas, tool results, requested output, reasoning allowance, and safety margin.
- [ ] Make the planner return a typed decision: `ready`, `compact`, `prune`, `limited`, or
  `cannot_fit`, with exact accounting and omitted-content reasons.
- [x] Add deterministic tool-result limits before model dispatch. Full results remain durable only
  in the durable run evidence; the model receives a bounded projection. Evidence: context planner
  tests and the model-boundary integration test.
- [x] Add protected message-pair handling so assistant tool calls and tool results cannot be split
  by the new model-boundary planner. Evidence: `agents/test/context-planning.test.ts`.
- [ ] Add one compaction implementation with a deterministic fallback when the summary provider is
  unavailable. Compaction must never silently delete durable history.
- [ ] Add empty-response recovery, interrupted-stream recovery, retry budgets, and terminal typed
  outcomes so a provider cannot produce a hang or zero-response loop.
- [ ] Persist context decisions, token usage, compaction count, and limited reasons in the journal.
- [x] Add provider contract tests for exact-fit, oversized history, oversized tool schema, large
  tool output, and provider-usage reconciliation. Evidence: `agents/test/context-planning.test.ts`,
  `agents/test/context-overflow-recovery.test.ts`, and `agents/test/context-planning-loop.test.ts`.
- [ ] Add provider contract tests for overflow response, empty response, retry exhaustion, and
  interruption.

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
- [ ] Propagate the acquired fencing token through every session-owned write so a stale worker is
  rejected at the activity boundary, not only at lease acquisition.
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
- [ ] Reconcile the new package manifest with the persisted extension-package repository and the
  immutable agent-version snapshot; the runtime must consume one canonical package shape.
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
- [ ] Add one MCP adapter for discovery, schema caching, call execution, timeout, cancellation,
  reconnect, and structured error classification.
- [ ] Supervise stdio MCP processes and clean up orphaned children. A dead or hung server must
  produce a visible typed capability state, not an indefinite agent wait.
- [ ] Bound schemas and results before they enter the context engine.
- [ ] Persist MCP operation identity and provider uncertainty through the same operation coordinator
  used by native capabilities.
- [ ] Add credential revocation and server reload tests that prove active runs retain their snapshot
  while new runs see the change.

Hermes references: `tools/mcp_tool_lifecycle.py`, `mcp_tool_config.py`, `mcp_schema_cache.py`,
`mcp_tool_errors.py`, and `mcp_death_supervisor.py`.

### 5. Durable execution and external effects

- [ ] Make the operation coordinator the owner of model calls, native tools, MCP calls, approvals,
  channel sends, and Core effects. Callers should not write lifecycle rows directly.
- [ ] Add explicit operation states for proposed, running, completed, failed, interrupted, and
  unknown. Unknown means a provider may have performed an effect and requires reconciliation.
- [ ] Persist provider request identity, attempt number, response receipt, and retry decision before
  retrying an uncertain operation.
- [ ] Add bounded retry and timeout policies by operation class. No retry may repeat a confirmed
  external effect.
- [ ] Route every channel/provider send through the delivery obligation coordinator and reconcile
  unknown sends after restart.
- [ ] Add worker-loss tests at before-call, during-call, after-call-before-receipt, and after-receipt
  points for native, MCP, Core, and channel operations.

### 6. Multi-agent execution

- [ ] Make child invocation a first-class capability with a fresh session, fresh context engine,
  pinned child version, attenuated grants, separate budgets, and a parent operation identity.
- [ ] Activate the Temporal child workflow path from an agent turn. The parent must wait durably or
  continue asynchronously without holding a worker.
- [ ] Define typed child results, progress events, failure, cancellation, timeout, and partial-result
  behaviour. Never copy the complete child transcript into the parent prompt.
- [ ] Bound depth, fan-out, total child budget, and tool permissions. A child cannot create an
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

1. Build the context and token execution kernel. This is the current implementation slice.
2. Move session admission and flow control behind a durable session coordinator.
3. Rework extension packages and agent creation around immutable profiles and snapshots.
4. Make MCP and all external effects use the operation coordinator.
5. Activate bounded Temporal child workflows.
6. Connect the execution journal to the Playground and promotion flow.

## Release record

| Field | Decision |
| --- | --- |
| Change | Hermes gap closure and Agent Platform runtime rework. |
| Owner | Agent Platform; Operations owns release and recovery evidence. |
| Risk | High. This is a runtime and data-contract rewrite. |
| Affected services and surfaces | Agents API, Temporal worker, PostgreSQL, Core adapters, MCP, skills/plugins, channels, customer agent creation, and later Playground. |
| Platform release version or ID | Not applicable during local implementation. |
| API/schema/migration changes | Expected. Each workstream must add repeatable migrations and update API contracts before release. |
| Feature flag or rollout | Local rewrite first. Production rollout requires an explicit cutover or fresh-environment decision. |
| Analytics | Add lifecycle events for context pressure, limited outcomes, extension readiness, session queueing, MCP failures, child runs, and unknown effects. |
| Logs, metrics, dashboards, and alerts | Required for queue age, context limits, provider retries, unknown effects, MCP health, worker loss, and stuck sessions. |
| Documentation | Update architecture, agent creation, extension, MCP, runtime, and operator documentation per workstream. |
| Validation | Workstream-specific unit, integration, failure-injection, migration, and manual evidence. |
| Rollback | During local rewrite, reset the disposable database. A production cutover requires a tested artifact and explicit data/operation rollback decision. |
| Post-release review | Required after each high-risk workstream. |
