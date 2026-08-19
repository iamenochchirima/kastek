# KasiTek Agent Creation Types — Implementation Plan and Checklist

**Status:** In progress; profile split, general-purpose creation, and editable custom blueprint batch implemented

**Owner:** Agent Platform product, client, and runtime teams

**Scope:** Hosted user-agent creation and configuration UX

**Related active plans:**

- `KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md` — especially Slices 8, 9, 10, and 11
- `KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md` — installation, capability, approval, and
  user-experience boundaries
- `PROJECT_PLAN.md` — direct/white-label and KasiAi/external-agent ownership boundaries

## 1. Product decision

KasiTek will expose two hosted user-agent creation tracks. They share the same installation,
capability, approval, runtime, versioning, audit, and channel infrastructure, but they have
different setup experiences.

### 1.1 General-purpose agent

The general-purpose agent is the common, low-configuration agent. It is based on one canonical
general-assistant template and is intended to work across supported KasiTek surfaces and channels.

The user should only need to provide a name, purpose, a few behavior choices, optional knowledge,
and deployment targets. Model provider, workflow graph, runtime limits, credential mappings, and
other implementation details use safe defaults and remain available under advanced settings.

### 1.2 Custom/operational agent

The custom agent is for a defined business process. Custom templates such as support, lead intake,
booking, campaigns, content operations, and future domain agents are preconfigured custom-agent
blueprints, not a separate runtime type.

The custom experience must expose a guided builder with n8n-like concepts where necessary:
triggers, workflow nodes, tools, credentials, provider connections, data mappings, conditions,
approvals, schedules, tests, versions, and deployment.

### 1.3 Boundaries that must remain separate

- **KasiAi** remains the protected KasiTek platform agent. It is not created through either hosted
  user-agent flow.
- **Hosted user agents** use the two creation tracks in this document.
- **External agents** are operated elsewhere and use the dedicated external connection flow. They
  do not appear in the hosted-agent builder.
- **Channels and integrations** are deployment/configuration choices for an agent installation;
  they are not part of the external-agent connection wizard.
- “General-purpose” and “custom” describe setup complexity, not authorization. Both still use
  installation grants, role checks, resource scopes, approval rules, and core-domain authorization.

## 2. Goals and non-goals

### Goals

- [x] Make the general-purpose path usable without knowledge of models, workflows, or agent
  internals.
- [ ] Make the custom path capable of configuring real credentials, tools, workflows, channels,
  and provider effects without hiding important safety decisions.
- [x] Reuse the existing Agent Platform runtime instead of creating a second execution path. The
  first profile-aware flows use the existing definition, version, publication, installation, and
  runtime APIs.
- [x] Add explicit profile metadata so custom templates can be identified as custom blueprints and
  general-purpose agents can be identified without special runtime paths.
- [ ] Let users save progress, test before activation, publish versions, and return to previous
  configuration steps.
- [ ] Present capabilities in human terms while retaining exact internal capability identifiers in
  the underlying manifest and audit records.
- [ ] Make approval behavior visible before a user enables an effectful capability.

### Non-goals

- [ ] Do not turn KasiAi into a user-configurable hosted agent.
- [ ] Do not merge external-agent credentials or MCP setup into hosted-agent creation.
- [ ] Do not bypass capability, role, provider, entitlement, resource, or approval checks for a
  general-purpose agent.
- [ ] Do not create a second workflow or connector runtime for the new UI.
- [ ] Do not require users to configure a visual workflow for a general-purpose agent.
- [ ] Do not silently enable real provider effects merely because a user selected a template.

## 3. Target information architecture

### 3.1 Agents overview

- [ ] Keep one `/agents` product area for all agent operations.
- [ ] Give the overview explicit sections or filters for KasiAi, hosted agents, and external
  connections.
- [x] Make the primary hosted-agent actions visibly distinct:
  - [x] `Create general-purpose agent`
  - [x] `Build custom agent`
- [x] Keep `Connect external agent` as a separate action and route.
- [x] Keep templates discoverable from the custom-agent path rather than presenting KasiAi as a
  selectable custom template.
- [ ] Show each hosted agent’s type, lifecycle status, deployment/channel summary, capability
  readiness, and recent activity without exposing raw runtime internals on the overview card.

### 3.2 Hosted-agent detail area

- [ ] Provide consistent sections/tabs for Overview, Behavior, Knowledge, Capabilities, Connections,
  Channels, Workflows, Test, Activity, Versions, and Usage.
- [ ] Put model provider, token ceilings, raw instructions, slug, import/export, and other expert
  controls under Advanced settings.
- [ ] Keep installation-specific grants and channels visibly separate from the agent definition.
- [ ] Show whether a capability is read-only, draft-safe, approval-gated, unavailable, or blocked
  by the current role/provider state.

## 4. General-purpose agent flow

The general flow should be a short guided wizard. It should create a useful draft with defaults,
not present the user with an orchestration console.

### Step 1 — Name and purpose

- [x] Collect a display name.
- [x] Ask what the agent should help with in plain language.
- [ ] Offer optional role suggestions such as assistant, support guide, sales helper, or operations
  assistant.
- [ ] Generate starter instructions from the purpose while keeping them editable.
- [ ] Keep slug/API identity optional and advanced.

### Step 2 — Knowledge

- [ ] Support website URL, file upload, and pasted reference text where the existing knowledge
  boundary permits them.
- [ ] Allow the user to skip knowledge and add it later.
- [ ] Show ingestion/progress state and source health without blocking the rest of the setup when
  ingestion is asynchronous.
- [ ] Preserve source ownership, installation scope, provenance, deletion, and revalidation rules.

### Step 3 — Behavior

- [x] Provide concise behavior controls: tone and response detail.
- [ ] Add greeting and starter-question controls.
- [ ] Show a short generated behavior summary instead of forcing the user to read a large prompt.
- [ ] Provide an explicit advanced editor for full instructions.
- [ ] Explain that capabilities and approvals control what the agent can actually do.

### Step 4 — Capabilities

- [ ] Start with a safe read/draft capability pack appropriate for a general assistant.
- [ ] Group capabilities by user outcome: workspace information, contacts, inbox, content,
  bookings, campaigns, and channels.
- [ ] Use human-readable labels and descriptions; keep raw tool names in an expandable detail view.
- [ ] Mark consequential writes with “Approval required” before selection.
- [ ] Disable capabilities that the user’s role, installation, provider, or entitlement cannot grant.
- [ ] Persist explicit installation grants and resource scopes through the existing authorization
  boundary.

### Step 5 — Test

- [ ] Provide a real test conversation before activation.
- [ ] Include suggested questions relevant to the selected purpose.
- [ ] Show safe tool activity, capability denials, approval pauses, and effect receipts without
  exposing chain-of-thought, credentials, or hidden instructions.
- [ ] Allow the user to return to Behavior, Knowledge, or Capabilities from the test screen.

### Step 6 — Deploy

- [ ] Offer workspace chat first.
- [ ] Offer supported channel and integration targets from the agent’s deployment area.
- [ ] Keep website/share-link/API/MCP choices clear and separate from the hosted-agent build form.
- [ ] Let the user save as draft or activate the installation.
- [ ] Show a concise activation summary: agent, installation, enabled capabilities, channels, and
  pending configuration.

## 5. Custom-agent flow

The custom flow may be longer, but it must still be progressive and understandable. It should feel
like a guided automation builder, not a raw JSON editor.

### Step 1 — Choose a blueprint

- [x] Offer `Blank custom agent`.
- [x] Offer custom templates such as support, lead intake, booking, content operations, and
  campaign operations as they become real.
- [x] Explain each template by outcome, required connections, capabilities, and expected setup.
- [x] Show which parts are preconfigured and which parts the user must provide.
- [x] Keep the canonical general-purpose template outside this custom blueprint list.

### Step 2 — Define the agent

- [ ] Collect name, purpose, audience, and success outcome.
- [ ] Generate a usable starting instruction set and workflow from the selected blueprint.
- [ ] Allow advanced users to edit full instructions, model policy, runtime limits, and metadata.
- [ ] Keep draft creation separate from publishing and activation.

### Step 3 — Configure resources and credentials

- [ ] List every required connection and credential with its owner, status, and purpose.
- [ ] Support selecting an existing connection, creating a new connection, or leaving a required
  item pending.
- [ ] Keep secrets in the credential boundary; show only safe names, status, last use, expiry, and
  rotation/revocation actions.
- [ ] Validate provider readiness and required scopes before the workflow can be activated.
- [ ] Clearly distinguish a missing credential from a denied capability or an unhealthy provider.

### Step 4 — Build the workflow

- [ ] Reuse the existing workflow graph and runtime contracts.
- [ ] Provide a visual editor with triggers, model steps, tools, conditions, fan-out/fan-in,
  approvals, waits, handoffs, schedules, and external events as supported node types.
- [ ] Provide safe starter graphs for each custom template.
- [ ] Validate graph reachability, input/output contracts, loops, required credentials, capability
  grants, approval nodes, and runtime limits.
- [ ] Allow users to inspect an individual node’s inputs, outputs, capability, credentials, and
  failure/retry behavior without exposing provider secrets.
- [ ] Keep import/export bounded, versioned, and secret-safe.

### Step 5 — Configure capabilities and approval

- [ ] Present capability selection in outcome language first, with raw manifest details available
  on demand.
- [ ] Show which tools are read, draft-safe, controlled-write, external-effect, or privileged.
- [ ] Require explicit selection for consequential writes and preserve the shared exact-preview,
  hash, expiry, reauthorization, idempotency, and receipt behavior.
- [ ] Make role/installation/resource restrictions visible before publish.
- [ ] Fail closed when a required capability, provider, or approval policy is missing.

### Step 6 — Test and debug

- [ ] Provide a full test conversation for the agent.
- [ ] Allow test runs from the whole graph and from eligible individual nodes.
- [ ] Display concise run steps, tool activity, approval state, provider results, retries, and
  failures.
- [ ] Allow safe retry after correcting configuration without duplicating an effect.
- [ ] Provide connection tests that never expose credentials.
- [ ] Keep test data and real external effects clearly distinguished; require approval for real
  effects according to the shared policy.

### Step 7 — Review, publish, and deploy

- [ ] Provide a review summary of instructions, workflow, capabilities, credentials, channels,
  schedules, limits, and approval behavior.
- [ ] Block activation only on real missing requirements and explain each blocker inline.
- [ ] Create a versioned draft first; publish only after review.
- [ ] Install or update the workspace installation explicitly.
- [ ] Support rollback, pause, resume, and retirement through existing lifecycle APIs.
- [ ] Link the deployed version to activity, usage, approvals, and recovery history.

## 6. Backend and contract work

- [x] Add an explicit creation/profile discriminator, `general`, `custom`, or protected `system`,
  to the hosted-agent definition contract.
- [x] Add template metadata describing profile, category, required capabilities, required
  connections, and setup steps.
- [x] Preserve ordinary version/installation semantics; do not introduce a second runtime.
- [ ] Add draft-save/resume semantics for multi-step creation, including safe server persistence or
  a bounded client recovery mechanism.
- [x] Add APIs for wizard readiness: missing knowledge, missing credentials, unavailable
  capabilities, invalid workflow, and deployment blockers.
- [ ] Ensure general-agent defaults are represented as normal versioned configuration rather than
  hidden special cases.
- [x] Ensure custom-template installation produces an inspectable ordinary definition/version.
- [ ] Keep capability grants, resource scopes, connectors, and approvals installation-scoped.
- [ ] Keep provider credentials out of prompts, workflow history, traces, MCP output, and agent
  records except opaque references and safe metadata.
- [ ] Preserve core ownership of direct-product business authorization and provider effects.
- [ ] Update REST/MCP discovery and capability metadata only where the new profile/template
  contracts are externally visible; transport adapters must continue using shared policy.

## 7. Frontend implementation work

- [x] Replace the current single dense custom-agent form with a profile-selection entry point.
- [ ] Build a reusable wizard shell with progress, back navigation, save/resume, validation, and
  responsive/mobile behavior.
- [ ] Build the general-purpose wizard with only the low-configuration steps.
- [ ] Reuse the wizard shell for custom setup while embedding the workflow/configuration builder
  only where required.
- [ ] Move technical model, runtime, slug, raw instruction, import/export, and graph controls into
  advanced sections.
- [ ] Replace raw capability cards with grouped, human-readable capability choices and clear
  approval badges.
- [x] Add a template preview showing purpose, included behavior, required connections, capabilities,
  and estimated setup work.
- [x] Add knowledge-source progress, credential readiness, workflow validation, and deployment
  readiness states.
- [ ] Add test-chat previews for both profiles.
- [ ] Make errors actionable and local to the step that caused them.
- [ ] Add empty, loading, stale, degraded, denied, and retry states.
- [ ] Preserve accessibility: keyboard navigation, labels, focus management, status announcements,
  contrast, and reduced-motion behavior.

## 8. Migration and compatibility

- [ ] Map existing hosted agents without a profile to `custom` or `general` using an explicit,
  reviewable migration rule.
- [ ] Do not silently change existing instructions, model policy, grants, credentials, channels,
  schedules, or published versions.
- [ ] Keep the current details page available while users transition from the old creation form.
- [ ] Allow existing workflow graphs to open in the custom builder without data loss.
- [ ] Preserve existing template keys and convert them into the new custom-template metadata
  format where possible.
- [ ] Keep KasiAi installation records out of the hosted-agent profile migration.
- [ ] Keep external installation records out of the hosted-agent profile migration.
- [ ] Add a feature flag or controlled rollout path for the new creation experience.
- [ ] Provide a rollback path for frontend/API rollout without invalidating existing versions.

## 9. Verification checklist

### Product and component tests

- [ ] General-purpose creation can complete with only name and purpose plus defaults.
- [ ] General-purpose creation never requires a workflow graph, provider model ID, or credential
  mapping.
- [ ] Custom blank creation exposes required configuration progressively.
- [x] Each custom template preloads the expected behavior, graph, capability hints, and connection
  requirements.
- [x] Installation readiness combines deployment, workflow, capability, connection, and model
  credential checks into one actionable status contract.
- [ ] Users can save, refresh, resume, go backward, and recover from a failed step.
- [ ] Capability labels and approval indicators match the server manifest.
- [ ] Unavailable capabilities cannot be selected or activated.
- [ ] Test chat preserves installation and organization boundaries.
- [ ] Activation summaries accurately describe pending and active configuration.

### Runtime and security tests

- [ ] General and custom profiles use the same authorization and tool invocation boundary.
- [ ] No profile bypasses role, organization, installation, resource, connector, entitlement, or
  provider checks.
- [ ] Consequential effects still require the shared exact approval flow.
- [ ] Draft-safe actions do not create unnecessary approval pauses.
- [ ] Approval previews contain the exact proposed action and no credentials or unsafe content.
- [ ] Published versions are immutable and installation updates are auditable.
- [ ] Workflow imports cannot introduce undeclared tools, credentials, nodes, or capabilities.
- [ ] Retry and recovery cannot duplicate an external effect.
- [ ] KasiAi and external-agent routes cannot be reached through hosted-agent creation APIs.

### Integration and end-to-end tests

- [ ] Create a general-purpose agent, add knowledge, test it, activate it, and use it in workspace
  chat.
- [ ] Create a general-purpose agent and deploy it to a supported channel with the existing
  channel binding flow.
- [ ] Create a custom agent from blank, configure a credential, build a workflow, test it, publish
  it, and roll it back.
- [ ] Create each enabled custom template through setup, test, publish, channel use, approval,
  effect, activity, and rollback.
- [ ] Verify missing credentials, missing capabilities, unhealthy providers, denied roles, and
  invalid workflows produce actionable blockers.
- [ ] Verify refresh/reconnect during every wizard phase.
- [ ] Verify KasiAi remains protected and external-agent connection remains separate.
- [ ] Run client lint, typecheck, production build, Agent Platform tests, database/Temporal tests,
  and authenticated browser smoke tests.

## 10. Completion criteria

This plan is complete when:

- A non-technical user can create and deploy a useful general-purpose agent without seeing
  workflow, credential, or model internals.
- An advanced user can build a custom operational agent with the required credentials, tools,
  workflow nodes, approvals, schedules, channels, tests, versioning, and rollback controls.
- Custom templates are real editable blueprints, not cosmetic tone presets.
- Both profiles use the same durable runtime, capability authorization, approval, audit, and effect
  recovery system.
- KasiAi, hosted user agents, and external agents are unmistakable in the product and cannot be
  configured through the wrong flow.
- Existing agent definitions, installations, credentials, channels, schedules, and published
  versions remain compatible and recoverable.
- Browser, integration, security, and production verification gates are recorded before the new
  creation experience becomes the default.

## 11. Recommended delivery order

1. [x] Confirm product copy, profile naming, and the boundary between hosted, KasiAi, and external
   agents.
2. [x] Add profile/template metadata and readiness contracts without changing runtime behavior.
3. [x] Build the shared wizard shell and general-purpose flow.
4. [x] Move the existing simple agent defaults behind the general-purpose profile.
5. [x] Build the custom blueprint chooser and migrate existing templates.
6. [ ] Integrate credentials, capability readiness, and deployment blockers into the custom flow.
7. [x] Embed the existing workflow editor as the custom-agent builder rather than requiring it for
   every agent.
8. [ ] Add test-before-activation, review, publish, rollback, and recovery UX.
9. [ ] Add migration, feature flagging, component tests, integration tests, and browser smoke tests.
10. [ ] Roll out gradually, compare completion/error rates, and only then retire the old dense form.
