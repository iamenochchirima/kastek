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

### Confirmed decisions

- [x] External agents use installation identities and credentials rather than human sessions.
- [x] Start with copy-once installation secrets. Store only a secure hash; lost secrets are replaced,
  never recovered or displayed again.
- [x] Exchange installation secrets for short-lived access tokens lasting one hour; clients should
  refresh approximately five minutes before expiry.
- [x] Support multiple user-named credentials per installation without attempting to infer or trust
  where a runtime is hosted.
- [x] Check installation and credential status on every authenticated request so suspension or
  revocation takes effect immediately even when an issued token has not expired.
- [x] Make credential expiry optional initially and provide rotation reminders; administrators can
  rotate or revoke each credential independently.
- [x] Credentials initially inherit their installation's effective permissions. Later, a credential
  may be narrowed but can never exceed the installation's grants.
- [x] Use the same installation identity and credential flow for MCP and REST.
- [x] Audience-bind external tokens to the Agent Platform/API. Never accept an external installation
  token directly at `kasitek-core`; core receives separately issued delegated internal authority.
- [x] Keep credentials out of prompts, conversations, workflow history, logs, traces, audit payloads,
  and all UI/API responses after initial creation.
- [x] Add registered public keys and signed client assertions before broad production availability,
  allowing deployments to authenticate without transmitting a long-lived shared secret.
- [ ] Decide optional credential-level IP/network constraints only if a concrete deployment or plan
  requires them; hosting-location awareness is not part of the identity model.

### Exit criteria

- [x] Credential type, token lifetime, audience separation, inheritance, and revocation behavior are
  decided for implementation.
- [ ] Credential and token threat model is documented and reviewed.
- [ ] Token claims and endpoint-level validation are specified as executable contracts.

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

### Confirmed decisions

- [x] Use business-domain scope names such as `content.read`, `content.draft.create`,
  `content.publish`, `campaigns.launch`, `inbox.reply`, and `bookings.create`; avoid broad generic
  scopes such as `write` or `admin`.
- [x] Create an explicit, visibly labelled `development_full_access` test grant profile containing
  all implemented product capabilities. It is unavailable in production unless deliberately enabled
  by an operator.
- [x] Exclude raw credential/token reads, billing mutation, organization ownership/role changes,
  workspace deletion, credential privilege escalation, approval bypass, and audit bypass from all
  broad test profiles.
- [x] Model resource constraints from the start for selected connections, social accounts,
  WhatsApp/inbox accounts, booking services/calendars, contact segments, campaigns/brands, and
  object identifiers. During controlled testing, product capabilities default to all resources in
  the installation's own workspace.
- [x] Keep external connector grants separate from KasiTek capability grants. Users explicitly
  select which external connections an agent may use, including during broad testing.
- [x] Use generous testing quotas while retaining bounded concurrency, tool calls, run wall time,
  external-effect approvals, and installation/workspace kill switches.
- [x] Collect complete usage data from the first implementation: runs, model/provider/token usage,
  estimated cost, tool calls, external effects, connector usage, channel delivery, storage,
  schedules, concurrency, failures, and latency.
- [x] During the current testing phase, product access behaves as though every workspace has the
  highest paid entitlement. Billing enforcement and commercial plan limits are deferred; metering
  is not deferred.
- [x] Capability escalation is an explicit, audited request approved by a workspace owner/admin.
  Agents cannot self-grant, and an already-started run cannot silently acquire new authority.
- [x] Effective authorization is the intersection of installation grants, credential restrictions,
  workspace boundary, resource/connection constraints, product availability, action approval, and
  operational limits. Subscription entitlement will join this intersection when enforced.

### Exit criteria

- [x] Testing scope taxonomy, broad-access policy, resource/connector constraints, escalation, and
  metering requirements are approved for implementation.
- [ ] Production role/plan interaction matrix is approved before billing enforcement.
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

### Confirmed decisions

- [x] Maintain one authoritative versioned capability registry used to produce internal agent
  tools, MCP tools, REST/OpenAPI operations, permission UI, documentation, audit descriptions, and
  future SDK types. Adapters do not redefine capabilities or business handlers.
- [x] Use JSON Schema as the interoperable input/output contract. TypeScript helpers may author or
  consume schemas, while checked-in/generated schemas remain usable by MCP, OpenAPI, Rust, UI form
  generation, and contract tests.
- [x] Model small, recognizable business operations instead of database CRUD, broad `write/admin`
  tools, or a single generic execution tool.
- [x] Use content/social as the first complete reference domain, beginning with:
  `connections.list`, `connections.get_health`, `content.list`, `content.get`,
  `content.draft.create`, `content.draft.update`, `content.draft.delete`, `content.schedule`,
  `content.unschedule`, `content.publish`, `content.publish_status`, `social.accounts.list`,
  `social.account.get`, `social.account.capabilities`, `social.posts.list`, `social.post.get`,
  `social.comments.list`, and `social.comment.reply`.
- [x] Expand domains in this order: content/social; contacts/inbox; bookings; campaigns;
  automations/agent administration; workspace/reporting.
- [x] Require every manifest to declare name, semantic version, title/description, owning service,
  required scope, risk class, input/output schemas, resource selector, immediate/durable execution,
  timeout, idempotency, approval, availability, effect semantics, and audit/redaction classification.
  Compensation is optional because some effects cannot be undone.
- [x] Standardize successful results around `data`, capability/version/request/correlation metadata,
  and a durable invocation/run/effect receipt for mutations. Reads may omit effect receipts.
- [x] Standardize safe machine-readable errors: `INVALID_INPUT`, `NOT_FOUND`, `NOT_AUTHORIZED`,
  `CAPABILITY_NOT_GRANTED`, `RESOURCE_NOT_GRANTED`, `APPROVAL_REQUIRED`, `CONFLICT`,
  `RATE_LIMITED`, `PROVIDER_UNAVAILABLE`, `TEMPORARILY_UNAVAILABLE`, and `EFFECT_FAILED`.
  Include request ID, retryability, and optional field violations without secrets or stack traces.
- [x] Use cursor pagination, stable ordering, bounded page sizes, explicit filters, summary-first list
  results, and separate detail retrieval. Do not expose unbounded list tools.
- [x] Use semantic capability versions. Additive optional changes remain compatible; breaking schema
  or behavior changes require a new major version. Installations may pin a supported major, and
  discovery reports deprecation metadata. MCP and REST expose the same active version.
- [x] Discovery distinguishes not granted, granted but not configured, configured but unhealthy,
  and available capabilities, with a safe reason and setup link where applicable.

### Exit criteria

- [x] The shared registry, manifest, schema, result/error, pagination, availability, and versioning
  design is approved for implementation.
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

### Confirmed decisions

- [x] Execute reads and drafts immediately. Execute reversible controlled writes according to
  policy and store undo information. Require exact approval for external effects. Restrict
  privileged actions to authorized administrators or make them unavailable to agents entirely.
- [x] Bind approval to organization, installation, capability name/version, normalized argument
  hash, selected resources, immutable preview revision, approving actor, expiry, and exactly one
  logical effect. Any material change invalidates approval.
- [x] Use a 30-minute default approval expiry. Approvals are single-use and cancellable. Scheduled
  actions bind approval to a specific immutable scheduled revision; risk/domain-specific lifetimes
  may be configured later.
- [x] Use KasiTek's authenticated web UI as the initial approval interface. External clients and
  channel agents receive `APPROVAL_REQUIRED` with an approval ID/URL and may poll, receive a webhook,
  or durably wait. A plain chat message such as “yes” is not sufficient authorization.
- [x] Define domain-specific previews. Content shows exact content/media, target accounts, schedule,
  transformations, and post count. Campaigns show revision, frozen/constrained audience, channels,
  schedule, estimated sends, and cost. Bookings show customer, service/provider, timezone, price,
  and notifications. Inbox replies show destination, sending account, exact content, and attachments.
- [x] Bind approval to immutable revisions/snapshots. Changed content, audience, schedule, resource,
  booking time, or message requires new approval.
- [x] Defer standing approvals until individual approval is proven. Later standing policies must
  constrain capability, resource/account, rate, schedule, cost/value, content/safety rules, expiry,
  and revocation.
- [x] Require idempotency keys for mutations. One approval authorizes one logical effect; retries
  cannot duplicate it. Reconcile provider state after ambiguous timeouts and report
  `reconciliation_required` instead of blindly retrying.
- [x] Store undo/compensation information for reversible internal changes. Never promise reversal
  for irreversible provider effects. Return item-level batch outcomes and perform compensation as a
  new audited action.
- [x] Users may approve only actions they themselves are authorized to perform; workspace-wide or
  privileged actions require an administrator. Agents cannot self-approve, and approver authority
  is rechecked at execution. During controlled testing, workspace owners/admins may approve all
  enabled test actions.
- [x] Audit proposal, preview, arguments hash, decision, approver, execution, provider result,
  receipt, retry/reconciliation, and compensation. Suspension or a kill switch cancels pending
  approvals and blocks execution.

### Exit criteria

- [x] Approval classes, binding, expiry, initial UX, previews, revisions, retry/reconciliation,
  compensation, roles, and emergency behavior are approved for implementation.
- [ ] Every mutating capability has a tested review, approval, idempotency, and failure contract.

## Layer 6 — Core integration boundary

**Goal:** Keep `kasitek-core` the authority for business data and final execution.

### Confirmed decisions

- [x] Issue a short-lived signed delegation token per capability invocation, valid for approximately
  one to two minutes and containing organization, installation/principal, capability/version,
  resource constraints, invocation/run IDs, idempotency key, arguments hash, approval/approver when
  applicable, issue/expiry, audience, and unique token ID.
- [x] Use asymmetric signing such as ES256. `kasitek-core` receives public keys through trusted JWKS
  discovery/configuration and cannot mint delegations. Support rotation with overlapping current and
  previous public keys.
- [x] Never pass external installation/MCP/REST tokens to core. The Agent Platform validates the
  external token and policy, then mints a separately audience-bound internal delegation.
- [x] Expose typed internal domain endpoints in core, with shared delegation middleware and
  domain-owned controllers/services. Do not build one arbitrary JSON capability dispatcher in core.
- [x] Core performs final authorization: organization/resource ownership, capability/resource match,
  provider availability, arguments/approval hash, approver authority, business preconditions, and
  idempotency. Resource or organization identity is never trusted from request bodies alone.
- [x] Agent Platform checks installation/credential state before delegation. Suspension blocks new
  delegations immediately; delegation expiry limits stale authority. Propagate kill-switch/revocation
  events to core caches and use internal introspection for highly consequential actions when needed.
- [x] Core owns final business-effect idempotency and persists organization, capability,
  idempotency key, arguments hash, status, business/effect ID, provider outcome, and receipt. Agent
  Platform tool-invocation records are an additional orchestration/audit layer, not the sole guard.
- [x] Commit internal state and durable outbox/action records atomically. Process provider effects
  from the outbox, update durable effect state, emit lifecycle events, and reconcile ambiguous
  outcomes before retry.
- [x] Return the shared Layer 4 result/receipt/meta envelope and stable safe error codes without
  database, provider-secret, or stack-trace leakage.
- [x] Emit signed, versioned events such as `content.published`, `content.publish_failed`,
  `campaign.launched`, `message.delivered`, `booking.confirmed`, and
  `effect.reconciliation_required`. Agent Platform consumes idempotently; polling is a recovery path.
- [x] Use private service networking where available and TLS everywhere. Signed delegation remains
  mandatory on private networks. Rate-limit by installation/capability and preserve correlation IDs;
  consider mTLS later if operational needs justify it.
- [x] Keep direct and white-label product authority separate. `kasitek-core` implements direct-product
  capabilities; future `kasitek-tenants` handlers implement the same contracts without Agent Platform
  database coupling or collapsed identity models.

### Exit criteria

- [x] Delegation, typed endpoint, final authorization, idempotency/outbox, event, response, network,
  and future tenant-boundary architecture is approved for implementation.
- [ ] Agents cannot read or mutate core tables directly in every implemented capability.
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

### Confirmed decisions

- [x] Publish the normal public REST API at `https://api.kasitek.co.za/v1/*` and publish the
  separately deployed hosted MCP endpoint at `https://agents.kasitek.co.za/mcp`. Use Railway private
  networking for core internal endpoints where available; internal contracts are not public API.
- [x] Use remote MCP Streamable HTTP as the initial hosted MCP transport, supporting initialization,
  discovery, calls, structured results, progress, cancellation, pagination, and capability-change
  notifications.
- [x] Add a local stdio bridge/proxy later for MCP clients that only support local stdio. Consider
  legacy HTTP+SSE only when a meaningful compatible client requires it. Treat WebSocket or another
  persistent real-time transport as a future UX optimization, not a correctness dependency.
- [x] All transports are adapters over the same capability contracts, installation identity,
  Capability Gateway, approval model, and audit trail.
- [x] Let external agents authenticate as installation principals through the Layer 2 token exchange.
  Add interactive OAuth installation UX for third-party applications later. Accept tokens only in
  the `Authorization` header and validate the MCP/REST audience.
- [x] Filter MCP discovery to granted capabilities. Show granted-but-unavailable capabilities with
  safe availability reason/setup metadata; keep ungranted capabilities invisible.
- [x] Publish normal typed business REST endpoints and a generic advanced capability invocation
  endpoint. Both invoke the exact same manifest, policy evaluator, and handler.
- [x] Publish OpenAPI 3.1 generated from or contract-tested against the capability registry,
  including examples, authentication, errors, receipts, pagination, idempotency, and webhooks.
  Generate TypeScript and Python SDKs only once the contract is stable.
- [x] Require REST `Idempotency-Key` headers and mutation-tool idempotency input. Return
  `APPROVAL_REQUIRED` for external effects; long operations return a run/status/approval reference
  that clients may poll or receive through webhooks.
- [x] Provide selected installation webhook subscriptions. Sign deliveries with HMAC-SHA256 and a
  copy-once webhook secret; include event ID/type/version, organization/installation, timestamp,
  safe effect data, and delivery attempt. Enforce timestamp/replay protection, exponential retries,
  delivery logs, manual redelivery, and disable/re-enable behavior after repeated failure.
- [x] Use generous but finite and measured rate limits by installation, credential, capability,
  organization, and expensive provider operation; return standard headers and `RATE_LIMITED` errors.
- [x] Publish agent-readable integration documentation at `https://agents.kasitek.co.za/docs/agent.md`
  and a machine-readable OpenAPI document at `https://api.kasitek.co.za/openapi.json`. Documentation
  is instructional, not executable authority.
- [x] Release only after real compatibility tests for Codex, Claude Code, a generic MCP inspector,
  n8n via REST, TypeScript and Python REST clients, and a webhook receiver reference application.
- [x] Version public REST with `/v1`, capability manifests semantically, and expose supported/deprecated
  version metadata. Provide at least six months' notice before removing a generally available REST
  major version; clearly mark beta capability compatibility separately.
- [x] Require MCP/REST parity tests proving equivalent calls use the same manifest version, policy,
  handler, idempotency, authorization, approval, receipt, and audit behavior.

### Exit criteria

- [x] Public REST/MCP endpoint, transport, authentication, discovery, documentation, webhook,
  compatibility, versioning, and parity design is approved for implementation.
- [ ] Third-party MCP and REST clients authenticate as installations and discover/use only permitted
  capabilities.
- [ ] MCP and REST calls yield the same authorization, approval, audit, idempotency, and receipts as
  KasiAi calls.

## Layer 8 — Runtime execution and durability

**Goal:** Turn each invocation into a bounded, observable, recoverable execution.

### Confirmed decisions

- [x] Execute simple bounded reads synchronously with a roughly 10–15 second timeout. Allow simple
  local draft changes to complete synchronously. Route model work, approvals, schedules, external
  effects, uploads, provider polling, and multi-step work through durable Temporal runs. Return a
  run reference rather than holding a client connection beyond the synchronous budget.
- [x] Use one durable `AgentRun` model for MCP, REST, KasiAi, hosted agents, external channels, and
  schedules. Persist installation/principal, trigger, conversation/invocation linkage, idempotency,
  status/attempts, steps/events, model/tool/provider usage, approval state, and receipts.
- [x] Require stable idempotency keys. Derive Temporal workflow identity from organization,
  installation, and logical operation/idempotency key. Duplicate submissions attach to the existing
  run; changed payloads require a new key.
- [x] Allow one active reasoning run per conversation, one active external effect per idempotency
  key, generous but finite installation concurrency, and additional provider/account/recipient
  limits. Queue excess work fairly rather than dropping it.
- [x] Use Temporal workflows for coordination and short retryable activities for database/model/tool/
  core/provider/file/webhook/channel I/O. Store raw secrets and large content outside workflow
  history as secure references.
- [x] Retry transient reads and I/O in bounded fashion. Use policy-controlled model retry/fallback;
  retry core mutations only with the same idempotency key; reconcile external-provider uncertainty
  before retry. Never automatically retry validation, authorization, or approval failures.
- [x] Support user/admin cancellation through Temporal signals and activity cancellation. Prevent
  pending effects after cancellation. Represent accepted irreversible provider work as
  `cancellation_too_late` or `reconciliation_required`, not falsely cancelled. Suspension/kill
  switches cancel queued work and block new steps.
- [x] Set policy defaults of 15 seconds for simple requests, 45 seconds interactive wall time,
  30-minute approval waits, bounded domain-specific background workflows, maximum six model calls,
  and maximum four tool calls per run. Broad testing may raise quotas but not remove bounds.
- [x] Treat ordered durable run events as authoritative. SSE, Streamable HTTP, and later WebSocket
  are transport only; clients poll/reconcile after disconnect. Emit safe lifecycle/progress/tool/
  approval/delivery/receipt events without raw secrets, prompts, or generic sensitive content.
- [x] Scale stateless workers with workload-class task queues: interactive, background/scheduled,
  connector/delivery, and model-heavy where needed. Use durable locks, monitor backlog/stuck runs/
  retries/latency/worker health, and preserve recovery across restarts/replicas.
- [x] After bounded retries, mark runs/effects `needs_attention`; preserve evidence and let an
  authorized operator inspect, safely retry, cancel, or compensate rather than hiding failure.
- [x] Store attachments/media in object storage. Persist only secure object references, hashes,
  MIME/ownership/scan metadata in messages/runs; use resumable transfers and a separate durable
  upload/reconciliation flow for media publishing.

### Exit criteria

- [x] Synchronous/durable execution, workflow/activity, idempotency, concurrency, retry,
  cancellation, budget, scaling, dead-letter, event, and media architecture is approved.
- [ ] A restart or stream disconnect cannot duplicate an external effect.
- [ ] Every invocation is traceable to a durable run/effect receipt where appropriate.

## Layer 9 — Conversation and channel gateways

**Goal:** Keep Waku-style thin gateways while preserving production conversation isolation.

### Confirmed decisions

- [x] Normalize every inbound/outbound message to one durable envelope containing message,
  organization, installation, conversation, direction, source channel, binding, external identity/
  conversation, provider event/message IDs, type/content/attachments, timestamps, deduplication,
  and delivery state.
- [x] Treat organization as the workspace isolation boundary, not the specific participant identity.
  A conversation belongs to an installation and has either a user owner or an external customer/
  thread identity within that organization.
- [x] Personal agents such as KasiAi use user-owned conversations. A browser new chat creates its
  own conversation ID only when first sent; it never falls back to a channel-default thread. A
  verified member's external personal channel maps to that member's channel-default KasiAi
  conversation. Other workspace members cannot see it unless deliberate sharing is added later.
- [x] Business agents use customer/thread-owned conversations. Stable external identity plus channel
  binding plus external conversation/thread ID resolves a dedicated conversation. The same customer
  is not automatically merged across channels; future merge is an explicit audited action. Staff
  access follows workspace role, assignment, and handoff policy.
- [x] External connected agents have invocation/run activity by default and receive conversations
  only when they deliberately use KasiTek conversation/channel capabilities.
- [x] Different installations never share a conversation merely because they share a customer or
  organization.
- [x] Keep gateways thin: verify/normalize/deduplicate/resolve conversation/start-or-attach run/
  deliver reply. Gateways contain no agent prompt, memory, tool, or direct product logic.
- [x] Keep browser and WhatsApp active; add Telegram, then Discord, then email. Voice follows later
  with speech/media policy. All use the common envelope and delivery contract.
- [x] A channel binding selects channel connection/account, agent installation, optional identity
  constraints, inbound/outbound routing policies, and handoff/default behavior. Start with one
  primary agent per binding; add explicit rule-based multi-agent routing later.
- [x] Persist an agent reply before outbound delivery. Track durable delivery attempts/provider IDs/
  status webhooks. Preserve failed reply content without rerunning the agent automatically; allow
  manual staff takeover/send where available.
- [x] Enforce channel-specific provider policy, opt-out, and consent before proactive sends. Store
  consent/opt-out against the relevant external identity. Human handoff pauses the agent with audit
  history and preserves context; staff resume explicitly.
- [x] Keep initial approvals in the web UI. Channel messages may initiate an action but plain-text
  channel confirmation cannot approve it. Add signed interactive channel approvals later.
- [x] Normalize attachments into secure object references, scan/validate before model/tool use,
  enforce channel size/type limits, and retain source metadata. Treat OCR/transcription as scoped
  derived data with retention controls.
- [x] Validate every provider webhook signature/challenge, retain raw payloads briefly and with
  restricted access, deduplicate provider IDs, rate-limit endpoints, acknowledge quickly, dispatch
  durable work, and dead-letter malformed/repeated failures with operator visibility.
- [x] Show safe channel, identity, binding, conversation, run, delivery, provider, handoff, and
  error state in activity views without exposing tokens or raw sensitive provider payloads.

### Exit criteria

- [x] Channel identity, ownership, gateway, routing, delivery, consent, attachment, webhook, and
  observability architecture is approved for implementation.
- [ ] Each gateway reuses the shared runtime rather than creating a parallel agent system.

## Layer 10 — Context, knowledge, and memory

**Goal:** Ground agents in current verified state without leaking data or overloading prompts.

### Confirmed decisions

- [x] Classify protected instructions and capability policy as trusted; treat live core tool results as
  trusted data rather than instructions; use reviewed product knowledge as trusted reference; treat
  user/page/file/email/provider/web content as untrusted. Untrusted content cannot alter identity,
  instructions, permissions, tools, or approval policy.
- [x] Maintain versioned, reviewed, attributable KasiTek product knowledge with domain ownership and
  review cadence. Use it for stable explanation/navigation; use live tools for current workspace
  facts. Remove or prohibit imagined capability claims.
- [x] Build minimal trusted run context from organization, authenticated user/role, current route/
  entity, enabled modules, available capabilities/availability, relevant provider health, and the
  conversation summary/recent window. Load detailed workspace data only through tools.
- [x] Use a bounded recent relevant-message window of roughly 20–30 messages plus a token budget and
  durable rolling conversation summary. Summaries update after completed turns, are scoped to
  installation/conversation, and older history is retrieved on demand rather than sent wholesale.
- [x] Keep memory namespaces separate: `conversation`, `user_private`, `organization_shared`, and
  `agent_private`. Business agents do not automatically see user-private memory; external connected
  agents receive memory only through explicit capabilities, never raw memory-table access.
- [x] Create memory selectively from successful interactions with source/confidence/scope/timestamp/
  provenance. Require initial user/admin confirmation for sensitive or organization-shared memory;
  allow opt-in low-risk private preference memory. Keep all memory editable and deletable.
- [x] Treat retrieved documents, connector data, tool output, emails, calendars, CRM notes, and social
  content as untrusted instructions; label/sanitize it for models, keep it within connector and
  installation scope, and persist it only with explicit attributable enablement.
- [x] Delete conversation summaries and conversation-scoped memory when a conversation is deleted.
  Provide edit/delete controls for user-private memory and administrator controls for organization
  shared knowledge/memory. Redact secrets from retained run/audit records and define backup expiry.
- [x] Provide workspace export for conversations, memory, definitions, activity, and audit records
  excluding secrets. Require time-bound, audited authorized support access or an incident process;
  support has no default content access.
- [x] Use source boundaries/labels, policy-constrained tools, approvals for consequential effects, and
  adversarial injection evaluations covering uploads, email, webhooks, social posts, and messages.
- [x] Attribute every run to its model/provider; use provider privacy/retention configuration, later
  workspace provider/region/BYOK policy, minimal-data model requests, and the provider-neutral
  adapter layer.

### Exit criteria

- [x] Context, knowledge, memory, privacy, export/support, injection, and model-provider policy is
  approved for implementation.
- [ ] KasiAi accurately states its capabilities and gets live facts through tools.
- [ ] Retrieval cannot cross organization, installation, or user-scoped boundaries.

## Layer 11 — User and administrator experience

**Goal:** Make agent installations understandable and controllable.

### Confirmed decisions

- [x] Use one `/agents` product area for KasiAi, hosted user agents, external connected agents,
  templates, activity, and approvals. KasiAi remains accessible from the sidebar while its full
  settings/activity is available in the shared area.
- [x] Show name/type, lifecycle/attention status, execution mode, channels/key connections, recent
  activity/last run, model, and usage snapshot in agent lists; reserve technical internals for
  authorized detail views.
- [x] Provide distinct paths for protected KasiAi, guided hosted-agent creation, and external-agent
  connection. The guided flow covers name, purpose/instructions, model, KasiTek capabilities,
  external connections, channels, memory/knowledge, schedules/workflows, review, and activation.
  Broad test access is visible rather than hidden.
- [x] Give every installation Overview, Configuration, Capabilities, Connections, Channels,
  Conversations, Activity/Runs, Approvals, Memory/Knowledge, Schedules/Workflows, Credentials where
  applicable, and Usage. Protect KasiAi instructions while exposing meaningful settings and history.
- [x] Connect external agents through named installation creation, MCP/REST selection, visible
  capability review, copy-once credential generation, setup snippets, connection test, activation,
  and last-used health. Include Codex, Claude Code, n8n, TypeScript, and Python instructions.
- [x] Provide a dedicated approval inbox showing requested effect, exact preview, agent/install,
  resource/account, reason, cost/recipient impact, expiry, decision controls, receipts, delivery,
  and reconciliation state.
- [x] Provide unified activity/runs without exposing raw model chain-of-thought. Show trigger,
  concise agent summary, model usage, tool calls, approval, receipt, delivery, retries/failures,
  cost, and correlation/run ID.
- [x] Display usage from day one—runs, tokens/cost, tools, effects, delivery, connector use, storage,
  and schedules—labelled as tracking while billing is not enforced during testing.
- [x] Show credential names, creation/last use/expiry/status, copy secret once, rotate/revoke/suspend
  controls, and external-runtime warnings without requiring hosting-location knowledge.
- [x] Provide installation pause/suspend immediately and workspace-level kill switches to admins,
  showing actor/reason/time/cancelled work/resume path.
- [x] Keep personal KasiAi chats private to their owning user. Show business-agent conversations to
  appropriately authorized/assigned staff. Keep configurations workspace-owned/admin-editable and
  defer shared/linked personal chats to a later explicit feature.
- [x] Use concrete onboarding/empty states and capability/page-aware KasiAi suggestions; avoid generic
  “AI magic” language and invented feature advice.

### Exit criteria

- [x] Shared agent UX, creation/connection, detail, approval, activity, usage, credential, safety,
  visibility, and onboarding design is approved for implementation.
- [ ] An administrator can safely install, inspect, constrain, rotate, suspend, and revoke an agent.

## Layer 12 — Observability and governance

**Goal:** Make every decision and effect explainable to customers and operators.

### Confirmed decisions

- [x] Record immutable audit events for security-relevant decisions/actions with timestamp,
  organization, user/agent/system/support actor, installation/credential, capability/version,
  resource, request/correlation/run/invocation/effect identifiers, argument hash/redacted summary,
  approval, result/error, provider/delivery IDs, and public API IP/user-agent data where applicable.
  Exclude secrets, full sensitive payloads, and chain-of-thought.
- [x] Keep audit evidence, operational run traces, aggregate metrics, and diagnostic logs distinct,
  linked by IDs but retained/stored under separate policies.
- [x] Let workspace users view only their organization/authorized activity; let admins view all
  workspace configuration, credential metadata, activity/audit, and usage. Give KasiTek operators
  aggregate health by default, with time-bound/audited/minimized support content access only.
- [x] Start retention with audit events and metrics aggregates for 24 months, runs/traces for 90 days,
  debug logs for 30 days, webhook raw payloads for 7 days, usage for 24 months, and conversations/
  memory under user/admin deletion policy. Add configurable plan/region/legal-hold policy later.
- [x] Attribute every unit of usage/cost to organization, installation, definition/version, external
  credential when relevant, model/provider/funding source, capability/connector/channel, and
  run/invocation.
- [x] Monitor installation state, credential use/auth failures, model/provider health, Temporal
  queues/failures, MCP/REST latency/errors, tool/core/provider outcomes, delivery, approvals,
  cost/token anomalies, connector expiry, and kill-switch state.
- [x] Alert operators on service/queue/provider/auth/webhook/retry/cost anomalies. Notify workspace
  admins of their disconnected connections, repeated agent failures, approvals, credentials, rate
  limits, and later budgets; do not alert on ordinary model reasoning steps.
- [x] Use an audited global → organization → agent definition → installation → capability →
  connector/channel kill-switch hierarchy, where every applicable active switch blocks the action.
- [x] Provide organization-scoped usage/run/effect/approval/audit exports and APIs. Use aggregate,
  minimized/anonymized data for operator reporting.
- [x] Define sensitive fields per capability manifest and redact before audit/event/trace/log/
  analytics storage. Use hashes/metadata where enough, continuously test redaction, and retain raw
  business content only in authorized source systems.
- [x] Provide internal admin views for system health, queue/workers, provider health, correlation
  search, stuck-run recovery, switches, manifests, audit, usage anomalies, and support approval;
  never make it an unbounded customer-content browser.
- [x] Version evaluation sets with agent/capability releases and gate releases on correctness,
  hallucination, unsafe tool selection, denials, approvals, latency, and cost; retain sampled
  consent-safe evaluation evidence.

### Exit criteria

- [x] Audit, telemetry, visibility, retention, attribution, health, alerting, kill-switch, export,
  redaction, admin, and evaluation governance is approved for implementation.
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
- [x] 2. Installation credential and token lifecycle
- [x] 3. Scope taxonomy, subscriptions, and resource constraints
- [x] 4. First capability catalog and contract design
- [x] 5. Action safety and approvals
- [x] 6. Core delegated authorization boundary
- [x] 7. MCP and public REST API contract and connection UX
- [x] 8. Runtime execution and durability rules
- [x] 9. Conversation and channel gateway policy
- [x] 10. Context, knowledge, and memory policy
- [x] 11. User and administrator experience
- [x] 12. Observability and governance
- [ ] 13. Security review
- [ ] 14. Rollout and verification plan

## Next discussion

Start with Layer 1: decide the first-release installation lifecycle, who can control installations,
how plan limits apply, and the first set of official templates. Once agreed, update this document
before moving to credentials.
