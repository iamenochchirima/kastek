# KasiTek Provider-Neutral User Agents — Implementation Plan and Checklist

**Status:** Ready for implementation; execute in the order defined in section 4

**Owner:** Agent Platform runtime, API, integrations, and client teams

**Scope:** KasiTek-hosted agents created by ordinary workspace users

**Related plans:**

- `KASITEK_AGENT_CREATION_TYPES_PLAN.md`
- `AGENT_IDENTITY_ISOLATION_FIX_CHECKLIST.md`
- `KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md`
- `KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md`
- `KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`
- `PROJECT_PLAN.md`

## 1. Product decision

Ordinary user-created agents are generic agents. They are not smaller versions of KasiAi and they
must not receive KasiTek tools, KasiTek instructions, KasiAi memory, or workspace context by
default.

A user agent may be created with zero tools and zero external connections. It must still be a valid,
usable agent that can answer as a normal LLM using its own instructions, knowledge, and conversation
history.

KasiTek capabilities are optional integrations. External tools and services are the primary
extension point for user agents. The user explicitly chooses and connects what the agent needs.

The default experience is:

> Start with a working agent → add knowledge if needed → connect tools → test in text → deploy to
> channels.

## 2. Non-negotiable boundaries

| Agent mode | Default tools | Default context | Default identity |
| --- | --- | --- | --- |
| Protected KasiAi (`system_hosted`) | KasiAi’s managed KasiTek capability pack | KasiAi instructions, protected knowledge, and KasiAi-scoped preferences | KasiTek platform guidance agent |
| Hosted user agent (`kasitek_hosted`) | None | Its own instructions, knowledge, conversation history, and explicitly selected integrations | User-defined agent |
| External connected agent (`external_connected`) | None inside the hosted runtime | Its external runtime; KasiTek access only through explicit MCP/REST installation grants | External customer runtime |

The implementation must preserve these rules:

- [ ] Only the protected system installation may receive KasiAi defaults automatically.
- [ ] A normal hosted user agent receives no `kasitek.core.*` capability automatically.
- [ ] A normal hosted user agent receives no generic platform tool automatically, including
  `platform.current_time`; time and locale may be supplied as non-authorizing runtime metadata when
  required, but must not become an implicit grant.
- [ ] A normal hosted user agent receives no KasiAi prompt, fallback response, protected knowledge,
  KasiAi preference, or KasiAi memory.
- [ ] A user agent with no tools and no knowledge remains valid and testable.
- [ ] KasiTek tools can be enabled only through an explicit integration/grant action and remain
  installation-scoped, auditable, and subject to normal authorization.
- [ ] External connector grants remain separate from KasiTek capability grants.
- [ ] Channel connections are deployment choices, not implicit tool grants.

## 3. Current implementation gap

The current low-configuration path still assumes that a hosted general agent should know about the
KasiTek workspace:

- `agents/src/system/hosted-agent-defaults.ts` supplies a broad `kasitek.core.*` read pack.
- `client/apps/client/src/components/dashboard/agents/create-general-agent-page-client.tsx`
  duplicates that pack in the browser and writes it into every new general agent version.
- `resolveHostedAgentAllowedTools` falls back to that pack when a general version has no requested
  tools.
- Several custom templates still include `platform.current_time` as a default capability.
- The capability UI is designed around selecting KasiTek services instead of connecting optional
  external tools.

The first implementation task is to remove these implicit defaults without changing the protected
KasiAi bootstrap path. That default-access change is now implemented; the remaining lifecycle gaps
below are still pending.

The same boundary must also hold after creation. A hosted user agent needs a complete lifecycle for
publishing, installation rollout, external connector execution, channel routing, retry, recovery,
and scheduling. A version that is correct in the database but is not deployed or cannot recover
from dispatch failure is not a usable agent.

## 4. Execution order

Work through these batches in order. A later batch may be developed behind a disabled feature flag,
but it must not be presented as available until its earlier dependencies are complete.

### Batch 1 — Remove implicit KasiTek identity and access

- [x] Make the server the only authority for default tool policy. (`agents/src/system/hosted-agent-defaults.ts`)
- [x] Return an empty tool set for every ordinary `kasitek_hosted` agent unless tools were explicitly
  selected.
- [x] Remove browser-owned `kasitek.core.*` defaults and KasiTek-branded starter instructions.
- [x] Keep the protected KasiAi bootstrap and release policy unchanged. (`agents/src/system/kasiai.ts`)
- [ ] Validate all persisted tool names against the registered tool catalog and the definition's
  execution mode.
- [x] Prove the zero-tool policy at the unit boundary. (`agents/test/hosted-agent-defaults.test.ts`)
- [ ] Prove that a zero-tool, zero-knowledge user agent can be created, published, installed, and
  tested successfully in a seeded integration environment.

### Batch 2 — Enforce agent-local context and data ownership

- **Progress:** Model-facing context no longer includes opaque organization, agent, version,
  installation, actor, or run identifiers. Knowledge/memory wildcard visibility and database
  invariants remain pending.

- [ ] Make agent-local knowledge, memory, conversations, instructions, and grants the default.
- [ ] Replace nullable organization-wide knowledge and memory visibility with explicit shared-source
  attachments or an explicit organization-shared selection.
- [x] Remove organization, installation, version, run, and actor identifiers from model prompts
  unless the model requires a specific identifier to complete the request.
- [ ] Add database invariants proving that each version belongs to its definition and each run's
  version and installation belong to the same definition and organization.
- [ ] Prevent one definition from mixing `system_hosted`, `kasitek_hosted`, and
  `external_connected` installations.
- [ ] Reserve the protected sidebar connection and protected system identity for KasiAi.

### Batch 3 — Complete model and durable-run reliability

- **Progress:** The normal bounded agent loop now attempts explicitly configured fallback models;
  configured workflow-node execution and fleet-wide breaker state remain pending.

- [ ] Separate credential-local model failures from provider/model-wide failures in circuit-breaker
  keys and failure classification.
- [ ] Execute the configured fallback model when policy permits it; record every attempt and the
  selected funding source.
- [ ] Reject or conservatively price models missing from the pricing catalog instead of treating
  their cost as zero.
- [ ] Add hard abort timeouts, cancellation, jittered retry, and `Retry-After` handling to model
  calls.
- [ ] Split model calls, tool calls, completion, and channel delivery into retry boundaries that do
  not repeat the whole agent loop after a timeout.
- [ ] Add Temporal heartbeats to long-running activities and distinct retry policies per activity
  class.
- [ ] Add a durable dispatch outbox or reconciler that starts persisted `received` and
  `run.dispatch_failed` runs idempotently.

### Batch 4 — Add real publish and deployment semantics

- [ ] Keep draft versions mutable only through creation of a new immutable revision.
- [ ] Publish an immutable version without silently moving existing installations.
- [ ] Add an explicit rollout operation for selected installations with optimistic concurrency,
  audit attribution, and idempotency.
- [ ] Show draft, published, and currently deployed versions separately in the client.
- [ ] Support rollback to a previously published version.
- [ ] Prevent fixed template slugs from blocking multiple agents created from the same template.
- [ ] Do not automatically bind ordinary template installations to the protected platform sidebar.

### Batch 5 — Build provider-neutral executable connectors

- [ ] Separate connector catalog entries, connector instances, credentials, installation grants,
  and executable tool adapters in the data and runtime model.
- [ ] Dynamically expose only tools backed by a healthy connector instance granted to the current
  installation.
- [ ] Execute connectors through dedicated activities with scoped credential references, bounded
  output, idempotency, rate limits, retry classification, and reconciliation.
- [ ] Implement one complete non-KasiTek connector end to end before generalizing the adapter SDK.
- [ ] Keep optional KasiTek services in the same user-facing integration flow but under their own
  authorization and core-owned execution boundary.
- [ ] Do not treat a connector manifest or saved grant as proof that its actions are executable.

### Batch 6 — Make channel routing safe for multiple agents

- [ ] Scope external identities and channel bindings by the concrete channel connection/provider
  account, not only by organization and channel type.
- [ ] Include the channel connection and provider-specific conversation identity in inbound message
  deduplication keys where provider IDs are not globally unique.
- [ ] Bind channel conversations to one explicit installation and retain that routing decision for
  the conversation lifetime.
- [ ] Add automatic retry and stale-attempt reconciliation for retryable outbound delivery failures.
- [ ] Verify that the same external user can talk to two different bots in one workspace without
  conversation, deduplication, or installation collisions.

### Batch 7 — Finish schedules and shared-worker controls

- [ ] Execute stored schedules through Temporal schedules or a durable schedule dispatcher.
- [ ] Define whether a schedule follows the installation's current version or pins a published
  version, and show that choice in the UI.
- [ ] Apply concurrency admission consistently to browser, channel, API, retry, and scheduled runs.
- [ ] Make worker concurrency environment-configurable and add workload-class queues where model,
  connector, channel, or long-running work needs independent capacity.
- [ ] Add per-organization, provider, and credential bulkheads so one tenant cannot exhaust the
  shared worker fleet.
- [ ] Extend readiness and metrics to cover Temporal connectivity, worker polling, queue delay,
  dispatch backlog, provider health, connector health, and core dependency health.

### Deferred — Untrusted code and custom node packages

Custom agents may use the trusted declarative workflow nodes implemented by the platform. Arbitrary
JavaScript, Python, shell commands, uploaded packages, and user-defined executable node packages are
out of scope for the batches above.

- [ ] Do not execute untrusted code inside the Agent API or shared Temporal worker processes.
- [ ] Before enabling code nodes, design an ephemeral sandbox execution service with no implicit
  database, internal-network, environment-variable, filesystem, or credential access.
- [ ] Require explicit secrets, network policy, CPU, memory, wall-time, output-size, cancellation,
  package, audit, and per-workspace concurrency controls.
- [ ] Keep code-node capability disabled until sandbox threat modelling and isolation verification
  are complete.

## 5. Target creation experience

### 5.1 Start with a configured baseline

- [ ] Replace the empty technical custom form with a provider-neutral starter template.
- [ ] Preconfigure a basic text workflow: text input → model → response.
- [ ] Give the agent a safe default instruction set that does not mention KasiTek or KasiAi.
- [ ] Use a safe model and runtime policy without requiring the user to understand providers,
  token budgets, workflow JSON, or authorization internals.
- [ ] Make the text test gateway available before any external tool or channel is connected.

### 5.2 Configure only what is meaningful to the user

- [ ] Ask for name and purpose.
- [ ] Allow optional knowledge pasted or uploaded for that agent.
- [ ] Keep conversation history automatically isolated per agent and conversation.
- [ ] Keep memory implementation platform-managed; expose only simple, high-level privacy/retention
  choices later if needed.
- [ ] Ask which external tools or services the agent should use.
- [ ] Offer KasiTek services as a clearly separated optional integration category.
- [ ] Offer channel deployment separately after the agent works in the text gateway.
- [ ] Keep raw instructions, model selection, runtime limits, workflow editing, and import/export in
  Advanced settings.

### 5.3 Tool and integration language

- [ ] Use user-facing names such as “Email”, “Calendar”, “CRM”, “Database”, “MCP server”, “REST
  API”, and “KasiTek workspace services”.
- [ ] Never require users to type capability identifiers such as `kasitek.core.content_post_publish`.
- [ ] Show each dependency as Connected, Needs connection, Requires approval, Unavailable, or
  Not selected.
- [ ] Explain what an integration permits and which actions are read-only, draft-only, or effectful.
- [ ] Keep credentials, scopes, and secret values inside their owning credential boundary.

## 6. Backend and data contracts

### 6.1 Default grants and profile enforcement

- [ ] Change hosted-agent default resolution so `kasitek_hosted` profiles return an empty requested
  tool set when no tools were explicitly selected.
- [ ] Remove the browser-owned default capability list from general-agent creation.
- [ ] Keep KasiAi’s managed capability list in its protected bootstrap/release path only.
- [ ] Ensure custom templates do not silently add platform or KasiTek tools; a template may declare
  an explicit external dependency or an optional KasiTek integration, but the user must select it.
- [ ] Make zero-tool versions and installations pass validation and readiness checks.
- [ ] Preserve explicit user-selected capabilities exactly, including their normal grant, scope,
  approval, entitlement, and audit checks.
- [ ] Bind every idempotency key to a canonical request fingerprint; reject reuse with a different
  payload.

### 6.2 Provenance and migration metadata

- [ ] Record whether a tool grant came from a protected system default, a template requirement, an
  explicit user selection, or an administrator action.
- [ ] Add enough version/grant provenance to distinguish legacy implicit grants from intentional
  selections.
- [ ] Treat unresolved legacy grants as a migration review item rather than silently guessing the
  user’s intent.
- [ ] Keep the KasiAi definition and installation out of the hosted-user migration.

### 6.3 Context and memory isolation

- [ ] Build runtime context from the selected agent definition/version only.
- [ ] Load knowledge and durable memory by agent and installation scope.
- [ ] Apply KasiAi preferences, protected knowledge, and platform guidance only when the protected
  KasiAi identity check succeeds.
- [ ] When no tools are authorized, expose an empty tool list to the model and produce a normal
  model response rather than a KasiTek fallback response.
- [ ] Ensure agent instructions, tool results, memories, and conversation records cannot cross into
  another user agent.
- [ ] Keep provenance and usage records accurate even for tool-less runs.
- [ ] Use explicit attachment records for organization-shared knowledge and memory rather than
  interpreting a nullable agent identifier as permission for every agent.

## 7. External integration model

### 7.1 Connector registry

- [ ] Define connector metadata for owner, authentication method, required scopes, actions, health,
  rate limits, and supported agent profiles.
- [ ] Support external connector categories independently of `kasitek.core.*` capabilities.
- [ ] Support the integration mechanisms that are actually available in the release: connector
  adapters first, then MCP/REST/OpenAPI/webhook adapters where their contracts and security gates
  are complete.
- [ ] Do not display an integration as available until its provider, credentials, and scopes are
  ready.
- [ ] Distinguish catalog availability, configured connection, granted installation access,
  executable runtime readiness, and current health.

### 7.2 Optional KasiTek integrations

- [ ] Present KasiTek contacts, inbox, bookings, content, campaigns, and workspace data under one
  explicit “KasiTek services” area.
- [ ] Require an explicit selection before granting any KasiTek capability.
- [ ] Apply role, resource, provider, approval, idempotency, and audit policy exactly as for every
  other agent installation.
- [ ] Keep protected KasiAi access separate; selecting a KasiTek service must not turn the agent
  into KasiAi.

### 7.3 Channels

- [ ] Treat the internal text gateway as the default test/input channel with no credential setup.
- [ ] Keep WhatsApp, Telegram, Discord, website chat, webhook, and API deployment connections in a
  separate Channels/Deploy section.
- [ ] Bind each channel to the selected agent installation, not to KasiAi or the workspace in
  general.
- [ ] Keep inbound/outbound channel permissions separate from tool permissions.
- [ ] Route inbound messages from the verified provider connection before resolving the external
  identity or installation.

## 8. Runtime safety and behavior

- [ ] A tool-less agent answers as a normal configured LLM and does not claim to be a KasiTek
  workspace assistant.
- [ ] A knowledge-less agent can still chat; it must state uncertainty instead of inventing
  agent-specific facts.
- [ ] A missing integration produces a precise “connection required” result only when the user asks
  for an action that needs it.
- [ ] External effects remain approval-gated where required, regardless of whether the connector is
  internal or external.
- [ ] Retries remain idempotent and cannot duplicate an external effect.
- [ ] Tool, connector, memory, and channel failures remain attributable to the correct agent.
- [ ] Responses, traces, and activity views must not leak hidden prompts, credentials, or unrelated
  KasiAi context.
- [ ] Provider retries, Temporal retries, manual retries, and reconciliation share one durable
  idempotency boundary and cannot duplicate model-visible effects.
- [ ] Declarative workflow execution enforces one shared step, iteration, fan-out, token, tool-call,
  model-call, and wall-time budget across all branches.
- [ ] Edge iteration limits are enforced, fan-out has bounded concurrency, and every advertised
  workflow node has a wired runtime implementation before it is selectable.

## 9. Migration of existing hosted agents

- [ ] Inventory all non-system hosted installations that currently have the implicit general
  capability pack.
- [ ] Classify each grant as explicit, template-required, administrator-added, or legacy implicit.
- [ ] Do not modify the protected KasiAi installation.
- [ ] For legacy implicit grants, show the owner which KasiTek services would be removed and provide
  an explicit “keep selected services” migration action.
- [ ] Publish a provider-neutral version for agents that do not retain those services.
- [ ] Preserve intentional external connectors and explicit KasiTek selections.
- [ ] Record migration decisions and resulting grant changes in the audit trail.
- [ ] Add a release report proving that newly created ordinary agents receive zero implicit KasiTek
  tools.

## 10. Verification checklist

### Unit and contract tests

- [x] New ordinary user agent with no requested tools produces `allowedTools: []`. (`agents/test/hosted-agent-defaults.test.ts`)
- [ ] New custom user agent with no selected integrations produces no default KasiTek grants.
- [ ] Protected KasiAi bootstrap still receives its managed tools.
- [ ] Explicitly selected external connector is persisted and authorized.
- [ ] Explicitly selected KasiTek capability is persisted, scoped, and audited.
- [ ] Zero-tool agent creation, publishing, installation, and testing all succeed.
- [ ] Runtime context for a user agent contains no KasiAi instructions, preferences, knowledge, or
  stale platform identity.
- [ ] Two user agents cannot read each other’s knowledge, memory, conversations, or tool grants.
- [x] A tenant-specific credential failure does not open another tenant's model circuit. (`agents/test/model-adapters.test.ts`)
- [ ] Configured model fallback executes only under its stated funding and policy rules.
- [ ] A timed-out model call cannot cause an already recorded external effect to execute again.
- [ ] Version, installation, definition, execution mode, and organization mismatch attempts fail at
  the database boundary.

### Integration and UI tests

- [ ] Create a user agent, skip integrations, and complete a text conversation successfully.
- [ ] Connect one external tool and verify only its declared actions are visible.
- [ ] Add a KasiTek integration explicitly and verify the selected capability appears with its
  readiness and approval state.
- [ ] Connect a channel after the text gateway works and verify messages remain scoped to that
  installation.
- [ ] Refresh/resume the builder without losing agent identity, knowledge, or connection choices.
- [ ] Verify the UI never presents raw KasiTek capability names as required setup for a normal user
  agent.
- [ ] Publish a new version, verify the current installation remains pinned, roll it out explicitly,
  and roll it back.
- [ ] Interrupt dispatch after run persistence and verify the dispatcher eventually starts the run
  exactly once.
- [ ] Run one scheduled agent invocation and verify its selected version and conversation ownership.
- [ ] Use two provider accounts of the same channel type with the same external user identifier and
  verify that routing and deduplication remain separate.
- [ ] Exercise a real external connector through discovery, credential setup, grant, execution,
  retry, receipt, and revocation.

### Release verification

- [ ] Agent API, worker, client typecheck, lint, and targeted runtime tests pass.
- [ ] Migration dry run is reviewed before changing existing installations.
- [ ] Capability, connector, memory, channel, audit, and user-facing documentation are updated.
- [ ] The creation-type plan is updated to link this provider-neutral boundary as a required
  sub-plan.
- [ ] Database-backed and Temporal-backed isolation, dispatch recovery, rollout, schedule, channel,
  and connector tests run in a seeded integration environment; infrastructure-gated skips do not
  count as release evidence.
- [ ] REST/MCP route inventories and generated conformance evidence match the implemented routes.

## 11. Acceptance criteria

This plan is complete when all of the following are true:

1. A normal user can create and test a useful agent without selecting or connecting any KasiTek
   service.
2. The resulting version and installation contain no implicit `kasitek.core.*` or platform tool
   grants.
3. The agent behaves as its own configured assistant, not as KasiAi.
4. External tools are opt-in, independently scoped, and visible through a clear connector flow.
5. KasiTek services are available as optional integrations without changing the agent’s identity.
6. Channels are optional deployment targets and remain separate from tool authorization.
7. KasiAi retains its protected defaults and behavior.
8. Existing installations are migrated with explicit, auditable decisions rather than silent access
   changes.
9. Publishing and deploying are distinct, visible operations with rollback.
10. Persisted runs recover from dispatch interruption without duplicate execution.
11. Connector catalog entries become agent tools only after a real, healthy, granted executor is
    available.
12. Channel routing and message idempotency remain correct across multiple agents and provider
    accounts in one workspace.
13. Schedules execute durably and shared workers enforce fair per-tenant and per-provider limits.
14. No untrusted code executes in shared Agent Platform processes.
