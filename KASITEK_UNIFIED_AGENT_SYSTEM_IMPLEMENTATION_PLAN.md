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
- [ ] Add `requiredScopes`, resource selector validation, availability/entitlement predicates,
  effect semantics, and capability owner metadata to manifests.
- [ ] Provide a filtered discovery API based on the requesting installation identity.
- [ ] Centralize policy evaluation and return structured allow/deny reasons.
- [ ] Preserve broad testing grants behind explicit test configuration; never use a hidden
  “allow all” path in production code.

### B. Core boundary

- [ ] Define signed/delegated internal requests from agents to `kasitek-core` containing the
  installation principal, organization, capability, constrained resource, invocation/run ID,
  idempotency key, and correlation ID.
- [ ] Make core independently validate the delegated authority before any business operation.
- [ ] Add typed core capability handlers rather than agent access to core tables.
- [ ] Add a shared error taxonomy: validation, not found, denied, unavailable, conflict,
  confirmation-required, and effect-failed.
- [ ] Make each mutating core handler accept and enforce an idempotency key.
- [ ] Return durable effect receipts and provider delivery identifiers where relevant.

### C. First real capability catalog

- [ ] Workspace/connection: status, connection listing, connection health.
- [ ] Content/social read: accounts, posts/content items, drafts, provider availability.
- [ ] Campaign read: campaigns, status, audiences, estimates.
- [ ] Contacts/inbox read: contact search/detail, conversation/message listing.
- [ ] Bookings read: services, availability, booking listing/detail.
- [ ] Automation/agent read: installations, runs, schedules, activity.
- [ ] Draft tools: content drafts, campaign drafts, inbox reply drafts, booking proposals.
- [ ] Action tools: publish/send/reply/create/confirm only after the approval contract is proven.

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
- [ ] Complete Telegram and Discord adapters as thin channel adapters over the shared runtime.
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

### B. Agent REST API and webhooks

- [ ] Publish a versioned `/v1` REST API backed by the same Capability Gateway handlers.
- [ ] Expose capability discovery and direct typed endpoints for core business operations; avoid
  forcing deterministic integrations through an opaque generic tool-call endpoint only.
- [ ] Publish an OpenAPI contract generated from or validated against capability schemas.
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

**Exit gate:** external MCP and REST clients authenticate as installations, see/use only permitted
capabilities, call the same real handler, receive equivalent structured receipts, and appear in the
same audit UI as a KasiTek-hosted agent.

## 10. Phase 6 — Action safety, approvals, and operations

- [ ] Connect existing tool argument-hash approval records to product approval UX.
- [ ] Define web approval, asynchronous approval, and channel-specific confirmation flows.
- [ ] Add action previews for publishing, campaigns, external replies, bookings, and destructive
  contact changes.
- [ ] Add invocation cancellation, retry status, external delivery status, and compensation where
  the domain supports it.
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

### Rollout

- [ ] Controlled test workspace with broad test grants and clear audit labelling.
- [ ] Read-only KasiAi internal beta.
- [ ] Draft-capability beta.
- [ ] External-connected MCP beta.
- [ ] Hosted user-agent beta.
- [ ] Controlled external-effect beta by domain.
- [ ] Production entitlement/limits launch after release gates pass.

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
