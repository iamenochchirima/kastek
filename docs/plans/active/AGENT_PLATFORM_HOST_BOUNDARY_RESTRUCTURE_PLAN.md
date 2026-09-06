---
id: agent-platform-host-boundary-restructure
title: First implementation chunk · Agent runtime foundation and host composition rewrite
sidebar_label: First chunk · Runtime foundation rewrite
slug: /host-boundary-restructure
description: First Agent Platform implementation chunk for the one-agent runtime model, information containment, host composition, and rewrite foundation.
---

# Agent Platform Runtime Foundation and Host Composition Rewrite

**Status:** Planned; first implementation chunk

**Owner:** Agent Platform

**Last updated:** 2026-09-06

**Risk:** High

**Canonical plan:** [`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](../agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md)

**Canonical packages:** P00, P00B, and P02. This document is the first executable implementation
chunk derived from those packages.

**Implementation state:** No checklist item is complete until its code, test, and evidence link are
recorded here. A checked item means the new contract is verified, not merely that an interface or
placeholder exists.

## Checklist status

All detailed implementation checks are currently pending. The phase checks are ticked only when
their detailed items and evidence are complete.

- [ ] [Phase 0 — Baseline and slice selection](#phase-0--baseline-and-slice-selection)
- [ ] [Phase 1 — One-agent identity and execution scope](#phase-1--define-one-agent-identity-and-execution-scope)
- [ ] [Phase 2 — Module and composition boundaries](#phase-2--define-module-and-composition-boundaries)
- [ ] [Phase 3 — Core host adapter](#phase-3--implement-the-core-host-adapter)
- [ ] [Phase 4 — Native and tenant-host conformance](#phase-4--add-native-and-tenant-host-conformance-paths)
- [ ] [Phase 5 — First vertical slice](#phase-5--migrate-the-first-vertical-slice)
- [ ] [Phase 6 — Hardening and cutover](#phase-6--harden-document-and-prepare-the-next-slice)

Detailed checklist: [implementation checklist](#implementation-checklist).

## Objective

Rewrite the Agent Platform foundation so one shared agent runtime can be used by KasiAI, KasiTek
Core, tenant hosts, and customer-created agents through explicit, typed adapters and one
information-containment model.

The first chunk establishes the runtime identity, execution scope, composition seam, host adapters,
and durable evidence contracts. It does not split the Agent Platform into another deployed service.
Core remains supported as one host adapter, not as an assumption embedded throughout the runtime.

This is a rewrite of the Agent Platform runtime, not a compatibility migration. Existing code and
behavior are source material for understanding the system, but they do not constrain the new
interfaces, module ownership, UI, response shapes, or execution paths. We will remove obsolete
paths as their replacements become usable. The only invariants carried forward are those explicitly
required by the new architecture, especially tenant isolation, authorization, durable evidence,
safe handling of external effects, and explicit version pinning.

The first chunk is not the full Hermes-aligned harness implementation. It creates the deep seam that
the second chunk will fill with context policy, plugin resolution, reliable loops, operation recovery,
and execution visualization.

## Outcome

At the end of this chunk:

- one logical agent is represented as agent definition → immutable version → installation → session
  or conversation → durable run;
- every run has one explicit execution scope containing organization, installation, agent, version,
  session, run, actor, grants, and correlation identity;
- a run can pin an extension-snapshot reference even though full plugin resolution is implemented
  in the second chunk;
- the shared harness composition seam exists and is used by HTTP, Temporal, KasiAI, Core, native,
  and tenant-host paths;
- context, memory, knowledge, credentials, tools, connectors, MCP, events, and delivery resolve
  through the execution scope rather than caller-specific identifiers;
- the HTTP server, Temporal worker, and background workers construct dependencies at composition
  roots rather than inside domain or runtime modules;
- the Agent Platform runtime receives host capabilities through an explicit adapter boundary;
- KasiTek Core is represented by a first-party `CoreHostAdapter`;
- a tenant-host contract and conformance fixture exist without requiring a second production host to
  be deployed yet;
- at least one read-only host capability runs through the new boundary;
- at least one Agent Platform-native capability runs without Core;
- migrated tools no longer call the broad Core client directly;
- a Core-backed run, a hostless/native run, and a test tenant-host run use the same harness and
  execution evidence path;
- two unrelated sessions can execute concurrently without sharing scope or information;
- same-session admission has an explicit recorded policy, even though full durable session queueing
  remains in the later interaction chunk;
- the canonical event identity can link agent, installation, session, run, operation, and future
  extension snapshot records;
- obsolete direct paths and duplicate forwarding logic are removed from the migrated slice;
- the current UI is not required to remain functional or visually compatible while the new runtime
  contracts are being established.

This chunk is complete when the platform boundary is real and testable. It is not complete merely
because a new interface or wrapper exists.

## Why this is first

The current runtime is already trying to support a platform model, but host-specific assumptions
still enter at several composition and execution points:

- `agents/src/http/app.ts:520` constructs a `KasitekCoreReadClient` directly;
- `agents/src/temporal/activities.ts:2150` constructs or receives the Core client while building
  activities and tools;
- `agents/src/temporal/activities.ts:296` creates a large tool registry whose handlers directly
  depend on the Core client;
- background workers such as the transcription worker also construct or retain Core-specific
  dependencies.

This creates four risks:

1. A native or tenant-hosted agent can fail because Core is unavailable even when it does not need
   Core data.
2. A broad Core client becomes the accidental API of the Agent Platform.
3. Custom agents cannot be portable across Core and tenant installations without changing their
   runtime code.
4. Future harness, tool, context, visualization, and multi-agent work inherits the wrong boundary.

The restructure removes those risks before adding more agent behavior.

## Scope

### Included

- Ownership and dependency inventory for the HTTP server, Temporal worker, activities, runtime,
  tool registry, background workers, and current Core calls.
- A host-neutral runtime dependency contract.
- A one-agent runtime model and immutable execution-scope contract.
- An extension-snapshot reference contract for future skills, plugins, connectors, and MCP
  resolution.
- A shared harness composition seam used by internal and customer-facing agent classes.
- A typed host-adapter contract for identity, authorization, domain capabilities, media, delivery,
  usage, and host-owned resources where those capabilities are required.
- A first-party Core host adapter that exposes the required Core capabilities behind the new seam.
- A tenant-host conformance fixture with explicit scope and authorization behavior.
- Agent Platform-native capabilities that do not require Core.
- Composition-root changes for the API, Temporal worker, and affected background worker path.
- One read-only vertical slice migrated through the new capability boundary.
- Contract, scope-containment, tenant-isolation, rewrite, concurrency, and failure tests for the
  migrated slice.
- Documentation, release evidence, metrics, logs, and rollback material for the restructure.

### Excluded

- Splitting Agent Platform into a separately deployed service.
- Migrating every existing tool in one change.
- Replacing Temporal, PostgreSQL, or the current provider adapters.
- Rebuilding the full operation kernel, session queue, delivery ledger, or Agent Canvas.
- Implementing a complete external tenant platform integration.
- Implementing full plugin package resolution, skill loading, MCP tool search, or the complete
  extension lifecycle; those belong to the second implementation chunk, but their seam is defined
  here.
- Preserving the current customer-facing behavior, routes, UI, or response wording as a migration
  requirement.
- Adding Hermes-specific runtime behavior; Hermes alignment is a later change against this seam.
- Introducing a broad `HostClient` or permanent pass-through facade around Core.

## One-agent foundation established by this chunk

The first chunk defines the stable identity and containment model that the second chunk will use.
One logical agent is not a dedicated process. It is a versioned configuration executed by the shared
harness:

```text
Agent definition
  → immutable agent version
      ├─ instructions and model policy
      ├─ declared skills and capability requirements
      ├─ knowledge and memory policy
      ├─ channels and limits
      └─ extension-snapshot reference
          ↓
Installation
  ├─ organization, user, or business scope
  ├─ credential references
  ├─ resource and capability grants
  └─ enabled host/provider bindings
          ↓
Session or conversation
          ↓
Durable run
  ├─ pinned agent version and extension snapshot
  ├─ execution scope
  ├─ context reference
  └─ operations, receipts, and events
```

Every harness call receives the same `ExecutionScope` rather than accepting tenant or resource
identifiers from model arguments:

```text
ExecutionScope
  ├─ organizationId
  ├─ installationId
  ├─ agentDefinitionId and agentVersionId
  ├─ sessionId / conversationId
  ├─ runId
  ├─ actorId and actor type
  ├─ extensionSnapshotId
  ├─ capability and resource grants
  └─ correlation and causation identifiers
```

This chunk establishes the scope and snapshot references. The second chunk implements full
extension resolution for skills, plugins, connectors, and MCP. Context assembly, memory, knowledge,
tool authorization, provider calls, events, delivery, and child invocations must all narrow from
this scope; none may broaden it.

## Implementation checklist

Use this checklist as the implementation record. Tick an item only after the linked code, tests,
and verification evidence exist. If an item changes scope, update the plan before continuing.

### Rewrite and ownership

- [ ] Confirm the current code is reference material and record the target modules to delete or
  replace.
- [ ] Record the first implementation release identity and affected services before code changes.
- [ ] Assign ownership for definitions, versions, installations, sessions, runs, operations,
  events, delivery, credentials, memory, knowledge, and projections.
- [ ] Record the old UI and route surfaces that may be discarded; do not make them runtime
  dependencies.

### One-agent identity and containment

- [x] Define and validate `AgentExecutionScope`/`ExecutionScope` at the application seam. Evidence: [`agents/src/runtime/execution-scope.ts`](../../../agents/src/runtime/execution-scope.ts), [`agents/test/execution-scope.test.ts`](../../../agents/test/execution-scope.test.ts), and the local `agents` TypeScript build plus targeted scope/context/Core/immediate-read tests.
- [ ] Ensure every admitted run pins organization, installation, agent definition, agent version,
  session or conversation, actor, and correlation identity.
- [ ] Add the extension-snapshot reference to the run and effective configuration contract without
  implementing full plugin resolution in this chunk.
- [ ] Prove memory, knowledge, credentials, tools, provider calls, events, and projections receive
  the same scope.
- [ ] Prove model arguments cannot select a tenant, installation, credential, host, or resource.
- [ ] Verify two installations can run concurrently without data, grant, or event leakage.

### Harness and composition roots

- [ ] Define the minimal `AgentHarness` composition interface and its typed terminal/waiting
  outcomes.
- [ ] Move dependency construction to HTTP, Temporal, and affected worker composition roots.
- [ ] Ensure runtime and domain modules do not construct database, Core, provider, telemetry, or
  channel clients.
- [ ] Add import-direction and forbidden-construction checks.
- [ ] Construct the harness with a fake host adapter and a native capability without creating Core.
- [ ] Use the same harness composition for KasiAI, Core-hosted, native, and tenant-host fixture
  paths.

### Host and capability adapters

- [ ] Define the typed host identity and authorization contract.
- [ ] Define the first read-only domain capability contract with bounded input/output and
  provenance.
- [ ] Implement `CoreHostAdapter` for the selected capability.
- [ ] Implement one Agent Platform-native capability that works without Core.
- [ ] Implement the tenant-host conformance fixture with explicit scope and denied cases.
- [ ] Verify readiness, authorization, timeout, redaction, and unavailable outcomes use one result
  vocabulary.
- [ ] Remove the migrated direct Core-client path and duplicate forwarding logic.

### Sessions, events, and evidence

- [ ] Define the first admission result vocabulary: accepted, queued, limited, and rejected.
- [ ] Record the declared same-session serialization policy without implementing the full session
  queue in this chunk.
- [ ] Add canonical event identity for agent, installation, session, run, operation, actor,
  causation, and release.
- [ ] Link capability results to run and correlation evidence.
- [ ] Verify waiting or queued work does not require a worker-held resource in the new seam.

### Verification and cutover

- [ ] Run contract tests against Core, native, and tenant-host adapters.
- [ ] Run tenant-isolation and cross-installation negative tests.
- [ ] Run API and Temporal paths through the same harness and compare typed outcomes.
- [ ] Run worker-loss, timeout, missing-grant, missing-host, and sensitive-result tests.
- [ ] Complete one manual Core-backed run, one Core-free run, and one tenant-host fixture run.
- [ ] Confirm the rewritten slice is the only execution path for its declared scope.
- [ ] Remove obsolete code and update architecture/runbook documentation.
- [ ] Record metrics, logs, alerts, release identity, deployment rollback, and final evidence.

## Architectural decision

The Agent Platform owns the agent lifecycle. A host supplies scoped capabilities.

```text
Core, tenant host, web, channel, REST, or MCP entry point
                              |
                              v
                    Agent Platform application API
                              |
                              v
                    Agent runtime and harness
          sessions | runs | context | tools | approvals
                              |
                              v
                    Capability and host boundary
                       /          |          \
                      /           |           \
                     v            v            v
              CoreHostAdapter  TenantHost   Native capabilities
                              Adapter       and provider adapters
                              |
                              v
                       Temporal + PostgreSQL
```

The runtime depends on narrow capabilities, not on a product-wide Core client:

```text
Agent tool → typed capability → selected host/provider adapter → scoped result
```

The adapter is selected by the admitted installation and pinned to the run. A model cannot select
the host, adapter, credential, or resource scope by placing an identifier in tool arguments.

## Ownership boundary

### Agent Platform owns

- agent definitions and published versions;
- installations and runtime policy;
- sessions, invocations, and runs;
- harness execution, tool proposals, and tool results;
- context, knowledge, and memory policy;
- approvals and durable interactions;
- operation evidence, execution events, and visual projections;
- delivery intent and delivery lifecycle where the platform is coordinating the interaction.

### Core or a tenant host owns

- tenant and actor identity;
- host-owned product records and domain rules;
- host-owned business capabilities such as customers, bookings, CRM, or content records;
- host-owned media and storage resources;
- host-owned billing, entitlements, or usage rules where applicable;
- host-owned credentials and connections where the host is the authority for them.

### Provider adapters own

- provider-specific authentication and request construction;
- provider-specific capability and readiness checks;
- provider effects, receipts, polling, webhooks, and reconciliation;
- provider-specific error translation into the shared operation contract.

An adapter may expose a capability. It must not transfer ownership of the Agent Platform lifecycle
back to the host or allow raw provider APIs to leak into prompts.

## Host capability contract

The contract should be capability-oriented rather than endpoint-oriented. The initial contract needs
these categories, with only the capabilities required by the selected vertical slice implemented:

| Category | Responsibility | Required boundary behavior |
| --- | --- | --- |
| Identity | Resolve organization, installation, actor, and host identity | Scope is explicit and cannot be supplied only by model arguments |
| Authorization | Check actor, installation, capability, and resource authority | Deny before host data or credentials are exposed |
| Domain read | Read a bounded host-owned record or collection | Typed input/output, pagination or limits, redaction, provenance |
| Domain write | Request a host-owned mutation | Approval, idempotency, effect evidence, and unknown-result handling remain explicit |
| Media | Resolve host-owned asset metadata or transfer references | No raw bytes or long-lived provider URLs in model context |
| Delivery | Send or receive through host-owned channels when applicable | Delivery state is separate from run completion |
| Usage | Reserve, capture, release, or reconcile host-owned usage | No hidden billing call from a generic tool handler |
| Resource scope | Bind calls to tenant, installation, connection, and selected resource | Provider IDs and host IDs are not sufficient authorization |

The first vertical slice should use one read-only domain capability. The exact capability—such as a
customer, booking, or workspace read—must be selected during the inventory phase based on the
smallest stable current contract. The slice should also exercise one Agent Platform-native
capability so that the Core-free path is proven in the same chunk.

## Implementation phases

### Phase 0 — Baseline and slice selection

**Purpose:** Establish the current dependency graph and select the smallest useful vertical slice.

- Inventory every direct construction and injection of Core-specific clients in API, Temporal,
  background, tool, provider, and operator paths.
- Map each current Core call to its domain capability, owner, authorization source, transaction
  boundary, error vocabulary, and current tests.
- Identify the first read-only capability to migrate and document why it is the smallest stable
  representative slice.
- Identify one Agent Platform-native capability that must run without Core.
- Record current behavior fixtures for Core-backed execution, missing Core configuration, tenant
  mismatch, authorization denial, and bounded result handling.
- Record baseline metrics for successful calls, authorization failures, Core unavailability, latency,
  and user-visible terminal outcomes.

**Phase gate:** The first capability, its owner, its adapter contract, and its manual test data are
named. No implementation begins while the slice still includes multiple unrelated domain areas.

### Phase 1 — Define one-agent identity and execution scope

**Purpose:** Establish the identity and containment contract that every later harness, tool,
connector, plugin, MCP, context, and multi-agent operation will use.

- Define the typed `ExecutionScope` with organization, installation, agent definition, agent
  version, session/conversation, run, actor, extension snapshot reference, grants, and correlation
  identifiers.
- Define the one-agent lifecycle: definition → immutable version → installation → session → run.
- Add run and effective-configuration fields needed to pin the agent version and extension snapshot.
- Define scope propagation rules for memory, knowledge, credentials, capabilities, providers,
  events, delivery, and projections.
- Define the admission result vocabulary and same-session policy without implementing the full
  session queue yet.
- Define the canonical event identity required to link agent, installation, session, run, operation,
  actor, causation, and release.
- Add negative tests for model-supplied scope identifiers and cross-installation access.

**Phase gate:** A fake harness run can prove that the same scope reaches every adapter and that a
model cannot broaden it. A run can be inspected by agent version, installation, session, run, and
extension-snapshot reference.

### Phase 2 — Define module and composition boundaries

**Purpose:** Make dependency direction enforceable before moving behavior.

- Define the application composition roots for HTTP, Temporal, and the affected worker paths.
- Define the runtime dependency contract that receives adapters and repositories from the roots.
- Keep domain and runtime modules from constructing database, Core, provider, telemetry, or channel
  clients.
- Define import-direction rules: contracts and domain modules may not import protocol or provider
  implementations; adapters may depend on protocols; composition roots assemble the graph.
- Add dependency checks for forbidden direct imports and direct Core-client construction in migrated
  modules.
- Move contract tests to the new interfaces before moving the first implementation.

**Phase gate:** The runtime can be constructed with a test host adapter and a native capability
without creating a Core client.

### Phase 3 — Implement the Core host adapter

**Purpose:** Re-express the required Core capabilities as one implementation of the host seam.

- Place Core-specific HTTP, developer-key, request-header, capability-token, and error translation
  behavior inside the Core adapter boundary.
- Expose only the selected typed capability to the migrated tool or application module.
- Keep organization, installation, actor, run, and correlation scope attached to every call.
- Keep authorization and resource-selection rules in the owning adapter and capability modules; do
  not move them into a generic tool prompt or a model-facing identifier convention.
- Translate Core failures into the shared capability result without losing the original bounded
  reason code and correlation evidence.
- Delete the old direct path once the new capability contract and vertical slice are verified.

**Phase gate:** The migrated capability can be called through the Core adapter without the runtime
knowing about the broad Core client.

### Phase 4 — Add native and tenant-host conformance paths

**Purpose:** Prove that the boundary supports more than Core without requiring a second production
host implementation yet.

- Add a platform-native capability implementation for the selected Core-free test path.
- Add a tenant-host conformance adapter or fake host with explicit organization and installation
  scope, authorization denial, bounded results, and typed failure behavior.
- Run the same capability contract suite against Core, the native implementation where applicable,
  and the tenant-host fixture.
- Verify that the agent installation selects the adapter through configuration and policy, not by
  changing agent runtime code.
- Verify that a host can omit capabilities and the runtime returns a truthful unavailable result
  before attempting a provider or host call.

**Phase gate:** One agent definition and harness can run against Core, a hostless/native path, and a
tenant-host fixture with the same execution contract.

### Phase 5 — Migrate the first vertical slice

**Purpose:** Prove the architecture with real behavior rather than interfaces alone.

- Migrate the selected read-only capability from direct Core access to the typed capability.
- Keep the tool manifest, agent grant, installation scope, and result redaction explicit.
- Emit the existing execution events and link the capability result to the run and correlation
  evidence.
- Define the new user-visible response and error behavior from the new capability contract. The
  existing UI and response shape are not constraints on this rewrite.
- Verify a Core-backed run, a tenant-host fixture run, a missing-capability run, an authorization
  denial, a host timeout, and a bounded result.
- Verify the selected Agent Platform-native capability with Core unavailable.

**Phase gate:** The vertical slice works through the new boundary in the API and Temporal execution
paths, with no direct Core client dependency in the migrated runtime/tool module.

### Phase 6 — Harden, document, and prepare the next slice

**Purpose:** Make the boundary safe to extend without turning this chunk into a platform rewrite.

- Remove duplicate validation, temporary forwarding code, and obsolete direct paths from the
  migrated slice.
- Record the adapter conformance test results and remaining direct Core dependencies.
- Add structured logs, metrics, dashboards, and alerts for adapter selection, capability readiness,
  authorization denial, host latency, host failure, and Core-free execution.
- Update internal architecture and capability documentation with the ownership and adapter rules.
- Record the new contract version, cutover scope, release identity, and deployment rollback action.
- Identify the next capability family only after the first slice passes its exit criteria.

**Phase gate:** The next tool family can be migrated by following the same contract rather than
creating another Core-specific path.

## Manual verification protocol

Use one non-production organization, one test installation, one known agent version, and fixed test
records. Record the run ID, correlation ID, adapter selected, capability, release identity, and
execution-journal cursor for every scenario.

| Scenario | Expected result |
| --- | --- |
| Two installations run concurrently | Each run has its own execution scope, credentials, grants, context, and event stream; no data crosses installations. |
| Model supplies another tenant or installation identifier | The request is denied before an adapter, credential, or host resource is accessed. |
| Agent version changes during a run | The active run remains pinned to its original agent version and extension-snapshot reference. |
| KasiAI and customer agent use the harness | Both use the same harness and event contracts; only their scoped capabilities differ. |
| Core-backed read-only capability | The call succeeds through `CoreHostAdapter`; the runtime does not access the broad Core client directly. |
| Core unavailable for a Core-required capability | The run returns a typed unavailable or host-failure result; it does not hang or invent data. |
| Native capability with Core unavailable | The agent completes through the native path. Core is not constructed or called. |
| Tenant-host fixture capability | The same agent harness succeeds through the tenant adapter with the fixture's scoped data. |
| Tenant mismatch | The call is denied before host data, credentials, or provider calls are exposed. |
| Missing capability grant | The capability is not offered or the invocation ends with a typed denied result; no host call occurs. |
| Host timeout | The operation has a bounded terminal or retryable state with evidence and no duplicate read side effect. |
| Large or sensitive result | The model receives a bounded redacted projection while the authorized evidence remains inspectable. |
| API and Temporal paths | Both paths use the same capability contract and produce equivalent terminal outcomes. |
| Rewrite cutover | The new slice is the only execution path for its declared scope, and its evidence can be inspected and replayed without relying on the removed implementation. |

## Verification requirements

### Automated

- Contract tests for every selected capability and adapter.
- Execution-scope propagation tests for every harness dependency and adapter.
- Agent definition, version, installation, session, run, and extension-snapshot pinning tests.
- Composition tests proving Core is optional for native-only execution.
- Forbidden-import and direct-construction checks for migrated modules.
- Tenant-isolation and authorization tests.
- Core adapter request, error, timeout, and redaction tests.
- Tenant-host conformance fixture tests.
- API, Temporal, and background-worker integration tests for the migrated slice.
- Replay and recovery tests for the new run evidence and operation contracts.

### Operational

- Structured adapter-selection and capability-outcome logs with bounded error codes.
- Metrics for adapter calls, success, denied, unavailable, timeout, latency, and Core-free runs.
- Dashboard or query showing the migrated slice by adapter and outcome.
- Alert for unexpected direct-Core construction, adapter error spikes, and tenant-scope violations.
- Runbook entry for deployment rollback and reconciliation; no runtime fallback path is required.

## Exit criteria

This implementation chunk is verified only when all of the following are true:

- P00 ownership and contract evidence is recorded for the migrated slice.
- Composition roots construct the runtime dependencies; migrated domain modules do not construct
  Core or provider clients.
- Core works as a typed host adapter.
- The tenant-host conformance fixture passes the same contract tests.
- At least one native capability runs without Core.
- At least one read-only host capability runs through Core and the new boundary.
- The same agent definition and harness work across Core, native, and tenant-host test paths.
- The one-agent lifecycle and execution scope are explicit, persisted, and inspectable.
- Two installations can run concurrently without information, grant, credential, or event leakage.
- The active run is pinned to its agent version and extension-snapshot reference.
- API and Temporal execution produce the same typed capability outcomes.
- Manual failure, isolation, and rollback scenarios pass.
- Logs, metrics, documentation, release identity, rollout, and rollback evidence are recorded.
- Remaining direct Core dependencies are either removed or explicitly assigned to a new runtime
  module; none remain as an implicit compatibility path.

## Next implementation chunks

This chunk intentionally leaves the following for later, separate plans:

1. Durable operation kernel and external-effect boundaries — P03.
2. Tool registry, provider, MCP, and readiness migration — P05.
3. Context, knowledge, and memory runtime improvements — P08.
4. Session queueing, unified delivery, and human interaction — P04, P06, and P07.
5. Custom-agent profiles, generated execution visualisation, and optional workflow authoring — P09,
   P09B, and P14.
6. Hermes-aligned harness improvements after the host boundary is stable.

## Release record

**Change:** Agent Platform host boundary, composition-root, Core-adapter, and first vertical-slice
restructure.

**Owner:** Agent Platform; Platform Integrations for adapter conformance.

**Risk:** High.

**Affected services and user surfaces:** Agents API, Temporal worker, affected background worker,
Core adapter seam, tool registry, agent execution, internal operator evidence, and the agent UI.
Customer-facing behavior and UI may change as part of the rewrite.

**Platform release version or release ID:** Local implementation working tree based on commit
`ec919081`; no remote release has been created for this slice.

**API/schema/migration changes:** New runtime identity, execution-scope, event, and installation
contracts may replace obsolete structures. Any required schema migration must be explicit, tested,
and recorded before implementation; additive compatibility is not assumed.

**Feature flag or rollout method:** No runtime compatibility flag is required. Use a controlled
local implementation cutover while the new slice is verified. Railway, Vercel, and other remote
deployments are intentionally out of scope for this implementation period; local build, test, and
runtime evidence is the release gate. Record any later deployment rollback action separately.

**Analytics events and success metrics:** Track adapter selected, capability outcome, host latency,
Core-free execution, authorization denial, and direct-Core construction attempts. Do not record
credentials, raw provider payloads, or full private message content.

**Logs, metrics, dashboards, and alerts:** Required as described in the operational verification
section.

**Documentation:** Update the internal architecture plan, adapter contract documentation, affected
runbook, and capability integration documentation in the implementation change.

**Validation evidence:** Contract, unit, integration, failure, tenant-isolation, manual, and
staged-runtime evidence listed above.

**Rollback or disable plan:** Stop new admissions if the deployed rewrite is unsafe, preserve
durable evidence, reconcile uncertain effects, and restore the last tested deployment artifact when
operationally necessary. Do not add or retain a runtime compatibility path solely for this purpose.

**Post-release review date:** Required after the staged rollout and before the next capability family
is migrated.
