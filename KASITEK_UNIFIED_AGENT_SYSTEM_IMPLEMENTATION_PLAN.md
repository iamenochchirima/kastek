# KasiTek Unified Agent System Implementation Plan

**Status:** Active architecture and implementation checklist  
**Scope:** KasiAi, KasiTek-hosted user agents, and externally connected agents  
**Planning source:** [`KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`](KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md)  
**Initial mode:** broad capability access for controlled testing; commercial limits and granular
entitlements follow after end-to-end validation

## 1. Product outcome

KasiTek will provide one agent system with three execution modes and one common capability standard.

```text
KasiAi                 system_hosted       protected KasiTek platform agent
User-created agent     kasitek_hosted      general agent run by KasiTek
Connected external     external_connected  Codex, Claude Code, n8n, customer runtime
```

Every agent is represented as a versioned definition installed into a workspace. Every installation
has a non-human principal, durable runs, conversations, audit history, tools, memory, channels, and
an independent lifecycle. The selected execution mode changes who runs the reasoning loop, not the
platform data/access contract.

```text
                         Agent Installation
                     identity · policy · memory
                           tools · channels
                                  │
             ┌────────────────────┼────────────────────┐
             │                    │                    │
          KasiAi            Hosted user agent       External client
        KasiTek loop          KasiTek loop      Codex / Claude / n8n
             │                    │                    │
             └────────────────────┴────────────────────┘
                                  │
                     Capability Gateway / MCP adapter
                                  │
               content · campaigns · inbox · bookings · contacts
                                  │
                             kasitek-core
```

## 2. Fixed planning decisions

- [x] Use a single shared Agent Platform; do not create a separate runtime for KasiAi, templates,
  hosted user agents, or external agents.
- [x] Preserve the Waku pattern: thin channel gateways, a shared bounded runtime, tools, memory,
  tracing, and evaluations.
- [x] Let hosted user agents call both KasiTek capabilities and approved external connectors.
- [x] Treat KasiTek as one tool provider within general hosted agents, not as the boundary of what
  those agents may do.
- [x] Treat external agents as non-human installation identities that can operate without a human
  session.
- [x] Start external authentication with multiple named copy-once installation secrets, stored only
  as hashes and exchanged for one-hour access tokens refreshed before expiry.
- [x] Validate installation and credential status on every request for immediate suspension and
  revocation; credentials initially inherit installation grants and may only be narrowed later.
- [x] Audience-bind external tokens to the Agent Platform and use separate delegated internal
  authority for `kasitek-core`.
- [x] Add registered public-key client assertions before broad production availability.
- [x] Treat all controlled-test workspaces as highest-entitlement workspaces while recording complete
  usage and cost data from the first implementation.
- [x] Use an explicit `development_full_access` profile for implemented product capabilities, with
  hard exclusions for credentials, billing, organization privilege, workspace deletion, and all
  policy/audit bypass operations.
- [x] Keep external connector grants separately selected even when product capabilities are broadly
  enabled for testing.
- [x] Use one JSON-Schema-based capability registry as the source for internal tools, MCP, REST and
  OpenAPI, permission UI, documentation, audit descriptions, and future SDKs.
- [x] Use content/social as the first reference catalog, then contacts/inbox, bookings, campaigns,
  automations/agent administration, and workspace/reporting.
- [x] Standardize manifest metadata, cursor pagination, success/error envelopes, mutation receipts,
  semantic versioning, and capability availability states before domain implementation.
- [x] Use exact, single-use, 30-minute approvals for initial external effects, bound to immutable
  previews, capability version, arguments, resources, approver, installation, and organization.
- [x] Start with authenticated web approvals and durable polling/webhook/wait behavior; defer secure
  channel-native and standing approvals until individual approval is proven.
- [x] Require mutation idempotency, provider reconciliation after ambiguous outcomes, item-level
  batch results, audited compensation, execution-time approver reauthorization, and kill-switch
  cancellation.
- [x] Use asymmetric one-to-two-minute, per-invocation delegation tokens from Agent Platform to
  core; external tokens never pass through to core.
- [x] Keep typed domain endpoints and final authorization in core, including resource ownership,
  approver authority, business preconditions, and core-owned effect idempotency.
- [x] Use transactional outbox/action records for provider effects, signed versioned lifecycle
  events back to Agent Platform, and reconciliation before ambiguous retries.
- [x] Publish normal public REST at `api.kasitek.co.za/v1/*` and hosted MCP at
  `agents.kasitek.co.za/mcp`; keep core internal routes private where deployment permits.
- [x] Use remote Streamable HTTP initially, add a local stdio bridge later, and add legacy SSE or
  WebSocket transports only for demonstrated client compatibility or UX needs.
- [x] Define typed REST plus advanced generic invocation, OpenAPI 3.1, parity, installation
  webhooks, agent-readable documentation, and real MCP/REST client compatibility gates.
- [x] Use one durable AgentRun/Temporal model for all agent entry points, stable idempotency-derived
  workflows, bounded synchronous calls, durable effects/approvals/schedules, safe cancellation,
  ordered events, workload task queues, and object-storage media references.
- [x] Use user-owned personal-agent conversations and separate customer/thread-owned business-agent
  conversations within organization isolation; do not auto-merge channels or installations.
- [x] Keep channel gateways thin and standardize delivery, provider webhook, consent/opt-out, human
  handoff, attachment, and safe activity behavior across channels.
- [x] Establish trusted/untrusted context boundaries, minimal dynamic context, reviewed product
  knowledge, scoped namespaces, selective memory, lifecycle/export/support controls, injection evals,
  and provider-privacy attribution.
- [x] Define one shared Agents UX with guided hosted creation, external MCP/REST connection, detail
  workspaces, approval inbox, safe activity, usage tracking, credential controls, kill switches, and
  personal/business conversation visibility.
- [x] Define immutable audit, separate traces/metrics/logs, scoped visibility/support access,
  retention, usage attribution, health/alerts, hierarchical kill switches, exports/redaction, safe
  admin operations, and release evaluation governance.
- [x] Define the threat model, credential/replay/edge-core defense-in-depth, isolation, injection,
  minimization, abuse, webhook/SSRF, supply-chain, testing, and incident-response policies.
- [x] Make both the hosted KasiTek MCP server and a versioned REST API first-class interoperable
  surfaces for external agents and integrations.
- [x] Use MCP for agent-native discovery/invocation and REST for deterministic automations, n8n,
  scripts, SDKs, webhooks, and custom applications.
- [x] Generate both surfaces from the same capability contracts; neither adapter owns separate
  permissions or business handlers.
- [x] Keep the Capability Gateway as the business authorization authority; MCP is an adapter over
  it, never a bypass.
- [x] Keep `kasitek-core` authoritative for product data and final business action execution.
- [x] During controlled testing, enable broad capability access for test installations. Do not defer
  workspace isolation, credential security, audit, idempotency, durable run state, or core-side
  authorization.
- [x] Let read and draft tools run immediately during controlled testing, while requiring exact
  approval for real external effects such as publishing, sending, and booking confirmation.
- [x] Use content/social as the first end-to-end reference capability domain.
- [x] Start hosted-agent creation with a guided form over the durable workflow/graph model.
- [x] Treat the visual n8n-style custom-agent/workflow builder as an explicit later delivery phase,
  not an abandoned idea or a replacement runtime.
- [ ] Decide the first production entitlement and approval policy after the complete system is
  demonstrably testable.

## 3. Workstream map

The following workstreams can run in parallel only after the shared contracts in Phase 0 are stable.

| Workstream | Owns | Depends on |
|---|---|---|
| A. Control plane | definitions, installations, principals, credentials, grants | Phase 0 |
| B. Capability Gateway | manifests, delegated calls, receipts, core contracts | Phase 0 |
| C. KasiAi | grounded context, real tools, platform UI | A + B |
| D. Hosted user agents | builder, templates, connectors, channels, workflows | A + B |
| E. External APIs | remote MCP, REST/OpenAPI, webhooks, auth, SDKs, compatibility | A + B |
| F. Governance | audit, usage, approval, operational/admin views | A + B |
| G. Validation | contract/e2e/security/eval suite and release gates | all workstreams |

## 4. Phase 0 — Shared contracts and architecture baseline

No team implements product-domain tools before this phase is agreed and checked in.

- [ ] Define `execution_mode`: `system_hosted`, `kasitek_hosted`, `external_connected`.
- [ ] Define installation lifecycle: draft, active, suspended, revoked, archived/deleted.
- [ ] Define `AgentPrincipal`, installation ownership, actor attribution, and creator audit fields.
- [ ] Define common installation policy: model, budgets, tool grants, connector grants, channels,
  memory, schedules, workflows, and capability availability.
- [ ] Define a versioned `CapabilityManifest` with schema, risk, idempotency, output/error, and
  effect-receipt fields.
- [ ] Define a common `CapabilityInvocation` / `CapabilityResult` envelope used internally and by
  the MCP and REST adapters.
- [ ] Define durable action receipts: invocation ID, run ID, installation ID, effect ID, status,
  idempotency key, timestamps, and safe result summary.
- [ ] Define a standard external inbound/outbound channel envelope.
- [ ] Define the resource selector format used to constrain a capability to a workspace, connected
  account, booking service, campaign, contact segment, or object.
- [ ] Record ADRs for the installation identity/credential model, delegated core authorization,
  and hosted MCP transport.

**Exit gate:** one typed contract package is consumed by agent workers, core integration code, and
MCP code; no duplicate capability definitions.

## 5. Phase 1 — Agent control plane and installation identity

### A. Data model and API

- [ ] Add execution mode and lifecycle fields to agent definitions/installations.
- [ ] Add `AgentPrincipal` records tied one-to-one to installations.
- [ ] Add named installation credential records with hashed secret material, last use, expiration,
  rotation, revocation, and audit events.
- [ ] Support multiple credentials in the model; expose a simple primary-credential UI first.
- [ ] Add installation grants and resource constraints independent of agent-version grants.
- [ ] Add budgets, rate/concurrency values, and feature flags at installation level, initially with
  broad testing defaults.
- [ ] Persist usage counters/events for runs, models/tokens/cost, tools, external effects,
  connectors, channels/delivery, schedules, storage, failures, latency, and concurrency.
- [ ] Add the `development_full_access` profile with environment/operator gating and immutable hard
  exclusions.
- [ ] Add resource constraints and separate external-connection grants; default product resource
  constraints to the current workspace during controlled testing.
- [ ] Add authenticated APIs to create, list, view, update, suspend, resume, revoke, and archive
  installations.
- [ ] Add an Agent detail payload that combines definition, policy, credentials metadata, health,
  runs, channel bindings, and activity.

### B. Credential/token flow

- [ ] Generate copy-once installation secret credentials for controlled testing.
- [ ] Add an installation token-exchange endpoint that issues short-lived, audience-bound tokens.
- [ ] Set access-token lifetime to one hour and document automatic refresh approximately five
  minutes before expiry.
- [ ] Include installation, organization, credential, allowed scopes, resource constraints,
  expiry, and token audience in claims.
- [ ] Validate token issuer, signature, audience, expiry, installation status, credential status,
  and organization state on every request.
- [ ] Add token/client rate limits and audit every exchange.
- [ ] Add suspend/revoke behavior that invalidates future exchanges and active authorization.
- [ ] Add optional credential expiry and rotation reminders without forced expiry initially.
- [ ] Ensure credential grants inherit and can only narrow installation grants.
- [ ] Implement registered public keys and signed client assertions before broad production release.

**Exit gate:** a test runtime can independently obtain a short-lived token and is rejected after
credential rotation or installation suspension.

## 6. Phase 2 — Capability Gateway and core delegation

### A. Manifest registry and policy

- [ ] Extend the existing Agent Platform `ToolRegistry` into the authoritative platform capability
  registry without losing JSON-schema validation and tool invocation audit records.
- [ ] Generate or validate MCP definitions, REST/OpenAPI operations, permission UI metadata, and
  documentation from the shared registry.
- [ ] Add `requiredScopes`, resource selector validation, availability/entitlement predicates,
  effect semantics, and capability owner metadata to manifests.
- [ ] Provide a filtered discovery API based on the requesting installation identity.
- [ ] Centralize policy evaluation and return structured allow/deny reasons.
- [ ] Preserve broad testing grants behind explicit test configuration; never use a hidden
  “allow all” path in production code.

### B. Core boundary

- [ ] Implement signed/delegated internal requests from agents to `kasitek-core` containing the
  installation principal, organization, capability, constrained resource, invocation/run ID,
  idempotency key, and correlation ID.
- [ ] Add one-to-two-minute asymmetric delegation tokens, ES256/JWKS key discovery, audience
  validation, token-ID replay controls where needed, and overlapping key rotation.
- [ ] Reject external installation access tokens at core endpoints.
- [ ] Make core independently validate the delegated authority before any business operation.
- [ ] Add typed core capability handlers rather than agent access to core tables.
- [ ] Add a shared error taxonomy: validation, not found, denied, unavailable, conflict,
  confirmation-required, and effect-failed.
- [ ] Make each mutating core handler accept and enforce an idempotency key.
- [ ] Return durable effect receipts and provider delivery identifiers where relevant.
- [ ] Commit core state and outbox/action records atomically; process external effects durably and
  reconcile unknown provider outcomes.
- [ ] Emit signed, versioned capability/effect lifecycle events and consume them idempotently in the
  Agent Platform with polling as recovery.
- [ ] Propagate suspension/revocation/kill-switch state to core authorization caches and introspect
  highly consequential actions where required.

### C. First real capability catalog

- [ ] Workspace/connection: `connections.list`, `connections.get_health`.
- [ ] Content/social read: `content.list`, `content.get`, `content.publish_status`,
  `social.accounts.list`, `social.account.get`, `social.account.capabilities`, `social.posts.list`,
  `social.post.get`, and `social.comments.list`.
- [ ] Campaign read: campaigns, status, audiences, estimates.
- [ ] Contacts/inbox read: contact search/detail, conversation/message listing.
- [ ] Bookings read: services, availability, booking listing/detail.
- [ ] Automation/agent read: installations, runs, schedules, activity.
- [ ] Content draft tools: `content.draft.create`, `content.draft.update`, and
  `content.draft.delete`.
- [ ] Content/social action tools: `content.schedule`, `content.unschedule`, `content.publish`, and
  `social.comment.reply`, enabled only after the approval contract is proven.
- [ ] Later-domain draft tools: campaign drafts, inbox reply drafts, and booking proposals.
- [ ] Later-domain action tools: send/reply/create/confirm only after the approval contract is
  proven.

**Exit gate:** every first capability has a typed manifest, a core owner, an independent core
authorization check, contract tests, and an audit/effect receipt.

## 7. Phase 3 — Grounded KasiAi

- [ ] Replace generic product knowledge with a reviewed, versioned, authoritative KasiTek
  capability/navigation corpus.
- [ ] Remove unsupported “projects/resources/repositories” assertions from all KasiAi context.
- [ ] Build dynamic context from authenticated role, enabled modules, current route/entity,
  connected provider status, and actual available capabilities.
- [ ] Grant KasiAi the first real read tools through the common Capability Gateway.
- [ ] Add a tool-aware response policy: cite tool-derived facts plainly; state unavailable actions
  precisely; never claim an effect without a receipt.
- [ ] Add page-specific help and suggestions generated only from relevant available capabilities.
- [ ] Add a visible activity/tool-call presentation in the chat timeline.
- [ ] Add draft and action preview states when the relevant common capability becomes available.
- [ ] Add deterministic and adversarial evaluations for accurate capability claims, tenant
  isolation, tool selection, and refusal of unavailable operations.

### Context, knowledge, and memory controls

- [ ] Classify and label trusted policy/reference/data versus untrusted user, page, file, web,
  connector, and tool-output content before model context construction.
- [ ] Build minimal dynamic run context and demand-load detailed workspace data through capabilities.
- [ ] Replace generic KasiAi knowledge with reviewed/versioned/attributable real product knowledge
  owned by domains and use live tools for changing facts.
- [ ] Enforce bounded recent message windows, scoped rolling summaries, on-demand older history, and
  separate conversation/user_private/organization_shared/agent_private namespaces.
- [ ] Add selective memory creation with provenance/confidence/consent/edit/delete behavior and
  explicit external-agent memory capabilities.
- [ ] Implement conversation-summary/memory deletion, organization memory administration, backup
  retention, workspace data export, and time-bound audited support access.
- [ ] Add prompt-injection sanitization/boundaries and adversarial evaluations for untrusted content.
- [ ] Attribute model/provider privacy settings and minimize model-bound data by policy.

**Exit gate:** KasiAi answers real product questions from trusted knowledge/tools and performs only
confirmed actions through common capability contracts.

## 8. Phase 4 — KasiTek-hosted user agents

### A. Agent creation and configuration

- [ ] Build a general agent-definition model: instructions, model policy, capability grants,
  connector grants, channels, knowledge/memory, schedules, and workflows.
- [ ] Build a hosted-agent creation wizard with a simple first release: name, purpose,
  instructions, model, capabilities, and channels.
- [ ] Include external connections, knowledge/memory, schedules, and available workflows in the
  guided configuration as those shared subsystems become ready.
- [ ] Add official templates as optional preconfigured definitions, not separate runtimes.
- [ ] Add immutable versioning, draft/publish/rollback, and safe installation updates.
- [ ] Build agent detail pages for configuration, activity, runs, memory, credentials, channels,
  schedules, and health.
- [ ] Build common installation detail tabs: Overview, Configuration, Capabilities, Connections,
  Channels, Conversations, Activity/Runs, Approvals, Memory/Knowledge, Schedules/Workflows,
  applicable Credentials, and Usage.

### B. External connector provider layer

- [ ] Define provider-neutral connector manifests separate from KasiTek capability manifests.
- [ ] Add credential vault references and OAuth/API-key connection ownership.
- [ ] Start with the external connectors required by selected templates; do not add generic
  connector breadth without a real use case.
- [ ] Add external tool schemas, output redaction, rate limits, retry policy, and audit receipts.
- [ ] Keep connector credentials unavailable to model prompts, traces, workflow history, and MCP
  clients.

### C. Channels and workflows

- [ ] Reuse the standard channel envelope for browser, WhatsApp, Telegram, Discord, and future
  providers.
- [ ] Encode personal user-owned versus business customer/thread-owned conversation identity and
  access rules; keep external-agent conversations opt-in while always recording their runs.
- [ ] Prevent browser new chats from falling back to external channel-default chats and prohibit
  automatic cross-channel/customer or cross-installation conversation merging.
- [ ] Complete Telegram and Discord adapters as thin channel adapters over the shared runtime.
- [ ] Add email after Telegram/Discord, and defer voice until speech/media policy is ready.
- [ ] Persist reply-before-delivery, delivery attempts/provider IDs/status webhooks, manual recovery,
  channel consent/opt-out, audited human handoff/pause/resume, secure attachment normalization, and
  verified/deduplicated fast-ack webhooks.
- [ ] Add workflow/schedule triggers and Temporal durability to hosted user agents.
- [ ] Add deterministic human handoff/escalation routing where a template requires it.

**Exit gate:** a user can build/install a general hosted agent that uses both one KasiTek capability
and one external connector, receives a channel message, and produces an audited result.

### D. Planned visual custom-agent builder

This is a committed later product phase. It must use the same versioned definitions, capability
manifests, connector manifests, graph workflows, execution engine, approvals, and audit records as
the guided form.

- [ ] Design an n8n-style canvas for triggers, model/agent steps, KasiTek capabilities, external
  connector tools, conditions, approvals, delays, schedules, handoffs, and outputs.
- [ ] Support validated node ports and schemas derived from authoritative capability/connector
  manifests rather than free-form arbitrary payloads.
- [ ] Provide draft validation, test runs, step inspection, publish/version/rollback, and reusable
  subflows.
- [ ] Keep simple templates and guided forms editable without requiring users to understand the
  visual graph.
- [ ] Define import/export and template-sharing policy only after secret/resource references can be
  safely separated from workflow definitions.

## 9. Phase 5 — External connected agents, MCP, and REST API

### A. MCP server

- [ ] Implement remote MCP Streamable HTTP endpoint in the Agent Platform service.
- [ ] Implement initialization, capability negotiation, `tools/list`, `tools/call`, structured
  outputs, pagination, progress, cancellation, and safe error responses.
- [ ] Adapt filtered Capability Gateway manifests to MCP tools; do not duplicate handlers.
- [ ] Add MCP resources only for explicitly safe, scoped, read-only context; tools remain the
  action surface.
- [ ] Serve OAuth protected-resource metadata and implement compatible authorization discovery.
- [ ] Support installation credential token exchange for unattended clients.
- [ ] Provide a connection flow/instructions for Codex, Claude Code, n8n, and custom MCP clients.
- [ ] Later, implement/test a local stdio bridge to the hosted MCP service for local-only MCP
  clients; do not duplicate capability logic in the bridge.
- [ ] Add legacy HTTP+SSE or persistent real-time transports only after a concrete compatibility or
  UX requirement is accepted.

### B. Agent REST API and webhooks

- [ ] Publish normal public `https://api.kasitek.co.za/v1/*` REST API backed by the same Capability
  Gateway handlers; do not create duplicate `/agent/v1` business APIs.
- [ ] Expose capability discovery and direct typed endpoints for core business operations; avoid
  forcing deterministic integrations through an opaque generic tool-call endpoint only.
- [ ] Publish an OpenAPI contract generated from or validated against capability schemas.
- [ ] Serve OpenAPI at `https://api.kasitek.co.za/openapi.json` and agent integration guidance at
  `https://agents.kasitek.co.za/docs/agent.md`.
- [ ] Standardize request IDs, idempotency keys, cursor pagination, filters, validation errors,
  authorization errors, asynchronous operation status, and effect receipts.
- [ ] Support the same installation short-lived access token used by MCP.
- [ ] Add signed webhook/event subscriptions for run, approval, content, campaign, inbox, booking,
  and delivery lifecycle events where relevant.
- [ ] Add webhook verification, replay protection, exponential retry, disable/re-enable policy,
  delivery logs, and manual redelivery.
- [ ] Add initial TypeScript and Python SDK generation only after the REST/OpenAPI contract is stable.
- [ ] Add REST/MCP parity contract tests proving both adapters invoke the same manifest version,
  policy evaluator, handler, and receipt logic.

### C. External client experience

- [ ] Add “Connect external agent” from the Agents area.
- [ ] Create named external-connected installations with visible grants, credentials, health,
  latest token use, activity, suspend, rotate, and revoke controls.
- [ ] Provide copy-once credential instructions and sample configuration without exposing secrets
  in later UI/API responses.
- [ ] Provide MCP discovery diagnostics, REST credential examples, webhook diagnostics, and a
  sandbox/test workspace option.
- [ ] Verify a real Codex client, a real Claude Code client, and one generic MCP client against
  compatibility tests.
- [ ] Verify n8n and one plain TypeScript/Python REST client against the published OpenAPI behavior.

### D. Shared Agents experience and governance UI

- [ ] Build `/agents` overview for KasiAi, hosted agents, external agents, templates, activity, and
  approvals, showing type/status/mode/connections/last run/model/usage.
- [ ] Build the guided hosted-agent form and external connection wizard with visible testing grants,
  copy-once credentials, capability review, setup snippets, test connection, and activation.
- [ ] Build approval inbox/previews/receipts/reconciliation and safe activity/run details without
  chain-of-thought exposure.
- [ ] Build usage-tracking views and clearly label testing access as unbilled while retaining real
  meter data.
- [ ] Build credential list/rotate/revoke/suspend/last-used UX and agent/workspace kill-switch UI.
- [ ] Enforce personal KasiAi privacy, business-agent staff visibility/assignment, workspace-owned
  configuration controls, and concrete empty/onboarding states.

**Exit gate:** external MCP and REST clients authenticate as installations, see/use only permitted
capabilities, call the same real handler, receive equivalent structured receipts, and appear in the
same audit UI as a KasiTek-hosted agent.

## 10. Phase 6 — Action safety, approvals, and operations

- [ ] Connect existing tool argument-hash approval records to product approval UX.
- [ ] Add immutable, domain-specific preview revisions and bind them to organization, installation,
  capability/version, normalized arguments, resources, approver, expiry, and one logical effect.
- [ ] Default approval expiry to 30 minutes and support cancellation and immutable scheduled-action
  approvals.
- [ ] Define web approval, asynchronous approval, and channel-specific confirmation flows.
- [ ] Return structured `APPROVAL_REQUIRED` responses with approval ID/URL, polling status, webhook
  notification, and Temporal wait/resume behavior.
- [ ] Add action previews for publishing, campaigns, external replies, bookings, and destructive
  contact changes.
- [ ] Add invocation cancellation, retry status, external delivery status, and compensation where
  the domain supports it.
- [ ] Add `reconciliation_required` for ambiguous provider outcomes and prohibit blind effect retry.
- [ ] Re-authorize the approving user at execution and prevent agent self-approval.

### Runtime execution and recovery

- [ ] Apply shared run records to MCP, REST, hosted agents, KasiAi, channels, and schedules with
  trigger/principal/conversation/invocation/idempotency/usage/receipt linkage.
- [ ] Route model work, approvals, schedules, provider effects/polling, uploads, and multi-step
  work through Temporal; retain 10–15 second synchronous reads/local draft budget.
- [ ] Derive workflow IDs from organization/installation/logical idempotency key and attach duplicate
  requests to the current durable run.
- [ ] Enforce durable conversation/effect/installation/provider/recipient concurrency limits and
  fair queues.
- [ ] Implement bounded retry policies, model spend/fallback policy, mutation idempotency,
  provider reconciliation, cancellation signals, `cancellation_too_late`, and `needs_attention`.
- [ ] Persist safe ordered events and ensure stream disconnects fall back to polling/reconciliation.
- [ ] Split task queues by interactive, background/scheduled, connector/delivery, and model-heavy
  work as operational load requires; monitor queues, retries, backlog, and stuck runs.
- [ ] Store media/attachments externally by secure object reference with ownership, hashes, MIME,
  scan state, resumable transfers, and durable media-publish reconciliation.
- [ ] Build admin/customer activity views: run, model, tool, input hash, result, effect,
  approval, delivery, cost, and trace correlation.
- [ ] Add audit retention, redaction, export, and support-access policy.
- [ ] Add installation/workspace/tool kill switches and incident operations UI.
- [ ] Add plan entitlements, quotas, budgets, and granular high-risk restrictions after end-to-end
  broad testing validates the system.

**Exit gate:** customers can see, approve, stop, investigate, and revoke any consequential agent
operation.

## 11. Phase 7 — Security, quality, and rollout

### Security

- [ ] Threat-model installation secrets, token replay, revoked credentials, confused-deputy core
  calls, cross-workspace access, prompt injection, connector secrets, and provider webhooks.
- [ ] Implement audience/token-ID/replay controls, separate external/internal credentials, no-secret
  telemetry/prompt rules, and key rotation.
- [ ] Enforce organization/user/installation/customer namespace isolation including SQL-before-vector
  filters and cross-boundary regression tests.
- [ ] Enforce prompt/tool/sandbox boundaries, data minimization, attachment/signed-URL policy, and
  adversarial injection coverage.
- [ ] Enforce edge/capability/core and IP/credential/installation/organization/capability/channel/
  provider rate/queue/content abuse controls.
- [ ] Verify inbound and outbound webhooks with signature/timestamp/replay and SSRF/redirect/
  destination protections.
- [ ] Add dependency/image/secret scans, deployment credential separation, least privilege, secret
  manager, backup restore tests, pen-test gate, and incident/tabletop runbooks.
- [ ] Add authorization tests at MCP, Agent Platform, and core boundaries.
- [ ] Add structured redaction tests for credentials and sensitive user data.
- [ ] Add per-installation/org/tool/channel rate limits and abuse controls.
- [ ] Run security review before enabling each external-effect capability domain.

### Quality

- [ ] Contract-test every capability manifest against its core handler.
- [ ] Add idempotency/retry/restart/Temporal recovery tests for every mutating tool.
- [ ] Add MCP protocol and client compatibility tests.
- [ ] Add REST/OpenAPI conformance, SDK smoke, webhook signature/retry, and MCP/REST parity tests.
- [ ] Add agent evaluations for grounded answers, correct tool selection, policy adherence, and
  action preview accuracy.
- [ ] Add end-to-end fixtures for browser, WhatsApp, Telegram, Discord, hosted agent, and external
  MCP agent flows.

### Observability and governance

- [ ] Implement immutable redacted audit events for actors/installations/credentials/capabilities/
  resources/approvals/results/effects/public API metadata and link them to correlation/run IDs.
- [ ] Separate and retain audits (24 months), run traces (90 days), debug logs (30 days), raw webhook
  payloads (7 days), aggregate metrics/usage (24 months), and conversations/memory per deletion
  policy; add later configurable/legal-hold variants.
- [ ] Attribute usage/cost across organization, installation, definition/version, credential,
  model/provider/funding source, capability/connector/channel, and invocation/run.
- [ ] Monitor and alert on installation/credential/model/Temporal/API/tool/provider/delivery/
  approval/cost/connector/kill-switch health with scoped operator/admin notifications.
- [ ] Implement the global/organization/definition/installation/capability/connector kill-switch
  hierarchy with audited changes and visible reason/state.
- [ ] Build scoped exports, sensitive-field manifest redaction, safe operator health/recovery/audit/
  support-access tooling, and release evaluations/gates.

### Rollout

- [ ] Create separate local, shared dev/test, controlled beta, and production environments with
  isolated database/Temporal/credentials/provider-test/signing/webhook resources.
- [ ] Create seeded/reseedable controlled-test workspaces with labelled `development_full_access`,
  sandbox/fake providers, and no unapproved real recipients.
- [ ] Add independent platform/KasiAi/capability/external-effect/MCP/REST/webhook/hosted/external/
  channel/connector/organization-beta feature flags and effect-level off switches.
- [ ] Require migration/rollback, contract/auth/retry/eval/redaction/dashboard/runbook/UI/E2E owner/
  switch gates before each layer/domain beta.
- [ ] Test rollback via switches before destructive action, preserve evidence/schema compatibility,
  compensate safely/audited, and communicate impact.
- [ ] Prove grounded KasiAi, hosted agent channel+connector+approval, Codex/Claude MCP, n8n REST,
  immediate revoke, no duplicate effects, webhook replay denial, isolation, and UI reconciliation.
- [ ] Establish dashboard/on-call/alerts/runbooks/restore/provider-outage/key-rotation/support/
  pause-every-layer readiness before public beta.
- [ ] Publish and maintain REST/OpenAPI/MCP/agent/customer/admin/ADR/security/catalog/changelog/
  deprecation documentation.
- [ ] Promote reads → drafts → sandbox effects → real effects feature-by-feature; add plan quotas and
  billing enforcement only after release gates pass.

**Exit gate:** the system can be safely operated, tested, rolled back, and expanded domain by domain.

## 12. Implementation order and handoffs

1. Finish Phase 0 decisions and shared TypeScript/Rust contracts.
2. Run Phase 1 and the Phase 2 registry/core boundary together.
3. Once a minimal real read catalog exists, implement grounded KasiAi (Phase 3).
4. In parallel, begin hosted-user-agent configuration (Phase 4) and MCP transport/auth (Phase 5).
5. Integrate action approvals and governance across all modes (Phase 6).
6. Ship only through Phase 7 release gates.

No implementation may introduce a special direct-core path for one agent type. If a feature cannot
be expressed through the shared installation + capability contracts, the contract must be extended
first.
