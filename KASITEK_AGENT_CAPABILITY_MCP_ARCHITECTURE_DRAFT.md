# KasiTek Agent Capability Platform and MCP Architecture Draft

**Status:** Draft for product and architecture decisions  
**Scope:** Direct KasiTek first; preserve explicit organization ownership for the future white-label platform  
**Last updated:** 2026-08-12

## Purpose

KasiTek needs one platform capability standard that lets protected system agents, KasiTek templates,
customer-built agents, and external agent clients safely use real KasiTek functions.

KasiAi is the first consumer of this standard. It must not rely on generic model knowledge or direct
database access. It should learn current workspace facts and take actions only through the same
typed capability contracts available to every appropriately installed agent.

The externally connectable product surfaces will be a hosted KasiTek MCP server and a strong,
versioned REST API. MCP provides agent-native discovery and invocation. REST supports deterministic
automations, n8n, scripts, SDKs, webhooks, and custom applications. Both are adapters over the same
capability contracts and neither is the source of business authorization. The internal Capability
Gateway remains the authority for scopes, plans, resource limits, approvals, idempotency, and audit.

```text
KasiAi / KasiTek-hosted agents ───────────────┐
                                              │
External agents and integrations              │
        ↓                                     │
Agent Installation Credential                 │
        ↓                                     │
MCP Server or REST API                        │
        └─────────────────────────────────────┤
                                              ↓
                                    Capability Gateway
                                              ↓
                              scoped KasiTek capabilities
                                              ↓
                                         kasitek-core
```

## Current evidence and non-goals

Already implemented in the Agent Platform:

- versioned agents, installations, durable conversations, runs, Temporal execution, tool grants,
  approvals, audit records, scoped memory, and channel binding/delivery foundations;
- a generic JSON-schema-validated tool registry with risk classes and argument-hash approvals;
- an authenticated `agents → kasitek-core` internal client boundary;
- an OpenRouter-first model gateway with direct provider adapters;
- browser and WhatsApp entry points into the shared conversation/run model.

Not yet implemented:

- a platform-wide catalog of real product capabilities;
- installation credentials for independent external agent runtimes;
- delegated capability enforcement in `kasitek-core`;
- a hosted MCP endpoint;
- grounded KasiAi read/action tooling beyond time and workspace connection status;
- Telegram and Discord provider adapters.

This document does **not** authorize implementation. It is the decision record and execution
checklist we will complete together before work starts.

## Shared principles

- An agent is a non-human principal. It can operate when no user is signed in.
- An `AgentInstallation` binds an agent definition to exactly one organization/workspace scope.
- Every request is authorized as an installation identity, never through a database bypass.
- The effective authority is the intersection of installation grants, subscription entitlements,
  resource constraints, and any action-specific approval policy.
- Capabilities are typed, versioned, discoverable, and owned by the product service that performs
  the business operation.
- Read, draft, controlled-write, external-effect, and privileged capabilities have distinct policy.
- Every consequential request is idempotent, auditable, and returns a durable effect receipt.
- MCP is an adapter over the exact same capability contracts that KasiAi uses internally.
- REST is an equally supported adapter over those contracts; MCP and REST must not diverge in
  permissions, schemas, effects, or audit behavior.
- External channels are thin message adapters; they do not create separate agent runtimes.
- Agents never receive direct core database access or raw provider credentials.

## Layer 1 — Product contract and installation model

**Goal:** Define the product objects and lifecycle that customers see.

### Proposed vocabulary

- `AgentDefinition`: reusable product/template/system agent configuration.
- `AgentInstallation`: one definition enabled for one organization.
- `AgentPrincipal`: the non-human identity for that installation.
- `CapabilityGrant`: an allowed operation plus optional resource constraints.
- `InstallationCredential`: credential held by the deployed agent runtime.
- `ActionApproval`: an exact, expiring approval for a consequential invocation.

### Decisions to make

- [x] Agents operate as independent non-human principals; they are not required to impersonate a
  currently logged-in human.
- [x] KasiAi is a protected system definition installed per organization and uses the shared
  capability standard.
- [x] Support all execution modes in the shared model: `system_hosted` for KasiAi,
  `kasitek_hosted` for KasiTek-run user agents, and `external_connected` for runtimes such as
  Codex, Claude Code, n8n, or a customer deployment.
- [x] External connected agents are visible Agent Installations with their own identity,
  activity, credentials, grants, health, suspension, and revocation controls.
- [x] Agent installations belong to the workspace, not the person who created them; creator and
  subsequent changes remain audit metadata.
- [x] Plan for a single delivery that includes KasiAi, hosted user agents, and external connected
  agents; implementation tracks may proceed in parallel but share the same contracts.
- [x] During the controlled testing phase, provide broad enabled capability access to test
  installations. Preserve organization isolation, credentials, audit records, idempotency, core
  authorization, and action receipts from the first implementation; subscription limits and
  granular commercial restrictions are deferred to the entitlement phase.
- [x] During testing, read and draft capabilities may run immediately; real external effects such
  as publishing, campaign/message sends, and booking confirmations still require explicit
  approval. Prefer provider sandboxes or dry-run previews where the domain supports them.
- [x] Implement content and social as the first complete reference capability domain.
- [x] Ship hosted-agent creation through a guided form first: name, purpose, instructions, model,
  capabilities, external connections, channels, knowledge/memory, and schedules/workflows where
  available.
- [x] Preserve a durable declarative workflow/graph model beneath the guided form.
- [x] Add a visual n8n-style custom-agent/workflow builder as a planned product phase after the
  shared capability, execution, and approval contracts are proven; it is deferred, not removed.
- [ ] Who can install, modify, suspend, and delete an agent installation in a workspace?
- [ ] Which plans may create agents, connect external agents, use scheduled runs, or invoke
  high-risk capabilities?
- [ ] Can an installation have several credentials/runtimes, or exactly one initially?
- [ ] What are the first-release agent templates and their default grant profiles?

### Exit criteria

- [ ] A user-visible lifecycle and subscription/ownership model is agreed.
- [ ] The data model changes are written as a migration plan and API contract.

## Layer 2 — Identity, credentials, and token lifecycle

**Goal:** Let a deployed agent authenticate independently and safely.

### Proposed first release

An administrator creates an installation and generates a named installation secret shown once.
The runtime exchanges that secret for a short-lived, audience-bound access token. The installation
can be suspended, revoked, rotated, and audited without relying on a human session.

### Decisions to make

- [x] External agents use installation identities and credentials rather than human sessions.
- [ ] Initial client authentication: installation secret, signed private-key assertion, or both?
- [ ] Access-token lifetime, refresh/exchange rules, credential expiry, and rotation policy.
- [ ] Whether credentials can be constrained to IPs, environments, or named runtime instances.
- [ ] How credentials are encrypted, displayed once, recovered, and revoked.
- [ ] Whether external agents may use both MCP and REST with the same installation identity.

### Exit criteria

- [ ] Credential and token threat model is documented.
- [ ] Token claims, audience validation, and revocation behavior are specified.

## Layer 3 — Permission, entitlement, and resource policy

**Goal:** Define what an installation can do, independent of its model or channel.

### Proposed effective permission rule

```text
effective capability = installation grant
                     ∩ workspace subscription entitlement
                     ∩ resource constraint
                     ∩ capability preconditions
                     ∩ action approval policy
```

### Decisions to make

- [ ] Scope naming convention: `content.read`, `content.draft.create`, `content.publish`, etc.
- [ ] Resource constraints: whole workspace, selected connection, content account, campaign,
  booking service, inbox/channel, contact segment, or object IDs.
- [ ] Scope escalation and re-consent flow when an agent needs more access.
- [ ] Budget, rate, concurrency, schedule, and provider-cost limits per installation.
- [ ] Admin-only and permanently unavailable capabilities.

### Exit criteria

- [ ] Scope taxonomy and role/plan interaction matrix are approved.
- [ ] An authorization decision can be explained and audited for every denied/allowed request.

## Layer 4 — Capability catalog and tool contract

**Goal:** Create authoritative, real platform tools; eliminate generic agent invention.

### Required manifest fields

```text
name · version · owner service · description · input schema · output schema
risk class · required scope · resource selector · timeout · idempotency rule
approval rule · effect/undo semantics · audit classification · availability predicate
```

### Candidate domains

- workspace and connections;
- content and social publishing;
- campaigns;
- inbox and contacts;
- bookings;
- automations and agent administration.

### Decisions to make

- [ ] First read-only tool set for grounded KasiAi.
- [ ] First draft/action set and the product domain owners for each capability.
- [ ] Tool granularity: business intentions such as `campaign.launch` rather than raw CRUD.
- [ ] Canonical result/error/effect receipt schema and pagination conventions.
- [ ] Compatibility/version deprecation policy.

### Exit criteria

- [ ] Every first-release tool maps to one real core contract and authorization owner.
- [ ] KasiAi has no ungrounded claims about unsupported product features.

## Layer 5 — Action safety and approval model

**Goal:** Make actions safe while retaining agent usefulness.

### Risk classes

- `read`: bounded retrieval; no confirmation by default.
- `draft`: creates or updates a reviewable draft.
- `controlled-write`: reversible internal change; policy-defined confirmation.
- `external-effect`: sends, publishes, confirms, schedules, or contacts an external party.
- `privileged`: sensitive administration; unavailable or restricted to explicit administrators.

### Decisions to make

- [ ] Which risk classes require confirmation in the first release?
- [ ] Approval UX by channel: web, WhatsApp, Telegram, Discord, scheduled/unattended agents.
- [ ] Exact preview fields per domain (recipients, cost, connected account, time, content, etc.).
- [ ] Approval expiration, argument-hash binding, cancellation, retry, and compensation rules.
- [ ] Which actions can be pre-authorized by policy versus always requiring approval?

### Exit criteria

- [ ] Every mutating capability has a review, approval, idempotency, and failure contract.

## Layer 6 — Core integration boundary

**Goal:** Keep `kasitek-core` the authority for business data and final execution.

### Decisions to make

- [ ] Internal delegated token/header contract between Agent Platform and core.
- [ ] How core verifies installation principal, scopes, constraints, and correlation identifiers.
- [ ] Domain-by-domain internal endpoints or an internal capability dispatcher.
- [ ] Transactionality, outbox/event behavior, and idempotency ownership.
- [ ] How core returns safe, typed errors and effect receipts.

### Exit criteria

- [ ] Agents cannot read or mutate core tables directly.
- [ ] Core independently rejects an action that is not authorized for the installation.

## Layer 7 — Hosted MCP server and Agent REST API

**Goal:** Expose approved capabilities through both agent-native MCP and a stable REST API for
Codex, Claude Code, n8n, scripts, SDKs, webhooks, and customer-built runtimes.

### Required MCP responsibilities

- transport/session handling and capability negotiation;
- tool discovery filtered by installation grants;
- structured input/output and safe error mapping;
- OAuth-compatible protected-resource metadata and authentication flow;
- progress, cancellation, and action approval handoff;
- resources for safe contextual data only where needed.

### Required REST responsibilities

- versioned `/v1` agent-facing endpoints with OpenAPI documentation;
- capability discovery plus direct typed business-capability invocation;
- consistent cursor pagination, filtering, validation, errors, and structured receipts;
- mandatory idempotency keys for mutations and durable status endpoints for asynchronous work;
- webhook/event subscriptions with signing, replay protection, delivery attempts, and recovery;
- generated SDK compatibility without making an SDK the authoritative contract.

### Decisions to make

- [ ] Initial endpoint and transport: remote Streamable HTTP only, or additional transports?
- [ ] Authentication UX for Codex/Claude Code and non-interactive server agents.
- [ ] Whether every capability is exposed in MCP v1 or whether some remain internal initially.
- [ ] Tool naming, pagination, resource URI policy, and MCP version support policy.
- [ ] Public documentation, test server, and compatibility suite.
- [ ] REST resource/operation layout and the boundary between business-friendly endpoints and the
  generic capability invocation endpoint.
- [ ] OpenAPI source-of-truth generation and client SDK targets.
- [ ] Webhook/event catalog, signing algorithm, retry schedule, replay window, and delivery logs.
- [ ] Parity tests proving equivalent MCP and REST invocations reach the same capability handler.

### Exit criteria

- [ ] Third-party MCP and REST clients authenticate as installations and discover/use only permitted
  capabilities.
- [ ] MCP and REST calls yield the same authorization, approval, audit, idempotency, and receipts as
  KasiAi calls.

## Layer 8 — Runtime execution and durability

**Goal:** Turn each invocation into a bounded, observable, recoverable execution.

### Decisions to make

- [ ] Which MCP calls run synchronously and which produce durable asynchronous runs?
- [ ] Temporal workflow mapping for long actions, approvals, retries, scheduled work, and delivery.
- [ ] Run idempotency key requirements and duplicate/replay behavior.
- [ ] Locking/concurrency per conversation, installation, external recipient, and capability.
- [ ] Timeout, retry, compensation, and dead-letter policies.

### Exit criteria

- [ ] A restart or stream disconnect cannot duplicate an external effect.
- [ ] Every invocation is traceable to a durable run/effect receipt where appropriate.

## Layer 9 — Conversation and channel gateways

**Goal:** Keep Waku-style thin gateways while preserving production conversation isolation.

### Decisions to make

- [ ] Standard inbound/outbound envelope for browser, WhatsApp, Telegram, Discord, and future channels.
- [ ] External identity and external-conversation mapping rules.
- [ ] Which channel is a personal-agent channel versus a business/customer agent channel.
- [ ] Delivery status, retries, provider webhooks, opt-out, and human handoff requirements.
- [ ] Cross-channel conversation visibility and privacy rules in the KasiAi UI.

### Exit criteria

- [ ] Each gateway reuses the shared runtime rather than creating a parallel agent system.

## Layer 10 — Context, knowledge, and memory

**Goal:** Ground agents in current verified state without leaking data or overloading prompts.

### Decisions to make

- [ ] Authoritative product knowledge sources, owners, review cadence, and release versioning.
- [ ] Page/workspace context contract and which data is loaded only on tool demand.
- [ ] Conversation window, summaries, scoped memory, cross-chat retrieval, and opt-in policy.
- [ ] Data retention, deletion, export, and derived-memory lifecycle.
- [ ] Prompt-injection treatment for user content, documents, provider data, and tool outputs.

### Exit criteria

- [ ] KasiAi accurately states its capabilities and gets live facts through tools.
- [ ] Retrieval cannot cross organization, installation, or user-scoped boundaries.

## Layer 11 — User and administrator experience

**Goal:** Make agent installations understandable and controllable.

### Decisions to make

- [ ] Installation wizard, grant picker, credential creation, and copy-once recovery UX.
- [ ] Agent detail view: grants, resources, credentials, budgets, schedules, health, runs, and activity.
- [ ] Approval inbox and action-preview UX.
- [ ] KasiAi-specific settings versus common agent installation settings.
- [ ] Agent connection instructions for Codex, Claude Code, n8n, and custom runtimes.

### Exit criteria

- [ ] An administrator can safely install, inspect, constrain, rotate, suspend, and revoke an agent.

## Layer 12 — Observability and governance

**Goal:** Make every decision and effect explainable to customers and operators.

### Decisions to make

- [ ] Required audit records: principal, installation, scope, resource, input hash, approval,
  tool/version, model, cost, result, effect ID, and correlation/trace ID.
- [ ] Customer activity views versus internal operator access.
- [ ] Trace/audit retention, redaction, export, support access, and legal hold behavior.
- [ ] Usage/cost attribution, quotas, alerts, and billing events.
- [ ] Kill-switch hierarchy and incident response procedures.

### Exit criteria

- [ ] Every action can be attributed, explained, and revoked from the product UI.

## Layer 13 — Security and abuse resistance

**Goal:** Protect customer data and actions from credential compromise, cross-tenant access, and
malicious instructions.

### Decisions to make

- [ ] Threat model for stolen installation credentials, replay, confused deputy, and token leakage.
- [ ] Audience binding, token issuer/key rotation, credential hashing/encryption, and secret handling.
- [ ] Rate limits and abuse controls by installation, organization, IP, tool, and channel.
- [ ] Prompt-injection defenses and outbound data minimization.
- [ ] Security review requirements before each new capability domain.

### Exit criteria

- [ ] Security controls are testable at the gateway and core boundary.

## Layer 14 — Rollout, testing, and operations

**Goal:** Ship the capability surface without exposing unproven mutations.

### Proposed rollout

1. Grounded, read-only KasiAi tools.
2. Draft capabilities and audit/approval UI.
3. Controlled write and external-effect tools for selected domains.
4. Installation credentials and private customer-agent API.
5. Hosted MCP beta with compatibility tests.
6. Additional channels and capability domains.

### Decisions to make

- [ ] Sandbox/test workspace model for integrations and agent installations.
- [ ] Contract, authorization, idempotency, adversarial, and MCP compatibility test requirements.
- [ ] Feature flags, beta access, migration/rollback, and incident communications.
- [ ] Release gates for read tools, drafts, and external-effect capabilities.

### Exit criteria

- [ ] Each rollout stage has objective checks and a rollback path.

## Decision sequence

Work through the layers in this order. Do not begin implementation of a later layer that depends on
an undecided earlier layer.

- [ ] 1. Product contract and installation lifecycle
- [ ] 2. Installation credential and token lifecycle
- [ ] 3. Scope taxonomy, subscriptions, and resource constraints
- [ ] 4. First capability catalog and core ownership
- [ ] 5. Action safety and approvals
- [ ] 6. Core delegated authorization boundary
- [ ] 7. MCP server contract and connection UX
- [ ] 8. Runtime execution rules
- [ ] 9. Channels and conversation policy
- [ ] 10. Context/knowledge/memory policy
- [ ] 11. User/admin UX
- [ ] 12. Observability/governance
- [ ] 13. Security review
- [ ] 14. Rollout and verification plan

## Next discussion

Start with Layer 1: decide the first-release installation lifecycle, who can control installations,
how plan limits apply, and the first set of official templates. Once agreed, update this document
before moving to credentials.
