---
id: agent-context-runtime-and-telemetry
title: Context runtime and telemetry implementation
sidebar_label: Context runtime · implementation
slug: /context-runtime-and-telemetry
description: Dedicated implementation plan for durable, provider-aware context management and truthful runtime telemetry for every KasiTek agent.
---

# Context runtime and telemetry implementation

**Status:** Active; runtime implementation in progress

**Owner:** Agent Platform

**Last updated:** 2026-09-08

**Risk:** High

**Depends on:** [`Agent Platform Hermes-Aligned Runtime Reliability`](./AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md)

**Related Playground work:** [`Agent Playground and Execution Observatory`](./AGENT_PLATFORM_EXECUTION_OBSERVATORY_AND_CONTROL_PLANE_PLAN.md)

**Research record:** [`Hermes context and runtime telemetry research`](../agents/HERMES_CONTEXT_AND_RUNTIME_TELEMETRY_RESEARCH.md)

## Objective

Replace the current scattered context and token-limit handling with one durable, provider-aware
context runtime used by every agent: KasiAI, protected defaults, customer-created autonomous
agents, future guided agents, workflow agents, child agents, and every channel.

The outcome is not a prettier token counter. Before a model call, the runtime must know which
model capacity applies, what exact request it intends to send, whether that request fits, what it
can safely remove or compact, and when it must stop with a useful typed outcome. After a call, it
must distinguish provider-reported usage from an estimate, preserve that fact across retries and
worker replacement, and expose the same truth to the Playground.

Success means a long, tool-heavy, autonomous conversation compacts before an avoidable provider
overflow; a genuine non-fitting request ends in an explainable state rather than an execution-limit
loop; and the Playground can show real context occupancy, utilization, latency, and turn duration
without fabricating values in the browser.

## Scope

### Included

- model-capability resolution and provenance for every model attempt and fallback;
- one immutable model-request manifest and final pre-dispatch fit gate;
- separate accounting for current context occupancy, output reservation, run limits, and cumulative
  usage;
- durable context pressure, pruning, compaction, overflow recovery, attempt limits, and fences;
- provider-usage anchoring and explicit measurement basis;
- durable model-attempt and turn timing telemetry;
- narrow memory checkpoint/retrieval ports that preserve memory ownership while allowing the
  context runtime to checkpoint evidence before loss and account retrieved evidence in the final
  request;
- a tenant-safe backend telemetry projection and the minimum real Playground presentation needed
  to prove it end to end;
- conformance, Temporal/PostgreSQL failure, provider, and manual Playground verification;
- migration, structured observability, documentation, release, rollback, and local-stack evidence.

### Excluded

- a new agent-creation UX, specialist-agent team UX, or workflow authoring surface;
- visual styling beyond the focused telemetry surface needed to validate this runtime;
- copying Hermes code, adding Hermes as a dependency, or using Hermes process-local state as a
  production source of truth;
- treating browser-derived counts, cumulative session tokens, or mock runs as context occupancy.

## Non-negotiable runtime model

```text
Durable transcript and artifacts       never destroyed for compaction
            |
            v
Context runtime                    owns selection, accounting, and recovery
            |
            v
Immutable model-request manifest   exact content intended for this attempt
            |
            v
Pre-dispatch fit gate              ready | compact | prune | limited | cannot_fit
            |
            v
Provider attempt                   captures actual usage and timing when available
            |
            v
Durable events and projection      source for Playground and operations
```

The model-facing request is a bounded projection, not the conversation. Compaction may change
that projection, but it must not delete durable transcript, tool evidence, approval state, or
child-run evidence. A channel, host, graph, plugin, or UI must not rebuild token policy itself.

### Counters that must never be conflated

| Counter | Meaning | It must not be used as |
| --- | --- | --- |
| Current occupancy | Input tokens in the request that will be sent, or a labelled durable estimate | Cumulative run/session usage |
| Context window | Capacity for the selected provider/model/route | A fixed global application setting |
| Output reservation | Capacity held back for the next completion | Current input occupancy |
| Safety margin | Provider/serialization headroom | A hidden output reservation |
| Run/token budget | Policy limit for total work | Provider request-fit capacity |
| Payload-byte pressure | Serialized request size, especially media | Token pressure |

### Measurement basis

Every context number shown or used for policy carries one of these values:

```ts
type MeasurementBasis =
  | "provider_reported"
  | "anchored_estimate"
  | "full_estimate"
  | "unknown_after_compaction";
```

`provider_reported` is authoritative when the provider supplies prompt usage. An
`anchored_estimate` may add a bounded delta to a valid durable provider anchor.
`full_estimate` is an overhead-aware calculation from the exact request manifest.
`unknown_after_compaction` is deliberate: a compaction changed the request boundary and no later
provider response has re-anchored occupancy. Unknown must render as unknown, never zero.

## Hermes reference discipline

The reference repository is `/home/enoch/aworkspace/agents/hermes-agent` at revision
`9a84bee265daad14340a80d7585928cd8ea1f9eb`, reviewed 2026-09-07. We adapt contracts and failure
behaviour to KasiTek's Temporal, PostgreSQL, RLS, fencing, provider adapters, and channel model.
We do not transplant code or assume Hermes's in-process object identity is durable.

The decision record below uses the behavior and recommendations documented in
[`HERMES_CONTEXT_AND_RUNTIME_TELEMETRY_RESEARCH.md`](../agents/HERMES_CONTEXT_AND_RUNTIME_TELEMETRY_RESEARCH.md).
Each source row has an explicit decision. `Adopt` means the runtime should preserve the behavior.
`Adapt` means the behavior belongs in KasiTek but must use durable, provider-aware contracts.
`Reject` means the Hermes implementation detail or assumption must not enter the runtime.

| Workstream | Hermes source to study before implementation | Adopt | Adapt in KasiTek | Reject |
| --- | --- | --- | --- | --- |
| Lifecycle ownership | `agent/context_engine.py:34-242` | Keep one lifecycle covering turn admission, context planning, compaction, model dispatch, and usage reconciliation. | Key state by durable run, turn, request-manifest, attempt, and compaction identifiers. Let Temporal activities and PostgreSQL records survive worker replacement and replay. | Process-local engine or session object identity as the source of truth. UI state must not own lifecycle transitions. |
| Model capacity | `agent/model_metadata.py:1053-1086,1844-1939,1955-2181` | Resolve capacity with ordered sources, keep context and output limits separate, and accept only explicit provider error corrections. | Scope the resolver by provider, endpoint, credential route, model, and runtime environment. Persist source, confidence, observation time, expiry, and correction evidence. | Treat a hardcoded family default or generic `max_tokens` field as an authoritative context window. Do not turn an unverified fallback into a precise capacity. |
| Exact request assembly | `agent/turn_context.py:917-1003`; `agent/turn_request_assembly.py:227-264`; `agent/model_metadata.py:1959-2133` | Assemble the provider request after dynamic content is known, count tools and schemas, and run a final pre-dispatch fit check. Keep durable conversation and provider wire content distinct. | Persist a redacted, content-free manifest, digest, source boundary, component token/byte accounting, and provider-envelope measurement. Retrieve memory evidence before finalization without moving prompt policy into memory. | Copy raw `api_content`, secrets, or private prompt content into telemetry. Do not use a process-local prompt cache as the durable request record. |
| Pressure and compaction | `agent/turn_context_compaction.py:224-417`; `agent/turn_preflight_gate.py:60-99`; `agent/context_compressor.py:2192-2253,4183-4666` | Use usable input budget, soft and hard pressure gates, protected message/tool groups, repeated preflight checks, and a bounded attempt budget. Judge effectiveness from the next provider request, not estimated message reduction alone. | Run one fenced compaction path through Temporal and the context runtime. Persist candidates, source boundaries, structural validation, memory checkpoints, and typed defer/failure outcomes. Keep token pressure and payload-byte pressure separate. | Copy Hermes's fixed thresholds, tail percentages, summary limits, or process-local retry counters as universal policy. Do not create a second compaction engine. |
| Compression durability | `agent/conversation_compression.py:676-890,1184-1215,1305-1360` | Separate compaction work, timeout, cancellation, retry, commit, cooldown, and telemetry states. Require a commit fence before publishing a candidate. | Use Temporal cancellation and retry semantics with PostgreSQL compare-and-swap and session fencing. Emit the result through the shared execution journal and checkpoint memory before lossy rewrites. | Durable truth in in-memory locks, files, or compression-session rotation. A late worker must not win, and a failed checkpoint must never delete the transcript. |
| Overflow recovery | `agent/turn_overflow.py:218-416` | Distinguish context overflow, output-cap errors, and serialized payload-byte 413 errors. Use only provider-stated limits and a bounded recovery ladder. | Route every recovery attempt back through capability resolution, exact request planning, byte measurement, and durable attempt accounting. Preserve the original failure class and recovery reason. | Infer a smaller context window from a generic error, retry without a durable bound, or collapse all provider failures into a generic token-budget error. |
| Usage anchors | `agent/turn_usage.py:65-183`; `agent/model_metadata.py:2136-2181` | Prefer provider prompt usage, use bounded anchored deltas only when the boundary remains valid, and expose an explicit unknown state after compaction. Keep current occupancy separate from cumulative usage. | Anchor to durable event IDs, manifest hashes, request identity, and source boundaries. Invalidate anchors on compaction or splice and rebuild the backend snapshot from journal events. | Use Python `id()`-style object identity, process-local session counters, or cumulative billing tokens as current context occupancy. Do not reduce measurement provenance to a boolean `estimated` flag. |
| Attempt timing | `agent/conversation_loop.py:1358-1493`; `agent/turn_response_check.py:111-121` | Record every logical provider attempt, including queue, start, first token, completion, failure, and duration. Keep retry attempts visible. | Persist timing events by run, turn, and attempt. Report approval waits, external waits, queue delay, provider latency, and turn duration as separate measurements. | Use browser timers or a process-local rolling deque as the only timing source. Do not label whole-turn duration as provider latency. |
| Status projection | `hermes_cli/cli_status_bar_mixin.py:135-213,271-357,946-1053`; `tui_gateway/server.py:1891-1942` | Show model, current context occupancy/window, utilization, latest or rolling model latency, and live turn duration. Omit unavailable values instead of fabricating zero. | Build a backend-owned `RuntimeTelemetrySnapshot` from durable journal events. Expose measurement basis, manifest/attempt identity, compaction state, and threshold details in the Playground detail view. | Let CLI or browser code calculate safety values, or substitute cumulative lifetime tokens for current occupancy. Hermes's TUI layout and process-local status state are not runtime contracts. |

## Target contract

The exact names can change during implementation, but this separation may not:

```ts
interface ModelCapability {
  provider: string;
  endpointId: string;
  modelId: string;
  contextWindowTokens?: number;
  maxOutputTokens?: number;
  source: "provider_metadata" | "catalog" | "configured_override" | "provider_error_correction" | "unknown";
  resolvedAt: string;
  expiresAt?: string;
}

interface RuntimeTelemetrySnapshot {
  runId: string;
  turnId: string;
  attemptId?: string;
  observedAt: string;
  context: {
    tokens?: number;
    basis: MeasurementBasis;
    contextWindowTokens?: number;
    utilizationPercent?: number;
    reservedOutputTokens: number;
    safetyMarginTokens: number;
    softThresholdTokens?: number;
    hardLimitTokens?: number;
    compactionCount: number;
  };
  modelAttempt?: {
    status: "queued" | "running" | "streaming" | "completed" | "failed";
    model: string;
    queuedAt?: string;
    startedAt?: string;
    firstTokenAt?: string;
    completedAt?: string;
    latencyMs?: number;
    outputTokens?: number;
    throughputTokensPerSecond?: number;
  };
  turn: { status: string; admittedAt: string; elapsedMs: number; finishedAt?: string };
}
```

The snapshot is a read model. The authoritative evidence remains redacted, ordered durable events:
`model_capability_resolved`, `model_request_assembled`, `context_pressure_measured`,
`compaction_started`, `compaction_candidate_created`, `compaction_committed`,
`compaction_deferred`, `model_attempt_started`, `model_first_token_received`,
`model_attempt_completed`, `provider_usage_recorded`, and `turn_completed`.

## Memory integration boundary

Memory is a cooperating evidence service, not a second context runtime. The context runtime keeps
ownership of model-capability resolution, request-manifest construction, token/byte accounting,
fit decisions, pruning, compaction, overflow recovery, fencing, retries, and context/attempt
telemetry. The memory implementation owns evidence persistence, semantic revisions, consolidation,
retrieval ranking, retention, deletion, and lifecycle projections.

The only integration ports are defined in
`agents/src/runtime/context-memory-boundary.ts`:

- `MemoryCheckpointPort.checkpoint(request)` is called immediately before a lossy compaction
  projection. Its request carries `runId`, `turnId`, `compactionGeneration`, a source-event
  boundary, explicit memory scope, an evidence digest, and a redacted direct-evidence envelope.
  The result is `committed` or idempotent `replayed`. When enforcement is enabled, a missing,
  failed, or scope-less checkpoint produces typed `memory_checkpoint_blocked` and compaction does
  not proceed. Durable transcript and tool/effect evidence are never deleted by this path.
- `MemoryRetrievalPort.retrieve(request)` is called after the dynamic turn content is known and
  before the context planner finalizes its immutable request manifest. It returns stable evidence
  IDs, scope, source-event provenance, validity, lifecycle state, retrieval reason/score,
  redacted content, and optional measurement metadata. The context planner then accounts for that
  evidence exactly like any other request component; the memory port never assembles prompts.
  Injected evidence is excluded from the next source-boundary digest, so a model-facing memory
  envelope cannot cause self-retrieval or appear as a new durable source event.
- `MemoryRuntimeEventPayload` reserves the shared journal event types
  `memory_checkpoint_requested`, `memory_checkpoint_committed`,
  `memory_checkpoint_blocked`, `memory_checkpoint_failed`,
  `memory_retrieval_requested`, `memory_retrieval_completed`, and
  `memory_retrieval_blocked`. They use the same run, turn, attempt, compaction-generation,
  source-boundary, and manifest identifiers as the context events. There is no memory-specific
  event stream or telemetry projection.

The no-op/fake adapters and contract tests in
`agents/test/context-memory-boundary.test.ts` are the parallel-test boundary while the memory
repositories and workers are being replaced. Real memory integration may begin only when its
adapter can prove scoped/idempotent checkpoint commit, evidence-pack provenance and redaction,
authorization failure behaviour, and shared-journal replay. At that handoff, the memory worker
must supply the ports and tests; it must not move context policy or prompt assembly into memory.

### Memory handoff checklist

- [x] Context runtime owns capability resolution, request manifests, token/byte accounting, fit,
  pruning/compaction, overflow recovery, fences/retries, and context/model-attempt telemetry.
- [x] `MemoryCheckpointPort` is invoked before a lossy projection and carries the required run,
  turn, generation, source-boundary, scope, evidence-digest, and redacted-evidence fields.
- [x] Checkpoint failure is idempotent and typed; enforced compaction blocks without deleting the
  durable transcript or attempting a context projection commit.
- [x] `MemoryRetrievalPort` is invoked after dynamic content is available and before final request
  assembly; returned evidence is redacted, provenance-bearing, and counted by the context planner.
- [x] Injected memory evidence cannot advance its own durable source boundary or trigger
  self-retrieval on a later tool round.
- [x] Memory coordination facts use the existing execution journal envelope and shared durable
  identifiers; no memory transcript or telemetry projection is introduced.
- [x] No-op/fake adapters and contract tests keep context-runtime verification independent of the
  unfinished memory repositories and workers.
- [ ] Real memory adapter handoff: prove tenant/scope authorization, idempotent checkpoint replay,
  evidence-pack provenance/lifecycle/redaction, blocked retrieval semantics, and journal replay in
  the memory implementation's own integration tests before enabling it as the production port.
  The adapter must persist the runtime-provided evidence digest, source boundary, compaction
  generation, and lifecycle identifiers; it must not recompute them at the memory seam.

Current handoff note: the parallel `agents/src/memory/runtime-adapter.ts` still derives its
canonical evidence digest from converted items instead of forwarding the runtime-provided digest.
That remains a memory-owner change and is intentionally not changed by the context-runtime work.

## Implementation checklist

An item is complete only with implementation, focused automated coverage, and an evidence link in
the log at the end of this document. Checkmarks are not forecasts.

### Current implementation progress

The kernel pass is in progress. The working tree now has typed capability provenance, actionable
planner decisions, content-free request/source manifests with component token/byte accounting and
output reservation metadata, truthful provider-usage availability, route-isolated durable
capability records, bounded overflow and payload-error outcomes, attempt-scoped usage anchors,
fenced compaction generations, durable attempt timing, optional first-token events, a
journal-rebuilt backend telemetry projection, durable manifest and attempt-budget records, and
memory coordination ports.
The runtime now also has Hermes-adapted wire-only pruning and a durable Playground telemetry
surface: exact context values remain backend-owned, while the browser displays the persisted
measurement basis and revision. The existing KasiAI catalog is now lazily connected to the
durable capability resolver for route-safe entries that include explicit context metadata. Direct
provider metadata now has a credential-safe, exact-route adapter with fail-closed parsing and
tenant-scoped durable persistence; provider APIs that expose only model IDs still resolve as
unknown. Attempt telemetry also preserves queue delay and prompt/prefill time-to-first-token.
The legacy fixed-token compactor has now been removed from `message-context.ts`; that helper only
repairs transcript structure, while `context-planning.ts` remains the sole owner of history
selection, pruning, compaction, and final fit decisions.
Temporal's durable compaction artifact is also no longer used as an independent fixed-count
model-input projection: the activity keeps the complete durable transcript available to the shared
provider-aware planner, while the durable compaction path remains responsible for fenced artifacts
and the pre-loss memory checkpoint. The compatibility `harness.buildContext` projection is
diagnostic-only; it cannot terminate a run before the provider-aware capability and manifest gate.
Output reservation is resolved with the same bounded value used
by the dispatched request, so the manifest and provider envelope cannot report different output
budgets. Durable run-budget reservation now receives the planner's exact input estimate and output
reservation instead of independently re-estimating the model request; the legacy estimator remains
only as a compatibility fallback for non-harness callers.
This is not yet the complete runtime rewrite: PostgreSQL/Temporal replay certification, real
memory adapter handoff, and real Playground certification remain open.

### 0. Baseline and contracts

- [x] Inventory every current context, token, limit, compaction, provider-usage, and telemetry
  decision in `agents/src/runtime/`, `agents/src/temporal/activities.ts`, model adapters, and
  journal/projection paths. The source matrix below records the replacement owner and the
  removal/adaptation path for each Hermes-derived concern.
- [x] Define the typed planner outputs used at the context-runtime seam: actionable decision,
  capability provenance, measurement basis, and a content-free request manifest. Evidence:
  `agents/src/runtime/context-planning.ts`, `agents/src/runtime/context-capability.ts`, and
  `agents/test/context-capability.test.ts`.
- [x] Define one context-runtime public boundary; `AgentHarness.runTurn` routes autonomous,
  fallback, continuation, graph, and child model dispatch through `runBoundedAgentLoop`, whose
  final gate is `planProviderRequest`. `harness.buildContext` is the shared preflight projection;
  it does not dispatch or maintain a second compaction policy.
- [x] Define durable IDs for turn, request manifest, model attempt, compaction generation, source
  event boundary, and provider request identity. `ContextRequestManifest.identity`, operation keys,
  compaction generations, source digests, and session fencing carry these values without content.
- [x] Define typed terminal and waiting outcomes: `ready`, `compact`, `prune`, `limited`,
  `cannot_fit`, `provider_overflow_recovering`, `provider_overflow_terminal`, `compaction_deferred`,
  and `compaction_failed`. Evidence: planner decisions, loop recovery events, and compaction errors.
- [x] Define redaction limits for manifests, events, logs, and telemetry. No credentials, full
  prompts, private tool output, or customer content appears in status or general logs. Evidence:
  content-free manifest/accounting assertions, redacted memory boundary envelopes, and the
  journal projection tests.
- [x] Define the memory ownership boundary, checkpoint/retrieval ports, shared event names, and
  fake-adapter handoff contract. Evidence: `agents/src/runtime/context-memory-boundary.ts`,
  `agents/src/journal/contracts.ts`, `agents/src/runtime/context-engine.ts`, and
  `agents/test/context-memory-boundary.test.ts` plus the public-engine forwarding test.
- [x] Record explicit adopt/adapt/reject decisions for every Hermes source row above. The existing
  research record already documents the rejected process-local identity, hardcoded-capacity,
  raw-prompt, and cumulative-usage behaviors, so no separate research correction was required.
  Evidence: the decision matrix in this section and
  `docs/plans/agents/HERMES_CONTEXT_AND_RUNTIME_TELEMETRY_RESEARCH.md`.

**Manual check:** inspect a single admitted run and identify one owner for its context decision;
there must be no second caller inventing a different token limit.

### 1. Model-capability resolution

- [x] Add the first attempt-scoped resolver that rekeys provider/model fallbacks and records an
  explicit configured-capability source. Evidence: `agents/src/runtime/context-capability.ts` and
  `agents/test/context-capability.test.ts`.
- [x] Add a durable resolver/cache keyed by provider, endpoint/credential route, model, and runtime
  environment. The route-isolated store, cache, migration, resolver, lazy KasiAI catalog adapter,
  and credential-safe direct-provider metadata adapter exist. PostgreSQL expiry/restart and fresh-
  resolver reload are certified by `context-runtime-postgres.integration.test.ts` (2 tests passed).
- [x] Resolve capacity in ordered sources: explicit safe override, provider metadata, static catalog,
  cached confirmed capability, then `unknown`; retain source and expiry with the result. Evidence:
  `DurableContextCapabilityResolver`, `model-capability-catalog.ts`, and source-precedence tests.
- [x] Resolve again on model fallback or route change. A fallback must never inherit the old model's
  context window without evidence. Evidence: `agents/src/runtime/loop.ts` resolves every attempt;
  `agents/test/context-planning-loop.test.ts` covers the model-boundary events.
- [x] Accept provider error corrections only when the error gives an unambiguous capacity or output
  constraint; record correction provenance and invalidate the relevant cache safely. Evidence:
  `context-capability.ts`, `loop.ts`, and `context-capability.test.ts`.
- [x] Make absent capacity fail closed for autonomous calls that cannot establish a safe request-fit
  boundary. Do not label a guessed value authoritative. Evidence: `requireContextCapability`, the
  `CONTEXT_CAPABILITY_UNKNOWN` outcome, and `context-planning-loop.test.ts`.
- [x] Add provider/route/model-switch and cache-expiry tests. Route/model isolation, expired-cache
  refresh, cold-resolver durable correction loading, and PostgreSQL-backed expiry/reload are covered
  in `agents/test/context-capability.test.ts` and `agents/test/context-runtime-postgres.integration.test.ts`.

**Manual check:** switch a test agent between two models with different windows and confirm the
recorded capability, threshold, and gate change before its next call.

### 2. Immutable request assembly and accounting

- [x] Build one exact request manifest after all dynamic content is known: system instructions,
  current task, selected history, summaries, memory/retrieval, tools/schemas, bounded tool results,
  plugin/MCP output, and requested output capacity.
- [x] Persist a bounded redacted manifest, component token/byte accounting, omitted-content reasons,
  structural hashes, and source event boundaries before dispatch. `ContextManifestRepository` is
  idempotent, tenant-scoped, bounded, and content-free; the harness callback refuses dispatch if
  persistence fails. Evidence: migration 145, repository contract tests, and loop boundary tests.
- [x] Keep memory evidence outside the prompt assembler while allowing the runtime to inject its
  redacted evidence pack before manifest finalization. Evidence: `MemoryRetrievalPort`, loop
  retrieval seam, and `context-memory-boundary.test.ts`.
- [x] Account for provider wrapper/serialization overhead through the provider adapter contract.
  Evidence: `ModelAdapter.estimateRequestBytes`, `ModelGateway.estimateRequestBytes`, provider
  adapter envelope measurements, planner byte-gate coverage, and `context-planning.test.ts`.
- [x] Enforce structural invariants: system instructions, active user task, unresolved approvals,
  assistant tool-call/result pairs, active child contracts, and recent tail cannot be silently
  split or dropped. Context planning protects system/current units and tool pairs; transcript repair
  removes orphan results; durable approvals/child contracts remain outside the model projection.
- [x] Remove the legacy fixed-token compactor from the transcript helper. `message-context.ts` now
  performs structural tool-pair repair only; all history selection, wire pruning, lossy compaction,
  token accounting, and fit decisions flow through the provider-aware context planner. Evidence:
  `agents/src/runtime/message-context.ts`, `agents/src/runtime/context-planning.ts`,
  `agents/test/message-context.test.ts`, and the full agents suite.
- [x] Keep durable compaction artifacts separate from model-facing request selection. Temporal retains
  the full durable transcript for `harness.buildContext`; `BuiltAgentContext.sourceMessages` carries
  that complete normalized source into the autonomous, workflow-node, and resume loops; the
  provider-aware planner selects the request projection, while `compactDurableContext` remains the
  fenced persistence/checkpoint path. Evidence: `agents/src/runtime/context.ts`,
  `agents/src/temporal/activities.ts`, `agents/test/context.test.ts`, and the context planner/loop tests.
  The activity does not return on the compatibility preflight's limited status; only the final loop
  planner can produce the authoritative fit outcome.
- [x] Resolve the final output reservation once for both the request manifest and provider dispatch.
  When the durable run budget clamps output, the loop re-plans against the reduced reservation and
  dispatches `manifest.accounting.categories.output_reservation`; evidence:
  `agents/src/runtime/loop.ts` and the output-clamp regression in
  `agents/test/context-planning-loop.test.ts`.
- [x] Forward the planner's authoritative input estimate, output reservation, and manifest identity
  into durable run-budget admission. The run-budget layer no longer needs to make an independent
  model-facing fit decision; its compatibility estimator is used only when an older non-harness
  caller omits the fields. Evidence: `agents/src/runtime/loop.ts`, the Temporal activity adapters,
  `agents/test/runtime.test.ts`, and commits `dac02f45` and `f7672b59`. A concurrent durable
  reservation rejection is translated into the typed `CONTEXT_RUN_BUDGET_EXCEEDED` limited outcome
  instead of leaking `MODEL_TOKEN_BUDGET_EXCEEDED`.
- [x] Compute hard fit from `input + reserved output + safety margin <= context window`; keep run
  budgets and cumulative billing separate.
- [x] Make payload-byte pressure independently actionable for media/request-size limits. Evidence:
  `maxRequestBytes`, `request_payload_exceeds_byte_budget`, `CONTEXT_PAYLOAD_TOO_LARGE`, and the
  planner byte-pressure test.
- [x] Route every agent model call—including loop continuations, fallback calls, child calls, and
  graph model nodes—through the final pre-dispatch gate. The only direct provider calls left are
  explicitly non-agent support/evaluation utilities and are outside the autonomous harness contract.

**Manual check:** submit a request with large retrieval, tool schema, and tool output; inspect the
manifest to see each component and the one gate decision that allowed or blocked dispatch.

### 3. Context pressure and compaction lifecycle

- [x] Define soft maintenance and hard dispatch thresholds from usable input capacity:
  `window - reserved output - safety margin`, with policy version recorded on the decision.
- [x] Run pressure checks at turn admission, after tool/MCP/plugin results, immediately before every
  provider request, after fallback selection, and after a provider overflow. Each final plan emits
  policy version, pressure, reservation, and hard/soft thresholds.
- [x] Prune safely first: old oversized tool results, stale media/reasoning replay, blank echoes,
  and replaceable artifacts become bounded wire-only references with short digests. The durable
  transcript and source manifest are not mutated. Evidence: `pruneWireHistory` and
  `limitToolResults` in `agents/src/runtime/context-planning.ts`, with duplicate-result,
  oversized-result, blank-echo, and stale-replay tests in `agents/test/context-planning.test.ts`.
- [x] Build compaction candidates that preserve the protected head, active task, structural pairs,
  unresolved approvals, selected specialist contracts, and a token-bounded recent tail; compact the
  eligible middle only.
- [x] Store summaries as versioned context artifacts with exact source boundaries, validation result,
  and original evidence retained outside the projection.
- [x] Require the optional memory checkpoint handoff before a lossy rewrite; enforcement blocks
  compaction with a typed outcome and never deletes the transcript. Evidence:
  `compactDurableContext`, `MemoryCheckpointPort`, and checkpoint failure coverage.
- [x] Validate every candidate before commit. Reject candidates that break structure, lose the active
  task, grow the request, or do not make material progress. Evidence: structural pair validation,
  bounded summary validation, cancellation/fence rejection, and no-progress tests in
  `context-compaction.test.ts`.
- [x] Use one durable attempt budget across proactive compaction, provider-overflow recovery, retries,
  and worker replacement. Reservations are idempotent and never released; exhausted work returns a
  typed terminal outcome. Evidence: `context-attempt-budget.ts`, migration 146,
  `ContextAttemptBudgetRepository`, loop/compaction wiring, and port/repository tests.
- [x] Return a typed limited/cannot-fit outcome with redacted diagnostics when no safe request can
  be produced. Never burn the generic execution limit on repeated context failures. Temporal
  preserves context-specific errors, the run repository persists the safe `userMessage`, and Studio
  prefers that remediation over the internal error message. Evidence: `loop.ts`, `workflows.ts`,
  `run-repository.ts`, `context-planning-loop.test.ts` (including the durable run-budget admission
  path), and the agents build.

**Manual check:** run a long tool-heavy conversation until compaction occurs, then confirm the active
task and tool pairing survive and the next provider call fits without a provider overflow.

### 4. Durable compaction, recovery, and fencing

- [x] Make each compaction a fenced durable operation with generation, idempotency key, source
  boundary, timeout, cancellation, and compare-and-swap commit conditions.
- Evidence: `agents/src/runtime/context-compaction.ts`,
  `agents/src/db/repositories/context-compaction-repository.ts`, migration 118's immutable
  revision table, and the generation/fence tests in `agents/test/context-compaction.test.ts`.
- [x] Preserve the same projection on Temporal replay when inputs and generation match; retries may
  not create a differently compacted request silently. Operation replay, source/fingerprint
  conflict, cancellation, generation fencing, and the worker-loss-after-durable-commit fault
  window are covered by unit and PostgreSQL tests. The durable revision now stores a content-free
  projection digest, and unit replay plus the opt-in Temporal fixture assert that the returned
  replay projection matches the persisted digest. The fixture covers worker loss before and after
  durable persistence; local Temporal execution passed for both stages on 2026-09-08.
- [x] Reject late worker, stale session owner, timed-out summarizer, and cancelled activity commits.
  Evidence: live fence check before checkpoint/commit, abort checks, bounded summary timeout, and
  focused compaction tests.
- [x] Use a bounded primary/fallback summarizer policy; deterministic fallback must be clearly
  marked and cannot invent facts.
- [x] Classify provider context overflow, output-cap rejection, generic overflow, and HTTP 413
  separately. Only evidence-backed errors may change a model's remembered capability. Evidence:
  bounded recovery and `PROVIDER_PAYLOAD_TOO_LARGE` coverage in `loop.ts` and
  `context-overflow-recovery.test.ts`.
- [x] Re-measure after compaction. Provider-reported usage confirms success when available; otherwise
  retain `unknown_after_compaction` until a later response anchors the result.
- [x] Emit content-free operation telemetry for attempted, deferred, committed, ineffective,
  cancelled, timed-out, and terminal compaction states. `ContextCompactionRuntimeEvent` is emitted
  through the existing `harness.turn` journal envelope (and is available through `ContextEngine`),
  projected as `latestCompaction`, and cannot change the durable decision if its sink fails.

**Manual check:** kill or interrupt a compaction worker, let the lease move to another worker, and
prove the late completion cannot overwrite the winning generation.

### 5. Provider usage anchors and model-attempt telemetry

- [x] Capture normalized provider input/output/total usage, provider request identity, and cost only
  from the adapter response; do not replace absent usage with zero. Cache fields remain a follow-up
  adapter contract item. Evidence: `agents/src/model/{types,anthropic,gemini,openai-compatible,gateway}.ts`
  and `agents/test/model-adapters.test.ts`.
- [x] Anchor provider-reported input usage to durable manifest/source-boundary hashes. Add only the
  bounded delta when the anchor validates; otherwise perform a full estimate. Evidence:
  `agents/src/runtime/context-usage-anchor.ts`, `agents/src/runtime/loop.ts`, and
  `agents/test/context-usage-anchor.test.ts`.
- [x] Invalidate anchors after compaction, history splice, model/route change, or an incompatible
  tool/message structure change. Evidence: anchor boundary validation and stale-generation tests.
- [x] Persist model attempt queue, start, first-token (when streaming exposes it), completion,
  terminal status, error class, retry/fallback relation, latency, and output throughput inputs.
  Evidence: `loop.ts`, `journal/contracts.ts`, `runtime-telemetry.ts`, and the streaming/failed-
  attempt tests.
- [x] Define initial latency as provider-attempt duration and throughput as summed output tokens /
  summed completed attempt duration over a bounded rolling window. Do not claim decoder-only speed.
- [x] Persist turn `admittedAt`, `startedAt`, waits, and `finishedAt`; total turn duration includes
  tool/retry/compaction work while model latency remains separately visible. Evidence:
  `agents/src/runtime/runtime-telemetry.ts`, `agents/src/runtime/loop.ts`, and the turn-clock
  regression test in `agents/test/runtime-telemetry.test.ts`.
- [x] Ensure model-attempt retries are visible without double-counting replayed successful usage.
  Evidence: operation-keyed attempt history and completion-sample deduplication in
  `runtime-telemetry.ts`, with replay coverage in `runtime-telemetry.test.ts`; external effect
  deduplication remains owned by the durable tool/effect contracts.

**Manual check:** use a provider that omits usage, then one that reports it. The first run must show
an estimate; the second must show provider-reported usage and a durable anchor.

### 6. Durable read model and Playground telemetry

- [x] Project the canonical `RuntimeTelemetrySnapshot` only from durable evidence and server time;
  the browser may repaint elapsed time but must not calculate token safety values.
- [x] Make the projection tenant-scoped, installation-scoped, cursor-replayable, redacted, and safe
  for reconnect. It must not read private runtime tables without authorization.
- [x] Expose the initial operational values: model, `context tokens/window`, utilization, basis,
  latest/rolling provider latency, and live/last turn duration.
- [x] Provide a compact status row and an on-demand detail panel for threshold, reservation, safety
  margin, capability source, manifest components, latest compaction, attempt history, and reasons.
  Evidence: `RuntimeStatusRow` and `RuntimeTelemetryDetail` in
  `client/apps/client/src/components/dashboard/studio/studio-page.tsx`; the Playground polls the
  same durable timeline while a run is active. The detail panel also separates current context
  occupancy from cumulative provider usage and the configured run-token budget.
- [x] Render unavailable or post-compaction values as unknown. Do not substitute cumulative tokens,
  empty values, or mock values. Evidence: the backend projection preserves
  `unknown_after_compaction`; the client renders missing measurements as `—` and displays the
  measurement basis.
- [x] Link graph nodes to the same event IDs and snapshot revision so a user can inspect why a
  compaction or model attempt occurred. Evidence: `AgentJournalEvent`, `getAgentRunTimeline`,
  `RuntimeTelemetrySnapshot.revision`, and the Studio node inspector.
- [x] Verify desktop, tablet, and mobile layouts without hiding important failure state. Evidence:
  the Studio split uses responsive stacking at `xl`, the graph keeps horizontal overflow for dense
  traces, the status detail grid wraps at `sm`, and the client production build and targeted lint
  pass.

**Manual check:** open a real Playground run, reconnect midway, and verify the displayed model,
context basis, current occupancy, latency, and elapsed turn time agree with the durable events.

### 7. Conformance, failure matrix, and end-to-end certification

- [x] Unit-test capability resolution, source precedence, unknown capacity, and error correction.
- [x] Unit-test manifest accounting, pair protection, exact fit, oversized schema/result, output
reservation, safety margin, and byte-pressure classification.
- [x] Unit-test anchor validity, stale-boundary invalidation, estimate basis transitions, and no
double-counting under retries.
- [x] Unit-test compaction candidate selection, structural validation, no-progress protection,
deterministic fallback, and typed terminal outcomes.
- [x] Run PostgreSQL/Temporal tests for replay, worker loss at every compaction stage, fencing,
  duplicate operation identity, cancellation, timeout, late completion, and recovery after restart.
  PostgreSQL replay/expiry/fencing passed locally; the opt-in Temporal matrix is implemented in
  `agents/test/temporal-context-compaction.integration.test.ts`. With the rest of the local stack
  already running, start only that dependency with `./scripts/run_local_stack.sh restart temporal`,
  load `agents/.env`, then execute:
  `RUN_TEMPORAL_INTEGRATION_TESTS=true TEMPORAL_TEST_ADDRESS=127.0.0.1:7233 RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm --dir agents exec vitest run test/temporal-context-compaction.integration.test.ts`.
  The local run passed 2/2 tests on 2026-09-08: worker loss before persistence and after durable
  persistence. Unit/PostgreSQL coverage supplies fencing, duplicate identity, cancellation,
  timeout, late completion, and replay-after-commit assertions.
- [x] Run provider contract tests for usage-present, usage-absent, streaming first token, context
  overflow, output-cap rejection, generic overflow, and HTTP 413/media pressure. Evidence:
  `agents/test/model-adapters.test.ts` and `agents/test/context-overflow-recovery.test.ts` — 20
  tests passed.
- [ ] Run a real local Playground proof: autonomous KasiAI and one custom agent each complete a
long real execution using the same production harness and environment-scoped resources.
- [ ] Manually verify that an unfit request presents a typed cause and remediation path instead of
`MODEL_TOKEN_BUDGET_EXCEEDED` or a generic execution-limit message.
- [ ] Capture screenshots/event IDs/test output in the evidence log before closing this plan.

## Required implementation order

1. Establish the contracts, ownership, migrations, and removal map.
2. Make model capability and request manifest resolution authoritative.
3. Route all model attempts through the final fit gate.
4. Replace non-durable compaction/recovery paths with the fenced lifecycle.
5. Add usage anchoring and attempt/turn events.
6. Build the read projection and connect the minimum Playground status/detail surface.
7. Run the full failure matrix and real Playground certification; remove superseded limit loops.

Each coherent step receives its own commit. Old context paths are removed only after the replacement
has conformance coverage and the real-run proof above.

## Release record

| Field | Decision |
| --- | --- |
| Change | Durable provider-aware context runtime and truthful runtime telemetry |
| Owner | Agent Platform |
| Risk | High: affects every model call and can alter run termination behaviour |
| Affected services and surfaces | Agents worker, Temporal workflows, PostgreSQL, model adapters, internal Core boundary, Playground |
| API/schema/migration | Additive versioned journal/read-model contracts and context migrations 145-146; no destructive migration is required for local certification |
| Feature flag / rollout | Local-only, isolated Playground verification; no Railway or Vercel deployment is in scope. Any hosted rollout requires a separate release decision after Temporal and Playground certification |
| Analytics | Not applicable as a new product analytics event set; operational context, compaction, usage, and failure facts use the existing redacted `harness.turn` journal contract |
| Logs/metrics | Structured redacted context/attempt/compaction events, error rates, fit failures, compaction effectiveness, latency, and queue/worker-loss signals; no new exporter or retention system is introduced here |
| Documentation | Update agent context architecture, provider/runtime contracts, Playground operational guide, and migration/runbook material as contracts settle |
| Validation evidence | Full agents suite: 180 files / 1,080 tests passed, 39 files / 115 tests skipped; agents build and client TypeScript pass; targeted Studio/telemetry source lint passes (the broad package lint is contaminated by generated `.vercel/output` artifacts); PostgreSQL context-runtime integration: 3 tests passed; memory capture/checkpoint integration: 5 tests passed; local Temporal worker-loss/replay: 2 tests passed; real Playground evidence remains open |
| Version/release ID | Not applicable to the current local-only certification; any future hosted release must record the platform release ID, commit SHA, artifact versions, and migration versions before promotion |
| Rollback | Local branch rollback is a commit-level revert; migrations are additive and no destructive migration is part of the first cutover. Hosted rollout requires a tested prior harness revision and explicit rollback gate |
| Post-release review | Not applicable until a hosted release exists; local certification must review real-run context failures, provider errors, compaction effectiveness, and telemetry accuracy before promotion |

## Evidence log

| Checklist area | Code/migration | Tests or manual proof | Commit / run evidence | Status |
| --- | --- | --- | --- | --- |
| 0. Baseline and contracts | `context-planning.ts`, `context-capability.ts`, `journal/contracts.ts`, `context-memory-boundary.ts` | Context planner, capability, loop, anchor, streaming, memory-boundary, manifest, transcript-repair, and telemetry tests; agents build | Latest full agents suite: 180 files / 1,080 tests passed, 39 files / 115 tests skipped; `pnpm --dir agents run build` passes; client TypeScript and focused Studio lint pass; `git diff --check` passes; PostgreSQL context-runtime integration: 3 tests passed; combined PostgreSQL context/memory verification: 8 tests passed; typed memory policy-block propagation is covered in `context-memory-boundary.test.ts` | In progress |
| 1. Capability resolution | `context-capability.ts`, `model-capability-catalog.ts`, `model-capability-repository.ts`, `model/provider-metadata.ts`, `system/kasiai-models.ts`, `temporal/activities.ts`, `loop.ts`, migrations 121-122 | fallback route/model resolution, source precedence, lazy catalog hydration, direct-provider response parsing/auth/cache, fail-closed autonomous boundary, correction, expiry, and cold-resolver tests | 64 focused context/capability/metadata/loop/telemetry/compaction/memory-boundary tests passed; PostgreSQL capability reload and expiry integration passed; direct metadata is exact-route and credential-scoped, malformed/no-capacity responses remain unknown, custom endpoints are excluded | In progress |
| 2. Request assembly | `context-planning.ts`, `loop.ts`, `context-manifest-repository.ts`, migration 145, `model/{types,gateway,anthropic,gemini,openai-compatible}.ts` | planner, loop-boundary, manifest repository, transcript-repair, provider-envelope, and memory-boundary tests | planner owns history selection and final fit; memory evidence is injected before final planning; content-free identity, source digest, component token/byte accounting, reservations, provider envelope measurement, and pre-dispatch manifest persistence are implemented; `BuiltAgentContext.sourceMessages` keeps the complete normalized transcript available to Temporal/autonomous/workflow loops instead of feeding a fixed-count preflight projection; the boundary test proves retrieval → manifest persistence → provider dispatch ordering and memory evidence accounting; output-clamp regression proves dispatched `maxTokens` equals manifest reservation; durable run-budget admission receives the exact planner accounting; repository, PostgreSQL integration (16 tests across manifest/budget/capability/memory capture), and full-suite evidence are green | In progress |
| 3. Pressure and compaction | `context-compaction.ts`, `context-planning.ts`, `context-memory-boundary.ts`, `context-attempt-budget.ts`, `context-attempt-budget-repository.ts`, migration 146 | compaction, checkpoint-block, lifecycle telemetry, attempt-budget, transcript-structure, and planner tests | Hermes-adapted wire-only prune pass, protected active task/pairs, candidate validation, summary fallback, pre-loss memory checkpoint, typed outcomes with user remediation, durable PostgreSQL attempt budget, and content-free lifecycle events are covered; durable compaction remains an evidence/checkpoint artifact and no longer supplies an independent model-facing fixed-count projection; full pressure matrix remains | In progress |
| 4. Durability and recovery | `context-compaction-repository.ts`, `context-compaction.ts` | generation CAS/fence, cancellation, timeout, lifecycle telemetry, worker-loss-after-commit fault injection, and replay tests | durable generation/fence path, shared-journal lifecycle events, typed late-commit rejection, replay after a commit-observation failure, and PostgreSQL replay/fencing are covered; PostgreSQL integration is green (2 tests); local Temporal worker-loss/replay integration is green (2 tests) for both `before_persist` and `after_persist` stages; the local launcher defaults to a local Temporal server | Complete |
| 5. Usage and timings | model adapters, `context-usage-anchor.ts`, `runtime-telemetry.ts`, `loop.ts` | adapter, anchor, loop, streaming, compaction telemetry, and turn-clock tests | provider/estimate basis, queue/start/failure timing, first-token event, queue delay, prompt/prefill time-to-first-token, rolling timings, turn admission/waits, replay-safe attempt history, latest compaction lifecycle projection, and monotonic snapshot revision implemented; real provider usage and Playground proof remain | In progress |
| 6. Projection and Playground | `http/app.ts`, `runtime-telemetry.ts`, client contract, Studio | timeline API and telemetry reducer tests; client lint/build | durable timeline projection/API contract, live timeline polling, compact status row, detail panel, unknown-value rendering, distinct context/usage/run-budget telemetry, journal-linked graph nodes, snapshot revision display, typed context remediation shown in the Playground error surface, and responsive Studio layout implemented; Studio now loads the Playground installation by default and runs the live test conversation inside the configuration workspace, while `/playground` remains a compatibility route; reducer coverage includes proof that legacy `context.assembled` cannot overwrite final `context.planned` measurements (`runtime-telemetry.test.ts`, 13 tests); client TypeScript/lint pass; real reconnect/manual run proof remains | In progress |
| Memory coordination seam | `context-memory-boundary.ts`, `context-compaction.ts`, `context-engine.ts`, `loop.ts`, `journal/contracts.ts` | `context-memory-boundary.test.ts`, `context-engine.test.ts`; focused tests, full agents suite, and build | fake/no-op adapter, enforced checkpoint block, explicit failed-plus-blocked events, public-engine boundary forwarding, retrieval-before-manifest, exact runtime evidence/source-boundary forwarding, exact retrieval identity forwarding, redacted request fields, injected-evidence boundary isolation, typed policy-block propagation, and shared journal envelope are green; database-backed memory capture/checkpoint integration passes 5 tests; the production adapter handoff remains pending because the parallel adapter must persist the runtime-provided digest and boundary without recomputing them | In progress |
| 7. End-to-end certification |  | Full suite, PostgreSQL context-runtime integration, and local Temporal recovery matrix | Full suite: 180 files / 1,080 tests passed, 39 files / 115 tests skipped; the PostgreSQL context-runtime checks pass 3 tests across `db-context.integration.test.ts` and `context-runtime-postgres.integration.test.ts`; Temporal worker-loss/replay passes 2/2 tests on the local server; real Playground proofs remain | In progress |

## Definition of done

- [ ] Every checklist item above has implementation, focused coverage, and evidence in the log.
- [x] No model-facing path retains an independent token-limit or compaction decision outside the
  context runtime. Temporal passes the complete durable transcript into the shared provider-aware
  planner, and the loop dispatches the exact output reservation recorded in its manifest.
- [x] Context occupancy, run budgets, and cumulative usage remain distinct from storage through UI.
  The durable runtime snapshot exposes separate `context`, `usage`, and `runBudget` objects, and
  the Studio detail panel renders them independently; reducer coverage proves the values cannot be
  confused by matching token counts.
- [ ] A long real autonomous Playground run compacts safely and reports its actual measurement basis.
- [x] Context overflow recovery is bounded, durable, fenced, and explainable; an unresolvable fit
  produces a typed terminal outcome. Evidence: `context-overflow-recovery.test.ts`,
  `context-planning-loop.test.ts`, `context-attempt-budget.test.ts`, and the fenced lifecycle
  coverage in `context-compaction.test.ts`.
- [x] PostgreSQL/Temporal worker-loss and replay tests pass on the local stack.
- [x] The plan's release record, migrations, documentation, observability, validation, and rollback
  decisions are completed or explicitly recorded as not applicable for the local-only certification
  scope; hosted promotion remains gated on the open Temporal and Playground evidence.
