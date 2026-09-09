---
id: agent-platform-execution-observatory-control-plane
title: Third implementation chunk · Agent Playground and execution observatory
sidebar_label: Third chunk · Agent Playground
slug: /execution-observatory-control-plane
description: Third Agent Platform implementation chunk for real Playground execution, immutable promotion, generated execution visuals, safe run controls, and full manual validation.
---

# Agent Playground and Execution Observatory

**Status:** In progress; first Playground and creation slice implemented

**Owner:** Agent Platform

**Last updated:** 2026-09-07

**Risk:** High

**Depends on:** [`Agent Platform Hermes-Aligned Runtime Reliability`](./AGENT_PLATFORM_HERMES_ALIGNED_RUNTIME_RELIABILITY_PLAN.md)

**Canonical plan:** [`AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](../agents/AGENT_PLATFORM_IMPLEMENTATION_PLAN.md)

**Related packages:** P01, P03, P06, P07B, P09, P09B, P11, P13, P14

**Related research:** [`Agent execution visualization platform research`](../agents/AGENT_PLATFORM_EXECUTION_VISUALIZATION_RESEARCH.md)

**Studio visual contract:** [`Studio runtime observatory and promotion update`](./AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md)

## Objective

Build the Agent Playground as a real Agent Platform environment. Users configure an agent, execute
it through the same harness, Temporal workflows, context engine, capabilities, gateways, delivery
paths, and journal used by live traffic, inspect exactly what happened, and promote the tested
immutable version to a live installation.

Playground is not a simulator, dry-run façade, or separate implementation. It differs from live
through explicit environment bindings: credentials, provider accounts, channel identities,
resource namespaces, destination allowlists, quotas, budgets, and approval policy. Promotion moves
the tested portable configuration and exact extension snapshot forward. It does not reconstruct
the agent from a second set of settings.

The execution observatory is a core part of the Playground. It makes every run understandable and
safely controllable while it is running and after it fails. It is a projection of the durable
execution journal produced by the second chunk. It must not become a second source of truth, infer
state from browser polling, or dictate how the runtime executes.

This chunk is where the platform becomes manually testable as a complete system. A developer,
operator, or customer agent builder should be able to configure a draft, run it against real
Playground resources, open the execution trace, understand what is waiting or failing, correct the
draft, and promote a validated version without editing the live version in place.

## Current implementation slice

The first implementation slice is now available for local testing:

- custom creation uses a typed profile rather than a required workflow graph;
- publication creates an immutable version and a pinned Playground installation;
- the Playground starts real runs through the platform message and Temporal paths and renders
  durable run events as an execution graph;
- `/playground` filters to installations explicitly marked `environment=playground`; and
- the runtime scope carries an explicit `playground` or `live` environment and rejects cross-environment
  child activation.
- protected system agents can receive a separate, idempotent Playground installation without
  changing their live/platform installation; existing workspaces expose this as an explicit
  install action while workspace bootstrap remains the default path for new workspaces.
- the installation endpoint accepts the requested environment without silently stripping it, and
  the Core browser boundary preserves `environment=playground` when listing installations; the
  tunnel host therefore uses the same local, environment-scoped behavior as direct local access.
- browser-facing Studio and Playground requests use the app-origin API proxy by default so the
  authenticated session and active-workspace scope remain attached; direct browser-to-Core
  requests require an explicit opt-out for hosts that do not ship the proxy.
- the Playground workspace uses a chat-first two-pane layout: the conversation owns the left
  composer and message history, the execution graph owns the remaining workspace, and agent
  configuration is opened on demand rather than occupying a persistent side panel.

This is a usable entry point, not completion of this chunk. Separate resource and credential
bindings, promotion manifests, live activation, reconnectable observatory projections, and stateful
controls remain unchecked until their backend contracts and evidence exist.

## Studio-owned creation flow

The current implementation keeps agent creation in Studio and leaves the older Agents-page
wizard out of this slice. KasiAi is a protected platform default and is ensured when Studio
opens; it is visible for inspection but cannot be edited or republished through the custom-agent
surface. New user agents are created as autonomous agents only for now. Guided service agents,
workflow agents, and specialist delegation are later runtime modes, not alternate creation paths
that should be implied by a missing field or a graph editor.

Studio creation submits one typed setup request. The Agent Platform creates the definition, creates
and publishes the first immutable version, and pins it to a Playground installation. The browser
does not coordinate four independent writes. A failed later stage compensates the incomplete
definition so a rejected setup does not leave an unusable local agent behind. The persisted spec
records `execution.mode=autonomous` explicitly and uses bounded context, iteration, model-call,
tool-call, token, and wall-time limits.

The first manual proof for this slice is: open Studio and see KasiAi as the default; create a
second autonomous agent from `/studio/new`; confirm it appears with a Playground installation;
open its Studio workspace; run it from Playground; inspect the durable execution graph; and
confirm KasiAi's protected configuration does not expose an edit or deploy action. The Agents page
will be redesigned separately and must not become a dependency of this flow.

## Studio capability management contract

The Studio settings workspace is the agent's draft control plane. It follows the same separation
used by Hermes-style harnesses: platform-managed tools are listed as built-in capabilities;
versioned skills are enabled separately; external MCP servers are discovered and health-checked
before a published server version is selected; and declarative plugin packages are selected from
the organization's published package catalog with explicit permission grants. A provider being
available is not the same as a version being enabled for an agent.

The implementation uses the existing AgentSpec and immutable AgentVersion boundaries:

- tool selection is written to `spec.capabilities.allowedTools` and readiness remains enforced by
  the runtime and installation grants;
- skill selection writes `spec.skills.allowedSkillIds`, then pins the selected published skill
  versions to the newly created draft version;
- MCP selection creates, discovers, publishes, and health-checks through the existing remote MCP
  repository, then pins the selected provider version to the draft;
- plugin selection writes canonical package references and grants to `spec.extensions`; package
  contents remain declarative and are resolved by the extension snapshot repository;
- credentials and connected services remain installation-scoped, so Playground credentials cannot
  be copied into Live by saving a draft.

The browser does not become a second runtime, package resolver, or approval system. It only edits
the draft contract and shows readiness/health data returned by the platform. The execution graph
and runtime telemetry remain sourced from the durable journal. The authoritative external-harness
references for this separation are the [Hermes plugin model](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/plugins.md)
and [Hermes MCP model](https://github.com/NousResearch/hermes-agent/blob/main/website/docs/user-guide/features/mcp.md).

Current implementation seams are the `/api/agents/skills`, `/api/agents/mcp/*`,
`/api/agents/extensions/packages`, installation integration/readiness routes, and the existing
version creation/publish flow. Handoff criteria for the next phase are: package configuration
forms use the declared configuration schema; permission grants are reviewed before publication;
the complete capability snapshot is included in promotion evidence; and browser tests prove that
save, refresh, draft replacement, deployment, and rollback preserve the exact selected versions.

Release impact for this local implementation slice: owner is Agent Platform; affected surfaces are
the Agents API, Core internal proxy, Studio settings, Playground drafts, skills, MCP, and extension
package catalog; no migration or hosted release is included; existing agents:read/agents:write
authorization and installation credential isolation remain the rollout boundary; structured API
errors and existing provider logs cover failures; analytics additions are not applicable until the
capability-management events are registered; validation is Agents TypeScript, client lint/typecheck,
Rust Core check, and browser/manual capability-save evidence; rollback is code rollback plus
selecting the previous immutable agent version, with no deletion of packages, pins, credentials, or
execution evidence.

## Why this is the third chunk

The first chunk established host composition and information containment. The second chunk makes
the harness, context, tools, operations, delivery, extensions, and event journal reliable. Those
contracts must exist before a visual surface can be trusted.

The third chunk consumes those contracts to provide:

- an Agent Playground for draft configuration and real environment-bound runs;
- a generated execution timeline and graph for every agent;
- durable, reconnectable live updates instead of polling-only assumptions;
- operation details with bounded inputs, outputs, errors, retries, approvals, and receipts;
- state-aware controls for pause, resume, cancel, retry, and reconciliation;
- role- and tenant-safe projections for developers, operators, and customer agent builders;
- a manual test surface for reproducing failures and verifying recovery.

The detailed Studio visual contract is kept in the standalone [Studio runtime observatory and
promotion update](./AGENT_STUDIO_RUNTIME_OBSERVATORY_UPDATE_PLAN.md). This plan owns the broader
Playground, projection, control, and promotion implementation. The Studio plan owns how context,
memory, capabilities, extensions, approvals, child runs, delivery, and promotion are composed for
people using the workspace.

The Playground is not a replacement for the runtime, and it is not an n8n-style requirement that
ordinary agents be assembled from blocks. Ordinary agents are configured as an agent profile with
instructions, capabilities, knowledge, memory, channels, and policy. Their execution view is
generated automatically. Authored workflow graphs remain an optional separate capability for
deterministic workflows.

## Platform patterns adopted for this chunk

The comparison research narrows this chunk to five related but separate surfaces:

1. **Real execution Playground:** select a pinned agent version and extension snapshot, resolve
   Playground resource bindings, submit input through a real channel or direct invocation, stream
   the run, and inspect intermediate execution evidence.
2. **Run observatory:** inspect a session → run → operation hierarchy for test and active runs.
3. **Timeline:** the exact ordered record of what happened. This remains the authoritative visual
   reading of a run.
4. **Generated graph:** an overview derived from the timeline, with aggregated and exact-execution
   modes. It does not imply that the agent was authored as blocks.
5. **Control and recovery:** state-aware commands that become durable transitions and show their
   own acknowledgement state.

The third chunk adopts useful patterns from LangGraph Studio, LangSmith, Google ADK Web, Dify,
Microsoft Foundry, AWS AgentCore, Langfuse, Logfire, n8n, and Restate, but adapts them to the
KasiTek journal, Temporal, and tenancy model. The
comparison and decisions are recorded in the [visualization research note](../agents/AGENT_PLATFORM_EXECUTION_VISUALIZATION_RESEARCH.md).

## Playground lifecycle

The Playground is the controlled path from configuration to production:

```text
Draft agent
    ↓ configure
Immutable candidate snapshot
    ↓ bind to Playground resources
Real Playground execution
    ↓ run through production-equivalent runtime and gateways
Execution observatory
    ↓ inspect, correct, compare
Validated candidate
    ↓ create promotion manifest
Live binding validation
    ↓ atomically activate for installation and channel
Live agent version
    ↓ execute pinned runs
Live observatory and controls
```

The Playground must keep these states separate:

- **Draft:** editable configuration that is not used by live traffic.
- **Candidate snapshot:** immutable agent configuration, extension snapshot, model policy,
  capability declarations, knowledge references, safety policy, and release digest.
- **Playground deployment:** the candidate snapshot bound to a Playground installation and its real
  test resources. Every run records the candidate and binding revisions it used.
- **Validated candidate:** a candidate with required successful Playground evidence, evaluations,
  channel checks, and approval.
- **Live deployment:** the same candidate digest bound to validated live resources and atomically
  assigned to an installation or channel target.
- **Active run:** a durable run pinned to the live version that started it; later draft changes do
  not mutate it.

The Playground should make configuration easy without hiding what will change. Its primary areas
are agent instructions and model policy, skills/plugins/connectors/MCP, knowledge and memory,
channels and delivery, approvals and safety, budgets and limits, and test inputs. Before execution
or promotion, the user can inspect the exact candidate digest and the effective environment
bindings without exposing credential values.

Playground runs perform real effects through real adapters. The safety boundary comes from resource
isolation and constrained authority, not simulated success: separate credentials and provider
accounts where available, Playground tenant/data namespaces, test channel identities, allowlisted
destinations, lower quotas and concurrency, bounded spend, and approvals for irreversible actions.
If a provider cannot supply an isolated test resource, the run must name the real destination and
require an explicit policy/approval before crossing it. Internal automated tests may still use
fakes, but the customer-facing Playground cannot present a fake adapter result as production
evidence.

A replay or fork always creates a new Playground run identity and therefore may perform the real
effect again. The UI must show this before submission and apply the same approval, idempotency, and
reconciliation rules used by live execution.

Deployment is a controlled promotion of a validated immutable candidate. A promotion manifest
records the candidate and extension digests, successful Playground run/evaluation evidence,
approver, destination, required binding contract, live binding revision, and release identity. The
activation changes the target's version pointer atomically; active runs remain pinned to their old
version and binding snapshot. Editing the draft after promotion creates a new candidate.

Promotion never copies secrets, Playground conversations, memories, provider side effects, or test
data into live. It promotes portable agent configuration and required resource declarations, then
resolves them against separately managed live bindings. Rollback activates the previous tested
candidate and binding revision while preserving all execution evidence.

## Playground/live parity contract

The platform must enforce one execution contract across environments:

| Concern | Playground | Live | Parity rule |
| --- | --- | --- | --- |
| Runtime code | AgentHarness and Temporal worker artifact | Same artifact | Release/code digest must match |
| Agent definition | Immutable candidate version | Same candidate version | No translation or manual rebuild |
| Extensions | Pinned skills, plugins, MCP, and tool snapshot | Same pinned snapshot | Extension digest must match |
| Context and memory logic | Real context engine and policies | Same logic and policies | Only bound data namespace differs |
| Tool/provider execution | Real adapters and provider requests | Same adapters and request contracts | Adapter revision must match |
| Channels | Real Playground account, endpoint, number, inbox, or test identity | Live channel identity | Same ingress, webhook, receipt, and delivery path |
| Credentials/resources | Playground binding revision | Live binding revision | Same binding contract; different secret/resource values |
| Effects | Real effects within constrained targets | Real effects within live authority | Same operation/idempotency/reconciliation semantics |
| Limits | Lower Playground quota, budget, and concurrency | Live operational limits | Limits are environment policy, not runtime branches |
| Evidence | Full journal, telemetry, receipts, and evaluations | Same evidence model | Same event and projection schemas |

### Environment binding seam

Environment selection must be handled behind one small runtime interface rather than repeated
`if playground` checks:

```text
EnvironmentBindingResolver.resolve(
  executionScope,
  candidateVersion,
  requiredResourceDeclarations
) -> immutable EnvironmentBindingSnapshot
```

The snapshot identifies the environment, organization, installation, credentials by opaque
reference, provider account/resource identifiers, data namespace, channel identity, destination
policy, quotas, budgets, approval requirements, adapter revisions, and expiry. `AgentHarness`,
capabilities, gateways, and Temporal activities consume this snapshot. Host adapters may narrow its
authority but may never replace or broaden it.

`environmentId`, `candidateVersionId`, `extensionSnapshotId`, and `environmentBindingRevision` are
part of `ExecutionScope`, run identity, operation evidence, and audit records. A run must fail
readiness before model/tool execution when required bindings are missing, unhealthy, expired, or
incompatible.

### Portable configuration and environment-owned bindings

| Promoted with the candidate | Resolved separately per environment | Never promoted |
| --- | --- | --- |
| Instructions and model policy | Credential references and OAuth grants | Secret values |
| Skill/plugin/MCP/tool manifests and pinned versions | Provider accounts, projects, numbers, pages, inboxes, and endpoints | Playground conversations and memories |
| Capability grants requested by the agent | Environment-specific granted authority | Test messages, posts, emails, bookings, or other effects |
| Knowledge source declarations and approved immutable revisions | Environment data namespace and permitted source bindings | Unapproved Playground data |
| Context, memory, approval, budget, and delivery policy | Concrete limits, allowlists, approvers, and destinations | Runtime journals or telemetry |
| Channel and resource requirements | Concrete channel/resource identities and health state | Provider tokens and refresh credentials |

Knowledge requires an explicit policy. An approved immutable knowledge revision may be referenced
by both environments; environment-local or customer data remains separately bound and is never
copied implicitly during promotion.

### Channel and gateway proof

A direct Playground chat proves the harness but does not certify a channel. Web, WhatsApp,
Telegram, email, social, REST, MCP, and future gateways must be testable through their real ingress,
authentication, webhook, attachment, receipt, retry, and outbound delivery paths using Playground
resources. Each promoted channel records its own successful evidence. Providers without isolated
test accounts require a controlled allowlisted test identity and a post-activation smoke test; the
UI must disclose this limitation rather than claim full parity.

## Playground product surface

The Playground is one workspace with three connected tasks. It should not scatter configuration,
testing, traces, and deployment across unrelated screens.

### Configure

- Edit the agent profile: instructions, model policy, capabilities, skills, plugins, MCP servers,
  knowledge, memory policy, approvals, budgets, limits, and declared channels.
- Manage Playground resource bindings separately from the portable profile.
- Show effective configuration, pinned extension versions, requested versus granted capabilities,
  unresolved resources, and validation errors before creating a candidate.
- Create an immutable candidate from the draft. Further edits return to a new draft revision.

### Run and inspect

- Choose direct invocation or a configured real Playground gateway/channel.
- Show the environment, candidate, resource binding revision, destination, estimated authority,
  budget, and approval requirements before starting.
- Present conversation/input beside a live generated graph and ordered timeline, with operation
  detail available without leaving the run.
- Support run comparison by candidate version, context decision, tool path, output, latency, token
  usage, cost, evaluation result, and terminal state.
- Make failures actionable: identify the failed boundary, show safe evidence, and offer only valid
  durable controls.

### Validate and promote

- Summarize required checks and show which exact Playground runs and channel exercises satisfy
  them.
- Compare the candidate with the currently active live version.
- Map each portable resource declaration to a healthy live binding and expose differences in
  authority, limits, destinations, and provider/channel support.
- Show the immutable promotion manifest before approval, then display pending, active, failed, or
  rolled-back activation state.
- Keep the previous live release visible as the rollback target.

The primary UI navigation should follow this lifecycle rather than exposing internal service
boundaries. Environment and candidate identity remain visible on every screen so a user cannot
mistake a Playground action for a live action.

## Promotion protocol

Promotion is complete only when all of these steps succeed:

1. Freeze the draft into an immutable candidate and extension snapshot with content digests.
2. Resolve a Playground binding snapshot and execute required real scenarios and channels.
3. Attach deterministic checks, evaluations, receipts, manual verification, and approval to that
   candidate. Evidence from another digest does not count.
4. Generate a promotion manifest containing the source candidate, runtime and schema revisions,
   evidence IDs, required resources, target installation/channels, approver, and rollback target.
5. Resolve live bindings by declaration, verify health and minimum required authority, and compare
   adapter/channel compatibility. Do not copy Playground binding values.
6. Recheck that the runtime artifact, candidate, extensions, adapters, and evidence schemas have
   not drifted since validation.
7. Atomically activate the release pointer for the selected target. If activation cannot be
   atomic, fail without routing partial traffic.
8. Run required channel-specific smoke checks, monitor halt thresholds, and either confirm the
   release or atomically restore the rollback target.

A tenant may have multiple installations and bindings, but environment identity is explicit and
organization-scoped. `playground` and `live` are initial environment classes, not global shared
accounts. The contracts must permit a later `staging` class without changing harness behavior.

## Outcome

At the end of this chunk:

- users can create and edit an agent draft without affecting live traffic;
- users can execute an immutable candidate through the real runtime using isolated, constrained
  Playground resources;
- Playground and live use the same runtime artifact, agent version, extension snapshot, adapters,
  event schema, and operation semantics;
- every run records its environment and immutable binding revision;
- users can inspect, compare, replay, or fork Playground runs without mutating the original run;
- users can validate a candidate from real execution evidence and promote that exact digest;
- users can bind and atomically activate that version for a live installation/channel and see
  which candidate and binding revision are active;
- credentials, test data, conversations, memories, and Playground effects are never copied during
  promotion;
- rollback reactivates a previous tested release without deleting evidence or mutating active runs;
- every run has a queryable summary, ordered timeline, and generated execution graph;
- the visual hierarchy distinguishes session, run, turn, operation, attempt, and child invocation;
- model calls, context decisions, tool selection, tool execution, approvals, waits, retries,
  provider effects, handoffs, child invocations, and delivery obligations are visible as typed
  execution items;
- the UI can reconnect from a cursor and reconstruct the same timeline without duplication or
  missed events;
- projections are rebuilt from durable evidence after process restart or projection loss;
- the UI distinguishes `running`, `waiting`, `paused`, `retrying`, `completed`, `failed`,
  `cancelled`, `unknown`, and `reconciliation_required` states;
- the graph supports an aggregated overview and an expanded exact-execution reading;
- controls are state-aware and create durable commands and audit events rather than mutating local
  UI state;
- an operator can inspect an uncertain external effect without the UI claiming that it succeeded
  or blindly retrying it;
- customer builders can inspect their own Playground and active runs without seeing another tenant's
  data, credentials, hidden prompts, or restricted provider payloads;
- the same visual model works for web, messaging, REST, MCP, scheduled, Core-hosted, native, and
  tenant-hosted runs;
- manual end-to-end testing can verify runtime behavior through the same evidence users and
  operators see;
- the observatory is useful before the full workflow designer or multi-agent experience exists.

## Scope

### Included

- A versioned execution-observatory read model derived from the canonical journal.
- Run summaries, operation details, timeline items, graph nodes, edges, status transitions, and
  failure/recovery projections.
- Cursor-based replay and a live subscription transport behind one deep query/subscription
  interface. The transport may use SSE or WebSocket, but the UI must not depend on polling for
  correctness.
- A run inspector for developers and operators.
- A customer-safe execution view for agent builders and Playground runs.
- A first-class Playground environment that creates new runs from a pinned candidate, extension
  snapshot, and immutable Playground binding snapshot without mutating an active run.
- Draft configuration and immutable candidate/live-version promotion for agent instructions,
  capabilities, knowledge, memory, channels, safety, budgets, and limits.
- An environment-binding contract for credentials, provider accounts/resources, data namespaces,
  channel identities, destinations, quotas, budgets, approvals, and adapter revisions.
- Real provider and external effects through constrained Playground bindings; no simulated result
  may qualify a candidate for promotion.
- Real gateway testing through Playground web, messaging, email/social where configured, REST, and
  MCP identities/endpoints.
- Promotion manifests, preflight validation, atomic activation, and rollback for a selected live
  installation or channel.
- Per-channel evidence requirements and a controlled post-activation smoke path where a provider
  cannot offer an isolated test resource.
- Connection state, replay state, projection lag, stale data, and unavailable-evidence states.
- State-aware commands for pause, resume, cancel, retry, approve/reject, release handoff,
  continue with agent, and reconcile where the runtime contract permits them.
- Redaction, tenant isolation, role filtering, retention behavior, and authorization tests for
  visual projections.
- Responsive behavior and accessibility for dense timelines, graphs, operation details, and
  controls.
- Synthetic and failure-injection fixtures that make long runs, retries, waits, unknown effects,
  and reconnects easy to reproduce locally.
- Documentation, structured logs, metrics, dashboards/runbooks, release evidence, and rollback
  decisions for the observatory.

### Excluded

- Replacing Temporal, PostgreSQL, the harness, or the durable execution journal.
- Implementing context policy, plugin resolution, tool replay, or delivery semantics that belong
  to the second chunk.
- Making the UI authoritative for run state or using browser memory as execution state.
- Requiring ordinary customer-service, research, or support agents to be authored as node graphs.
- The complete visual workflow designer and graph authoring experience; this chunk only consumes an
  authored graph when one exists and keeps it separate from generated execution visuals.
- Arbitrary live editing of an active version or active run.
- A mock, simulated, or dry-run customer Playground. Fakes remain valid only for automated tests
  and do not count as promotion evidence.
- Sharing live credentials or unrestricted live data with Playground by default.
- Copying Playground conversations, memories, test data, secrets, or side effects into live.
- Claiming that a direct chat test certifies an external channel that was not exercised.
- Unrestricted multi-agent orchestration or a swarm canvas.
- Product analytics dashboards unrelated to inspecting and controlling a specific execution.
- Preserving the current Agents, Live Chat, or handoff screens when their contracts conflict with
  the new execution model.

## Core design

```text
                    Portable immutable candidate
                         + extension snapshot
                                  |
                 +----------------+----------------+
                 |                                 |
                 v                                 v
      Playground binding resolver          Live binding resolver
                 |                                 |
                 +----------------+----------------+
                                  |
                                  v
       Same AgentHarness / Temporal / context / tools / gateways
                                  |
                                  v
                   Canonical durable execution journal
                                  |
                     +------------+-------------+
                     v                          v
             Read-model projections    Cursor + live subscription
                     +------------+-------------+
                                  v
              Playground and execution observatory
                   |            |             |
                   v            v             v
               Timeline     Graph view    Safe controls
```

Environment bindings are composition data, not alternative business logic. The same harness and
adapter implementations run in both environments. A capability receives scoped resource handles
from the binding snapshot; it does not choose credentials or infer whether it is in Playground.

The UI never reconstructs execution by joining unrelated logs or guessing from the latest run
status. It reads a projection with explicit freshness and cursor metadata. If the projection is
behind, the UI says so and offers replay/reload; it must not display a misleading “complete” state.

## Generated execution view versus authored workflow

The observatory must keep these concepts separate:

| Surface | Meaning | Source of truth |
| --- | --- | --- |
| Generated execution view | What the harness actually did for this run | Durable execution journal and projections |
| Authored workflow view | What the agent or workflow author configured in advance | Pinned agent/workflow specification |
| Operation detail | One bounded model, tool, provider, human, child, or delivery operation | Operation record, receipt, and event evidence |
| Control surface | A request to change a valid runtime state | Durable command and resulting state transition |

A generated graph may contain branches, retries, waits, parallel operations, and child runs even
when the agent was configured only with instructions and tools. That does not mean the customer
authored those nodes. The UI must label generated and authored views differently.

## Execution visual model

Every visual item must have a stable identity and enough information to explain its state:

```text
Run
  ├─ Context preparation
  ├─ Model turn
  │    ├─ selected capability
  │    ├─ tool operation(s)
  │    └─ bounded result projection
  ├─ Approval / human wait
  ├─ Provider or external effect
  ├─ Handoff and delivery obligation
  └─ Terminal outcome or reconciliation work
```

Minimum item fields:

- run, session, conversation, organization, installation, agent version, and extension snapshot;
- operation, parent operation, attempt, sequence, causation, and correlation identifiers;
- type, lifecycle state, start/end timestamps, deadline, duration, and release identity;
- safe display title and bounded reason/error code;
- input/output summaries with redaction and provenance indicators;
- retry, receipt, approval, delivery, and reconciliation references where applicable;
- visibility metadata describing which roles may inspect the item;
- projection version and journal cursor.

Raw prompts, credentials, access tokens, unrestricted provider payloads, and sensitive tool results
must not be placed in a projection merely because the UI can render them.

## Control semantics

Controls are commands, not cosmetic buttons. Every command must validate the current state, record
the requesting actor and reason, and show the resulting transition or refusal.

| Control | Valid use | Must not claim |
| --- | --- | --- |
| Pause | Stop at a safe checkpoint or enter a durable wait | That an in-flight external effect was undone |
| Resume | Continue a paused or approved run using its pinned plan | That a new version was applied to the active run |
| Cancel | Request cancellation and stop future work where safe | That an uncertain provider effect was cancelled |
| Retry | Retry a failed, retryable operation using its idempotency policy | That every failed operation is safe to repeat |
| Approve/reject | Resolve an explicit human approval boundary | That unrelated work was approved |
| Reconcile | Resolve or continue an unknown external effect with evidence | That the effect succeeded without a receipt |
| Handoff action | Claim, release, continue, or resolve a human-assistance state | That customer delivery occurred without delivery evidence |

The UI must disable or replace controls when a state transition is not valid. An unavailable
control must explain the bounded reason in the operation detail, not silently do nothing.

## Implementation phases

### Phase 0 — Freeze the observability contract

- Confirm the second chunk's event envelope, lifecycle states, cursor semantics, projection version,
  redaction rules, and role visibility rules.
- Define `playground` and `live` environment identities and add the environment, candidate,
  extension, and binding revision to execution scope and evidence contracts.
- Define the portable candidate schema, required resource declarations, immutable environment
  binding snapshot, promotion manifest, activation record, and rollback record.
- Define the narrow `EnvironmentBindingResolver` seam and prohibit environment-specific branches
  in the harness, capability implementations, and gateways.
- Classify every existing credential, provider resource, data source, channel identity, destination
  policy, quota, budget, and approval rule as portable configuration or environment-owned binding.
- Define the read-model interfaces for run summary, timeline, graph, operation detail, and command
  acknowledgement.
- Create representative fixtures for ordinary turns, tool rounds, approvals, waits, retries,
  handoffs, delivery uncertainty, and child runs.
- Record the baseline failure cases that the UI must make diagnosable.

### Phase 1 — Build durable projections

- Implement tenant-scoped projections from the journal rather than from browser-specific queries.
- Preserve event ordering, deduplicate repeated events, detect gaps, and expose projection lag.
- Support rebuild from a cursor or full journal replay after projection loss.
- Add bounded summaries and redacted operation details without changing the underlying evidence.

### Phase 2 — Add live subscriptions and reconnect

- Expose cursor-based initial load and live event delivery through one application interface.
- Handle reconnect, cursor expiry, duplicate events, out-of-order delivery, server restart, and
  subscription authorization changes.
- Publish explicit connection states: connected, replaying, delayed, disconnected, and unavailable.
- Remove correctness dependencies on fixed polling intervals.

### Phase 3 — Build the execution observatory UI

- Build the Playground shell with draft configuration, effective configuration preview, test input,
  explicit environment indicators, resource-binding health, candidate digest, and real-effect
  destination warnings.
- Build a Playground runner that selects a pinned candidate/extension/binding snapshot and starts a
  real run through the same invocation interface used by live channels.
- Build run list and run summary surfaces with clear state, age, source, agent version, and failure
  reason.
- Build a timeline that groups operations without hiding retries, waits, or unknown outcomes.
- Build a generated graph view with aggregated overview and expanded exact-execution modes. It must
  support parallel branches, parent/child runs, collapsed detail, and navigation back to the
  timeline.
- Build operation detail with safe inputs/outputs, provenance, attempts, receipts, and recovery
  actions.
- Add responsive, keyboard-accessible behavior for dense execution views.

### Phase 4 — Add state-aware controls

- Connect controls to durable commands and display acknowledgement, pending, refused, and completed
  command states.
- Implement authorization and state-transition tests for pause, resume, cancel, retry, approval,
  handoff, and reconciliation.
- Show explicit unknown and reconciliation states rather than offering unsafe retry shortcuts.
- Record command audit evidence and surface it in the timeline.

### Phase 5 — Add builder and testing workflows

- Add draft configuration for instructions, model policy, skills/plugins/connectors/MCP, knowledge,
  memory, channels, safety, budgets, and limits.
- Add environment binding management for opaque credential references, provider resources, data
  namespaces, channel identities, destination allowlists, quotas, budgets, concurrency, approvers,
  and adapter revisions.
- Add validation that resolves the effective extension and environment binding snapshots and
  reports readiness, permissions, missing/unhealthy connections, incompatible adapter revisions,
  expired credentials, and real-effect destinations before execution or promotion.
- Add a customer-safe test-run view for agent builders.
- Add replay/fork from a Playground checkpoint as a new real run, with an explicit repeated-effect
  warning and the same approval/idempotency policy enforced.
- Make it possible to run a controlled test, inspect the generated execution path, and open the
  exact operation/context decision that caused a failure.
- Show context decisions, token usage, latency, cost, retrieval provenance, and bounded tool result
  projections where authorized.
- Correlate capability operations with permitted backend/provider trace evidence.
- Add immutable candidate publication, Playground deployment, evidence-based validation, promotion
  manifest generation, live binding preflight, atomic activation, and rollback.
- Show a promotion diff covering portable configuration, extension revisions, required resources,
  policy, evidence, destination, and binding health. Never display or copy secret values.
- Show the active candidate, extension snapshot, environment binding revision, release identity,
  previous rollback target, and activation state in the Playground and observatory.
- Add real Playground resources for the initial proof set: direct web, one external messaging
  gateway, and REST/MCP. Exercise their real ingress and delivery paths.
- Define per-channel certification and post-activation smoke requirements for providers that cannot
  be isolated completely.
- Add fixtures and controls for context overflow, tool timeout, provider timeout, worker loss,
  approval wait, handoff, delivery uncertainty, and reconnect.
- Keep authored workflow inspection separate from generated run inspection.

### Phase 6 — Manual validation and release hardening

- Prove the same runtime artifact, candidate digest, extension snapshot, adapter revisions, event
  schema, and operation semantics are used in Playground and live.
- Test web, one messaging channel, REST/MCP, Core-hosted, native, and tenant-host paths with real
  Playground bindings and effects.
- Prove Playground identities cannot access live credentials, data namespaces, channels, or
  unrestricted destinations.
- Promote one validated candidate without rebuilding it, activate it atomically, keep an existing
  run pinned to its old version, and roll back to the previous tested release.
- Test desktop, tablet, and mobile layouts, keyboard navigation, role visibility, and redaction.
- Verify that a disconnected/reconnected UI reconstructs the same run without skipped or duplicated
  events.
- Record release identity, metrics, dashboards, alerts, runbooks, rollout, and rollback evidence.
- Mark this chunk complete only after the manual proof and automated verification both pass.

## Checklist

Tick an item only when its implementation, tests, and evidence link exist. A UI screenshot alone is
not sufficient evidence for a runtime or data contract.

### Contract and projection foundation

- [ ] Confirm the second-chunk journal and cursor contract is stable for this UI.
- [ ] Define `playground` and `live` environment identity in `ExecutionScope`, run identity,
  operation evidence, authorization, telemetry, and audit contracts.
- [ ] Define portable candidate, required resource declaration, environment binding snapshot,
  promotion manifest, activation, and rollback schemas.
- [ ] Define one `EnvironmentBindingResolver` interface and prove runtime modules do not select
  credentials/resources or branch on Playground themselves.
- [ ] Classify all current agent configuration as portable candidate data, environment-owned
  binding data, or runtime evidence.
- [ ] Define versioned observatory read models for run summary, timeline, graph, operation detail,
  and command acknowledgement.
- [ ] Define projection ownership, rebuild behavior, lag detection, retention, and failure states.
- [ ] Define redaction and role/tenant visibility rules for every projected field.
- [ ] Add fixtures covering success, failure, retry, wait, approval, handoff, delivery, child, and
  unknown-effect runs.

### Playground lifecycle and deployment

- [ ] Define draft, immutable candidate, Playground deployment, validated candidate, live
  deployment, and active-run state
  contracts.
- [ ] Build editable draft configuration for instructions, model policy, skills/plugins/connectors,
  MCP, knowledge, memory, channels, safety, budgets, and limits.
- [ ] Build effective-configuration preview showing the exact candidate digest, extension snapshot,
  required resources, and safe environment-binding metadata.
- [ ] Build separate Playground bindings for credentials, provider resources, data namespaces,
  channel identities, destinations, quotas, budgets, concurrency, approvers, and adapter revisions.
- [ ] Enforce default denial of live credentials, live data, live channel identities, and
  unrestricted destinations from Playground.
- [ ] Execute Playground runs through the real AgentHarness, Temporal workflows, context engine,
  capability implementations, gateway adapters, delivery path, and journal.
- [ ] Prove the customer-facing Playground contains no mock/simulated-success execution mode.
- [ ] Validate readiness, permissions, binding health/expiry, adapter compatibility, provider
  policy, destination policy, and effect authority before execution or promotion.
- [ ] Publish immutable candidate versions without mutating active runs or existing evidence.
- [ ] Record successful real Playground runs, evaluations, approvals, and channel evidence against
  the exact candidate and binding revisions.
- [ ] Generate a promotion manifest for the exact tested candidate and extension digests.
- [ ] Resolve and validate required live bindings without copying Playground secrets or data.
- [ ] Atomically activate a validated release for a selected live installation or channel.
- [ ] Keep active runs pinned to the version and binding snapshot with which they started.
- [ ] Roll back by activating the previous tested release while preserving execution evidence.
- [ ] Show environment, release identity, active candidate, extension snapshot, binding revision,
  activation state, and rollback target in the UI.

### Real resource and gateway parity

- [ ] Provision a separate Playground tenant/data namespace and prove cross-environment isolation.
- [ ] Bind real Playground credentials and provider accounts/resources for the initial proof set.
- [ ] Bind allowlisted recipients/destinations, lower quotas/concurrency, bounded spend, and explicit
  approval for irreversible Playground actions.
- [ ] Exercise direct/web input through the real ingress, runtime, and delivery path.
- [ ] Exercise one external messaging channel through real webhook authentication, attachments,
  provider request, receipt, retry, and outbound delivery paths.
- [ ] Exercise REST and MCP through the same authorization, scope, operation, and journal contracts
  used by live.
- [ ] Define email and social channel binding/certification contracts even when their Playground
  resources are not part of the initial proof set.
- [ ] Define controlled allowlisted tests and post-activation smoke evidence for providers without
  isolated test resources.
- [ ] Prove provider/tool adapter revisions and request/receipt schemas match between Playground and
  live.
- [ ] Define approved shared knowledge revision behavior and prove environment-local knowledge,
  conversations, and memories are not promoted implicitly.

### Durable execution views

- [ ] Build tenant-scoped run-summary and recent-run projections.
- [ ] Build ordered timeline projection with stable item identity and deduplication.
- [ ] Build generated graph projection for sequential, parallel, retry, wait, and child operations.
- [ ] Build operation detail projection with bounded input/output summaries and provenance.
- [ ] Prove projections can be rebuilt after process restart, event duplication, event gaps, and
  projection loss.

### Live updates and reconnect

- [ ] Add cursor-based initial load and replay.
- [ ] Add live subscription transport without polling as the correctness mechanism.
- [ ] Handle reconnect, cursor expiry, duplicate events, out-of-order events, and authorization
  changes.
- [ ] Show connected, replaying, delayed, disconnected, and unavailable states in the UI.
- [ ] Verify that reconnect reconstructs an identical timeline and graph.
- [ ] Verify browser requests preserve session and active-workspace scope through the app-origin
  proxy in local and production-shaped environments; direct cross-origin API access is opt-in.

### Observatory UI

- [ ] Build the run list and summary view.
- [ ] Build the real execution Playground for pinned candidate, extension, and environment-binding
  snapshots.
- [ ] Show the active environment and real destination before an external effect executes.
- [ ] Show resource-binding readiness and health without exposing credentials.
- [ ] Build candidate comparison, validation evidence, promotion diff, activation, and rollback
  views.
- [ ] Build the generated timeline view.
- [ ] Build aggregated and expanded generated graph views with parallel branches, retries, waits,
  and child runs.
- [ ] Build operation detail and recovery-evidence views.
- [ ] Show session → run → turn → operation → attempt hierarchy.
- [ ] Clearly distinguish generated execution from authored workflow configuration.
- [ ] Add customer-safe Playground-run inspection for agent builders.
- [ ] Add replay/fork as a new real Playground run, disclose repeated effects, and enforce approval,
  idempotency, and reconciliation policy.
- [ ] Show context decisions, token usage, latency, cost, retrieval provenance, and bounded tool
  result projections where authorized.
- [ ] Correlate capability operations with permitted backend/provider trace evidence.
- [ ] Verify responsive behavior at desktop, tablet, and mobile breakpoints.
- [ ] Verify keyboard navigation, focus management, accessible names, and non-color state cues.
- [ ] Verify hidden prompts, credentials, restricted outputs, and cross-tenant data never appear in
  unauthorized projections.

### State-aware controls

- [ ] Add durable pause and resume commands where the runtime state permits them.
- [ ] Add durable cancel commands with honest in-flight-effect behavior.
- [ ] Add retry only for operations marked retryable and idempotency-safe.
- [ ] Add approval and rejection commands with actor, reason, and audit evidence.
- [ ] Add handoff claim/release/continue/resolve controls against the durable handoff state.
- [ ] Add reconciliation controls for unknown provider and delivery outcomes.
- [ ] Show pending, refused, completed, and failed command states without silently dropping actions.
- [ ] Test every control against valid, invalid, stale, unauthorized, and concurrent states.

### Manual validation and release evidence

- [ ] Run a real web conversation and inspect the complete execution path.
- [ ] Start a real run from the Playground and verify its pinned environment, candidate, extension,
  and binding snapshots.
- [ ] Run a real messaging conversation using a Playground channel identity and inspect inbound,
  agent, tool, handoff, receipt, and outbound events.
- [ ] Run a REST or MCP invocation and inspect the same visual model.
- [ ] Run Core-hosted, native, and tenant-host paths through the same runtime and observatory.
- [ ] Verify Playground cannot read live credentials/data or target a destination outside its
  allowlist.
- [ ] Verify quotas, concurrency, budgets, and approvals constrain real Playground effects.
- [ ] Inject context overflow and verify a bounded recovery path is visible.
- [ ] Inject tool/provider timeout and verify retry or failure is truthful.
- [ ] Kill/restart the worker at operation boundaries and verify evidence and controls remain safe.
- [ ] Test approval wait, human handoff, delivery uncertainty, and reconciliation.
- [ ] Verify cursor replay after browser refresh, network loss, server restart, duplicate events, and
  projection lag.
- [ ] Verify replay/fork creates a new run identity, clearly warns about repeated real effects, and
  cannot bypass approval or idempotency policy.
- [ ] Promote the exact validated candidate without translating or rebuilding its configuration.
- [ ] Verify the promoted release has the same candidate, extension, runtime, adapter, and schema
  digests proven in Playground.
- [ ] Verify live binding preflight, atomic activation, old-run pinning, channel smoke evidence, and
  rollback to the previous tested release.
- [ ] Record structured logs, metrics, dashboards, alerts, redaction evidence, documentation,
  rollout, and rollback decisions.
- [ ] Record manual proof, automated verification, and remaining limitations before marking the
  chunk complete.

## Manual acceptance proof

The chunk is ready for acceptance when a developer can perform this sequence locally:

1. Create a draft agent in the Playground and configure its instructions, capabilities, knowledge,
   safety policy, required resources, and input.
2. Bind real Playground credentials, data, channel identity, quotas, approvers, and allowlisted
   destinations; inspect readiness without exposing secrets.
3. Preview the exact candidate, extension, and binding snapshots and run them through the real
   harness, Temporal workflow, capabilities, gateway, and delivery path.
4. Open the run in the observatory and see the inbound request, context decision, model turn, tool
   operation, result projection, and outbound delivery as separate items.
5. Disconnect the browser, allow the run to progress, reconnect, and verify that the same ordered
   execution is reconstructed from the cursor.
6. Trigger a wait, approval, timeout, or unknown effect and verify the UI exposes the correct state
   and only offers valid actions.
7. Take one valid action, such as approve, resume, cancel, retry, or reconcile, and verify the
   durable state transition and audit event.
8. Prove a Playground identity cannot access live resources or an unapproved destination.
9. Validate the candidate from its real execution evidence, inspect the promotion manifest and
   live binding preflight, and atomically activate that exact candidate for a live target.
10. Confirm the live release uses the same candidate, extension, runtime, adapter, and event-schema
   revisions; confirm an older active run remains pinned.
11. Roll back to the previous tested release and verify that neither run history nor evidence is
   lost.
12. Repeat the inspection as a customer-safe builder and as an operator, confirming that each role
   sees only its permitted evidence.

## Verification requirements

- Contract tests for all read models, cursors, projection versions, redaction, and commands.
- Contract tests for candidate portability, required resource declarations, environment binding
  resolution, promotion manifests, activation, run pinning, and rollback.
- Architecture tests proving the harness, tools, and gateways consume immutable bound resources
  rather than selecting credentials or implementing separate Playground branches.
- Environment isolation tests for credentials, data namespaces, channels, destinations, quotas,
  concurrency, budgets, and approvals.
- Artifact parity tests for runtime, candidate, extension, adapter, and event-schema digests.
- Projection tests for ordering, deduplication, gap detection, rebuild, and lag.
- Live-subscription tests for reconnect, cursor replay, duplicate delivery, out-of-order delivery,
  server restart, and authorization changes.
- Tenant, installation, role, and retention tests over every visual projection.
- Control-transition tests for valid, stale, concurrent, unauthorized, and unknown states.
- Browser-level tests for run inspection, live updates, reconnect, operation detail, and controls.
- Manual real-effect smoke tests across web, messaging, REST/MCP, Core, native, and tenant-host
  paths using Playground resources, followed by controlled post-activation channel checks.
- Responsive and accessibility verification for all observatory surfaces.
- Failure-injection evidence for worker loss, provider timeout, tool timeout, approval wait,
  handoff, delivery uncertainty, projection loss, and live reconnect.

## Exit criteria

This chunk is complete when:

- the observatory is generated from the canonical durable journal rather than browser polling or
  unrelated logs;
- the Playground can take an agent from editable draft through immutable candidate creation, real
  environment-bound execution, evidence-based validation, and selected-target promotion;
- Playground and live execute the same runtime artifact, candidate, extensions, adapter contracts,
  operation semantics, and event schema;
- differences between Playground and live are expressed only through explicit immutable resource
  bindings and environment policy;
- no customer-visible mock or simulated result can qualify a candidate for promotion;
- Playground access to live credentials, data, channels, and unrestricted destinations is denied;
- promotion activates the exact tested candidate without reconstruction and copies no secrets,
  conversations, memories, test data, effects, journals, or telemetry;
- active runs remain pinned to their original version and extension snapshot when the draft changes
  or a newer version is deployed;
- activation is atomic, binding readiness is validated, and rollback restores the previous tested
  release without deleting evidence;
- a run can be reconstructed from a cursor after refresh, disconnect, process restart, duplicate
  events, and projection rebuild;
- ordinary, graph-driven, Core-hosted, native, tenant-hosted, web, messaging, REST, and MCP runs
  use the same visual model;
- the timeline and graph show what the harness actually did, including retries, waits, parallel
  work, child runs, delivery, and unknown effects;
- state-aware controls produce durable, authorized commands and never claim an uncertain effect is
  complete;
- customer builders can inspect their own Playground runs, while operators receive the additional
  evidence permitted by their role;
- responsive, accessibility, redaction, tenant-isolation, and manual failure tests pass;
- release, observability, rollout, and rollback evidence is recorded;
- the full Agent Canvas and unrestricted multi-agent experience remain separate future work rather
  than being smuggled into this chunk.

## Open decisions

| Decision | Why it matters | Default for this chunk |
| --- | --- | --- |
| Initial environments | Determines scope and terminology | Implement `playground` and `live`; leave `staging` as a compatible later environment |
| Environment ownership | Prevents special-case runtime logic | One `EnvironmentBindingResolver`; runtime modules consume immutable bindings |
| Promotion unit | Determines whether tested behavior is preserved | Candidate version + extension snapshot + portable policies, identified by digest |
| Environment-owned state | Prevents secret/data leakage | Credentials, concrete resources, destinations, and limits remain separate bindings |
| Promotion evidence | Prevents untested releases | Require real Playground run/evaluation IDs and per-channel proof in a promotion manifest |
| Activation semantics | Prevents partially updated traffic | Atomic target pointer update; active runs remain pinned |
| Providers without test isolation | Avoids false confidence | Controlled allowlisted real test plus explicit limitation and post-activation smoke |
| Knowledge movement | Prevents accidental data promotion | Only approved immutable revisions may be shared; environment-local data is rebound |
| Playground replay | Prevents duplicate effects | Always a new real run with effect warning and normal approval/idempotency rules |
| Live transport | Determines reconnect and infrastructure behavior | Choose SSE or WebSocket behind one subscription interface; do not make polling authoritative |
| Projection storage | Determines query latency, rebuild, and retention | PostgreSQL-backed projections unless measured evidence requires another store |
| Graph layout | Determines readability for parallel and child work | Generated layout with collapsed groups and timeline fallback |
| Command delivery | Determines acknowledgement and duplicate-command behavior | Idempotent durable commands with visible acknowledgement state |
| Customer detail level | Determines privacy and usability | Safe summaries by default; detailed evidence only with explicit role permission |
| Full Agent Canvas timing | Determines scope discipline | Later than this chunk; this chunk provides the observatory seam it will consume |

## Release record

This document is a planning artifact. No production code, schema, provider, deployment, or runtime
dependency changes are authorized by this document alone.

| Field | Decision |
| --- | --- |
| Change | Real Agent Playground environment, immutable promotion lifecycle, execution observatory, visual control plane, and manual validation surface. |
| Owner | Agent Platform; Operations owns release and recovery evidence. |
| Risk | High once implementation begins; planning-only at this stage. |
| Affected services and surfaces | Agents API and worker, AgentHarness, Temporal, environment/resource bindings, credentials, PostgreSQL, projections, event subscriptions, operator console, customer agent builder, gateways/channels, promotion/activation, and tenant authorization. |
| Platform release version or ID | Not applicable until an implementation package is released. |
| API/schema/migration changes | Expected for environment identity, candidate/resource declarations, immutable binding snapshots, promotion manifests, activation, read models, cursors, subscriptions, commands, and audit evidence; exact revisions belong to implementation. |
| Feature flag or rollout | Planning only. Implementation begins locally with separate Playground/live bindings; activation is target-scoped and reversible. No Railway or Vercel deployment is part of this chunk's current local workflow. |
| Analytics | Required for Playground execution, readiness failures, validation evidence, promotion/activation/rollback, run inspection, reconnects, command outcomes, and user-visible recovery outcomes. |
| Logs, metrics, dashboards, and alerts | Required for binding health, isolation violations, promotion drift, artifact mismatch, channel certification, projection lag, event gaps, subscription disconnects, command failures, redaction violations, and rebuild failures. |
| Documentation | Update internal architecture, API, runbook, supported behavior, and operator documentation with implementation. |
| Validation | Contract, real-resource integration, artifact parity, environment isolation, gateway, projection, browser, accessibility, failure-injection, promotion, manual, and rollback evidence. |
| Rollback | Atomically reactivate the previous tested candidate and binding revision, disable unsafe controls if needed, and preserve all journals and promotion evidence. Never copy Playground data or delete execution evidence during rollback. |
| Post-release review | Required after each high-risk implementation phase. |
