---
title: Agent Protocol Implementation Plan
slug: /architecture/agent-protocol-implementation-plan
sidebar_position: 5
---

# Agent Protocol Implementation Plan

This plan turns the [Kasitek Platform Architecture](./kasitek-technical-blueprint.md) protocol direction into an executable checklist.

Day-to-day progress is tracked in the [Agent Protocol Implementation Checklist](./agent-protocol-implementation-checklist.md).

The module boundaries, code vocabulary, execution pipeline, storage model, and scaling rules are defined in the [Action Platform Technical Design](./action-platform-technical-design.md).

The required order is:

```text
Domain APIs and webhooks
          |
          v
Action registry, policy, approvals and execution records
          |
          v
Native Kasitek agent use
          |
          v
MCP read-and-draft pilot
          |
          v
MCP controlled external actions
          |
          v
A2A task delegation, after a separate readiness gate
```

MCP and A2A are protocol adapters. Neither protocol owns business rules, permissions, approvals, tenant resolution, or authoritative execution state.

## 1. Objective and definition of done

The objective is to let approved human and machine clients discover and invoke Kasitek actions without creating an alternate route around product-domain ownership or tenant security.

The implementation is complete when:

- direct and white-label runtimes expose the same protocol-neutral action contract while preserving separate data and identity stores;
- every invocation resolves an authenticated actor, organisation or tenant, optional client scope, entitlement, grant, policy, and approval state;
- read, draft, controlled-write, external-effect, and privileged actions receive different policy treatment;
- external effects are idempotent and linked to durable execution and audit records;
- the MCP server passes supported-client integration and security tests;
- A2A is introduced only if its readiness gate is accepted and its tasks map safely onto the internal execution model;
- operators can observe, revoke, investigate, retry, and disable agent access without deploying code.

## 2. Scope

### 2.1 Included

- protocol-neutral action definitions and invocation contracts;
- human, OAuth client, API client, native agent, and delegated-agent actor context;
- grants, policy evaluation, approvals, execution history, idempotency, and audit;
- REST and webhook contract hardening where actions depend on them;
- native Kasitek agent integration;
- MCP server discovery, transport, tools, authentication, and operations;
- later A2A discovery, tasks, messages, artifacts, streaming, cancellation, and push notifications;
- tenant-isolation, security, observability, conformance, and rollout checks.

### 2.2 Excluded from the first release

- unrestricted database or SQL tools;
- arbitrary URL fetching or general-purpose code execution;
- direct exposure of provider credentials;
- MCP prompts and resources without an approved product use case;
- MCP experimental Tasks as Kasitek's authoritative execution state;
- public A2A discovery before partner trust and commercial policy exist;
- automatic approval of privileged or destructive actions.

## 3. Protocol baselines

Implementation must pin and test against an explicit protocol revision.

| Protocol | Initial baseline | Kasitek use |
| --- | --- | --- |
| REST/HTTP and webhooks | Kasitek versioned contracts | Foundational domain and provider interface |
| MCP | [`2025-11-25`](https://modelcontextprotocol.io/specification/2025-11-25) | Approved external AI discovery and action invocation |
| A2A | [`1.0`](https://github.com/a2aproject/A2A/blob/main/docs/specification.md) | Later independent-agent task delegation |

MCP uses its own date-based version negotiation. A2A uses a `Major.Minor` protocol version. Kasitek API, action, tool, event, and workflow versions remain independent of protocol versions.

### Protocol baseline checklist

- [ ] Record the supported MCP protocol revision in configuration and compatibility tests.
- [ ] Record supported A2A versions only when the A2A readiness gate is accepted.
- [ ] Review protocol revisions before each external release.
- [ ] Do not adopt a draft protocol feature without an ADR, feature flag, and removal plan.
- [ ] Keep protocol schemas and generated types pinned in the lockfile.
- [ ] Publish a compatibility matrix for tested MCP clients and A2A peers.

## 4. Current baseline and gaps

This baseline is a focused code review, not a claim that every existing route is production-ready.

| Area | Existing foundation | Required gap closure |
| --- | --- | --- |
| Direct API | Actix REST routes, direct sessions, organisation resolution, provider and product controllers | Move agent-facing operations behind typed actions and consistent policy checks |
| White-label API | Separate Actix runtime, host/workspace resolution, tenant staff/client sessions, roles, API keys | Add protocol-safe grants, client-scoped action policy, approvals, execution, and audit coverage |
| Agents | Tenant workspace agent records and read endpoints; existing external automation workflows | Define versioned agent/workflow models and durable run semantics |
| Connections | Provider connection concepts and scoped product APIs | Make provider operations action-owned, idempotent, and auditable |
| Audit | Basic audit storage exists in the white-label schema | Standardise audit events, immutability expectations, sensitivity, and cross-runtime coverage |
| OAuth | Product login and provider OAuth flows exist | Add or adopt an OAuth 2.1 authorization server suitable for MCP clients |
| MCP | Architecture direction only | Implement protected Streamable HTTP server and tool adapter |
| A2A | Research direction only | Wait for readiness gate, then implement an adapter over internal tasks/runs |

## 5. Target implementation shape

```text
MCP client       Native Kasitek agent       Future A2A peer
    |                    |                        |
    v                    |                        v
MCP adapter              |                   A2A adapter
    |                    |                        |
    +--------------------+------------------------+
                         |
                  Invocation gateway
                         |
       actor + runtime + tenant/org + client + correlation
                         |
                         v
                    Action registry
                         |
          +--------------+---------------+
          |              |               |
          v              v               v
       Grants          Policy         Entitlement
          |              |               |
          +--------------+---------------+
                         |
                  Approval decision
                         |
                         v
                   Domain action
                         |
             +-----------+-----------+
             |                       |
        Direct runtime          White-label runtime
             |                       |
        direct database          tenant database
             |                       |
             +-----------+-----------+
                         |
               execution + audit + outbox
```

The protocol adapters must not query product databases directly. They validate protocol messages, establish the caller, translate the request into an internal invocation, and translate the result back into the protocol response.

## 6. Core contracts

### 6.1 Action definition

Every action definition includes:

- stable name and semantic version;
- owning domain;
- human title and precise description;
- input and output JSON Schema;
- risk class: read, draft, controlled write, external action, or privileged;
- required OAuth scopes and internal grants;
- required product entitlement;
- supported product runtimes and actor types;
- whether client scope is required;
- idempotency requirements;
- approval policy and approval binding fields;
- timeout, retry, and data-classification rules;
- audit and usage-metering requirements;
- lifecycle state: draft, internal, pilot, public, deprecated, or retired.

### 6.2 Invocation context

```text
InvocationContext
  invocation_id
  actor_type + actor_id
  delegated_by
  product_runtime
  organisation_id or workspace_id
  tenant_client_id, when applicable
  grants + OAuth scopes
  entitlement snapshot
  action name + version
  idempotency_key
  correlation_id + causation_id
  approval_reference
  request timestamp + deadline
```

No adapter may construct a partially scoped invocation and expect the domain handler to infer missing tenant authority.

### 6.3 Result contract

Every invocation returns one of:

- `succeeded` with schema-valid structured output;
- `accepted` with a durable operation identifier;
- `approval_required` with a safe approval reference;
- `denied` with a stable reason code;
- `failed` with a safe error code and correlation identifier.

Internal errors, credentials, provider payloads, stack traces, and cross-tenant resource existence must not leak through protocol results.

## 7. Proposed server structure

The precise names may change during the ADR review, but responsibilities should remain separated.

```text
server/
|-- crates/
|   |-- actions/            definitions, schemas, registry and invocation types
|   |-- execution/          grants, policy, approvals, runs, effects and audit
|   `-- action-testing/     shared contract and isolation test support
|
|-- kasitek-core/           direct action handlers and persistence adapters
|-- kasitek-tenants/        tenant action handlers and persistence adapters
`-- kasitek-gateway/        MCP first; optional A2A adapter later
```

The gateway should remain stateless apart from bounded protocol/session concerns. Authoritative grants, approvals, runs, and business records remain in the owning runtime database.

## 8. Delivery phases

Each phase has an exit gate. Work in a later phase must not be treated as production-ready until all earlier gates pass.

### Phase 0 — Decisions, threat model, and protocol pinning

#### Architecture decisions

- [ ] Decide whether to adopt a managed OAuth 2.1 authorization server or operate one.
- [ ] Decide MCP endpoint topology for direct and white-label runtimes.
- [ ] Decide whether the protocol gateway is a separate deployment or an edge module initially.
- [ ] Decide action and OAuth scope naming conventions.
- [ ] Decide immutable audit retention and sensitive-payload redaction rules.
- [ ] Decide approval expiry, revocation, and four-eyes requirements by risk class.
- [ ] Decide whether native workflows continue in the existing automation engine or move behind a new orchestrator.
- [ ] Record ADRs for every accepted decision above.

#### Security design

- [ ] Threat-model OAuth redirect and token flows.
- [ ] Threat-model cross-tenant tool discovery and invocation.
- [ ] Threat-model confused-deputy and token-passthrough attacks.
- [ ] Threat-model prompt injection leading to unsafe action calls.
- [ ] Threat-model duplicate requests and replayed approvals.
- [ ] Threat-model malicious tool inputs, file references, and output exfiltration.
- [ ] Threat-model support/operator elevation.
- [ ] Define incident kill switches by client, tenant, action, and protocol.

#### Exit gate

- [ ] OAuth, endpoint, trust-boundary, and approval ADRs are accepted.
- [ ] Threat model has owners and mitigations.
- [ ] MCP revision is pinned and A2A remains disabled.

### Phase 1 — Protocol-neutral action foundation

#### Shared contracts

- [ ] Create the protocol-neutral action definition type.
- [ ] Create the complete invocation-context type.
- [ ] Define risk and lifecycle enums.
- [ ] Add JSON Schema input and output validation.
- [ ] Add a registry that rejects duplicate names or incompatible versions.
- [ ] Add stable error and denial codes.
- [ ] Add idempotency requirements to action metadata.
- [ ] Add data classification, audit, and usage metadata.

#### First action slice

Implement one vertical slice before catalog expansion:

- [ ] `customer.search` — read, scoped and paginated.
- [ ] `conversation.get_summary` — read, content-minimised.
- [ ] `conversation.draft_reply` — draft only, no external send.
- [ ] Define direct-runtime handlers.
- [ ] Define white-label handlers with mandatory client-scope rules.
- [ ] Reuse the same action contract without sharing databases.

#### Verification

- [ ] Unit-test schema validation and registry conflicts.
- [ ] Test that omitted runtime, tenant/organisation, actor, or required client scope fails closed.
- [ ] Test cross-tenant and cross-client identifiers without revealing resource existence.
- [ ] Test direct credentials cannot invoke white-label handlers and vice versa.
- [ ] Test schema evolution compatibility.

#### Exit gate

- [ ] The three actions execute through the registry from internal tests.
- [ ] No action handler trusts tenant scope supplied only in tool arguments.
- [ ] Direct and white-label isolation suites pass.

### Phase 2 — Grants, policy, entitlements, and machine identity

#### Identity and grants

- [ ] Define machine clients separately from human users and native agents.
- [ ] Store client identifiers, owner, runtime, status, redirect URIs, and allowed scopes.
- [ ] Store grants by actor, action, runtime, tenant/organisation, and optional client scope.
- [ ] Support grant expiry and immediate revocation.
- [ ] Reject inactive users, clients, tenants, organisations, and connections.
- [ ] Map roles to default grants without making roles the only policy input.

#### Policy pipeline

- [ ] Implement ordered evaluation: identity → runtime → tenant/org → client → grant → entitlement → risk → approval.
- [ ] Produce stable allow, deny, and approval-required decisions.
- [ ] Record the policy version and decision basis with each execution.
- [ ] Prevent protocol clients from selecting their own risk class or entitlement.
- [ ] Add per-tenant and per-client action kill switches.
- [ ] Add rate and usage limits before domain execution.

#### Exit gate

- [ ] Revocation takes effect within the accepted operational objective.
- [ ] Policy decisions are consistent across REST-internal, native-agent, and future protocol callers.
- [ ] Denied invocations generate safe audit evidence without storing unnecessary request content.

### Phase 3 — Durable runs, approvals, effects, and audit

#### Persistence model

- [ ] Add separate direct and white-label migrations for agent clients and grants.
- [ ] Add run, step, and attempt records.
- [ ] Add approval request and decision records.
- [ ] Add external-effect and idempotency records.
- [ ] Add outbox events for run and approval changes.
- [ ] Add retention and redaction fields.
- [ ] Add indexes that always begin with runtime ownership and tenant/organisation scope.

Recommended logical records:

```text
agent_clients
action_grants
agent_runs
agent_run_steps
agent_run_attempts
approval_requests
approval_decisions
external_effects
idempotency_records
outbox_events
audit_events
```

#### Approval rules

- [ ] Bind approval to actor, scope, action, target, payload hash, version, and expiry.
- [ ] Invalidate approval when any bound field changes.
- [ ] Prevent the requester from approving when four-eyes policy applies.
- [ ] Make approval decisions append-only.
- [ ] Support reject, expire, revoke, and cancel states.
- [ ] Provide an exact human-readable effect preview.
- [ ] Resume approved work exactly once.

#### Execution safety

- [ ] Use one client idempotency key per logical effect.
- [ ] Prevent concurrent duplicate execution.
- [ ] Record provider request references without exposing credentials.
- [ ] Reconcile unknown provider outcomes.
- [ ] Define timeout, cancellation, retry, and compensation behaviour.
- [ ] Separate diagnostic telemetry from audit evidence.

#### Exit gate

- [ ] Crash-recovery tests prove accepted work is not lost.
- [ ] Duplicate-invocation tests prove external effects are not repeated.
- [ ] Approval mutation and replay tests fail safely.
- [ ] Operators can trace one invocation from caller to domain effect and provider result.

### Phase 4 — REST and webhook foundation hardening

- [ ] Route each agent-facing operation through the same action handler used by protocol adapters.
- [ ] Add consistent idempotency-key handling to mutating APIs.
- [ ] Add stable operation-status endpoints for asynchronous work.
- [ ] Standardise error envelopes and correlation identifiers.
- [ ] Version public contracts without copying domain logic into controllers.
- [ ] Verify webhook signatures, timestamps, event identifiers, and replay windows.
- [ ] Durably acknowledge provider webhooks before background processing.
- [ ] Add a dead-letter and controlled replay path.
- [ ] Add OpenAPI or equivalent machine-readable REST contracts.
- [ ] Add consumer-driven contract tests for product clients.

#### Exit gate

- [ ] Native product calls and internal agent calls produce identical domain and audit outcomes.
- [ ] Provider webhook duplication and reordering tests pass.
- [ ] Long-running operations remain observable after client disconnect.

### Phase 5 — Native-agent validation

Native Kasitek agents must use the action layer before external clients receive access.

- [ ] Convert one existing agent workflow to the invocation gateway.
- [ ] Remove its direct database/provider write path.
- [ ] Propagate actor, delegation, tenant, client, and correlation context.
- [ ] Exercise read and draft actions in a real workflow.
- [ ] Exercise one approved external action in a controlled environment.
- [ ] Add operator views for runs, steps, approvals, effects, and failures.
- [ ] Add cancellation, retry, and safe replay controls.
- [ ] Measure latency, errors, approval completion, retries, and cost.

#### Exit gate

- [ ] The selected native workflow operates through actions in production or an equivalent controlled pilot.
- [ ] Operators can disable it without disabling the whole product runtime.
- [ ] No direct-write escape path remains for that workflow.

### Phase 6 — MCP read-and-draft pilot

#### MCP transport and lifecycle

- [ ] Implement Streamable HTTP for the pinned MCP revision.
- [ ] Implement `initialize`, version negotiation, capabilities, and `notifications/initialized`.
- [ ] Require the negotiated protocol-version header on subsequent requests.
- [ ] Validate `Origin` and reject invalid origins.
- [ ] Enforce content type, body size, timeouts, concurrency, and rate limits.
- [ ] Return protocol errors separately from tool-execution errors.
- [ ] Add structured logging and traces without logging tool payloads by default.
- [ ] Test disconnect, retry, and malformed JSON-RPC behaviour.

#### OAuth protected resource

- [ ] Publish OAuth Protected Resource Metadata.
- [ ] Advertise at least one valid authorization server.
- [ ] Return correct `WWW-Authenticate` challenges for missing or insufficient authority.
- [ ] Publish OAuth or OpenID Connect authorization-server discovery metadata.
- [ ] Support authorization code with PKCE for public clients.
- [ ] Validate exact redirect URIs and state.
- [ ] Require the OAuth resource indicator for the MCP server.
- [ ] Validate issuer, audience, signature, expiry, not-before, client, subject, and scopes.
- [ ] Never accept or forward tokens issued for another resource.
- [ ] Support refresh-token rotation where applicable.
- [ ] Audit consent, grant, refresh, revocation, and failed token validation.

#### MCP tool adapter

- [ ] Implement `tools/list` from approved action metadata.
- [ ] Implement `tools/call` through the invocation gateway.
- [ ] Re-authorise every call even if the tool appeared in discovery.
- [ ] Use stable tool names and JSON Schema 2020-12-compatible schemas.
- [ ] Return schema-valid `structuredContent` plus safe text compatibility output where useful.
- [ ] Annotate tool behaviour accurately; never rely on annotations as enforcement.
- [ ] Reject unknown fields where ambiguity could create unsafe effects.
- [ ] Return correlation and durable operation identifiers without internal implementation details.

#### Pilot catalogue

- [ ] Expose `customer.search`.
- [ ] Expose `conversation.get_summary`.
- [ ] Expose `conversation.draft_reply`.
- [ ] Keep send, publish, launch, delete, billing, credential, and access tools disabled.
- [ ] Restrict pilot clients and tenants through an allowlist and feature flag.

#### Conformance and security

- [ ] Test with at least two independent MCP clients.
- [ ] Test protocol-version mismatch and unsupported capability negotiation.
- [ ] Test token audience, issuer, expiry, scope, and revocation failures.
- [ ] Test cross-tenant tool arguments and indirect object references.
- [ ] Test prompt-injection attempts against tool descriptions and returned content.
- [ ] Test oversized, deeply nested, slow, and malformed inputs.
- [ ] Test rate limits by client, user, tenant, and tool.
- [ ] Complete a security review before moving beyond the allowlist.

#### Exit gate

- [ ] Read-and-draft tools run for pilot tenants with no cross-scope findings.
- [ ] OAuth discovery and consent work in supported MCP clients.
- [ ] Revocation, kill switches, audit, and incident procedures have been exercised.

### Phase 7 — MCP controlled external actions

Add write tools one at a time. Each tool needs its own risk review and release gate.

- [ ] Select one low-blast-radius controlled-write action.
- [ ] Define exact permission, entitlement, rate, approval, and idempotency rules.
- [ ] Provide a dry-run or effect-preview mode.
- [ ] Bind approval to the final target and payload hash.
- [ ] Re-authorise immediately before execution.
- [ ] Record the external effect and provider result.
- [ ] Add reconciliation for unknown outcomes.
- [ ] Add tenant-configurable enable/disable and approval policy.
- [ ] Add per-tool usage and failure dashboards.
- [ ] Run a limited pilot before adding another write tool.

Candidate progression:

```text
assign_conversation
  -> schedule_approved_post
  -> send_approved_message
  -> publish_approved_post
  -> launch_approved_campaign
```

Delete, billing, access-management, credential-management, and bulk-export actions remain privileged and are not part of the initial external MCP release.

#### Exit gate

- [ ] Duplicate and replay tests prove exactly-once logical effects.
- [ ] Human approval shows the precise external effect.
- [ ] The action can be disabled without gateway downtime.
- [ ] Pilot evidence supports expansion to the next tool.

### Phase 8 — A2A readiness gate

A2A work does not begin merely because MCP is available.

#### Required evidence

- [ ] A real partner or internal use case requires independent agent-to-agent delegation.
- [ ] The work is long-running or collaborative enough that MCP tool calls are insufficient.
- [ ] The internal run state machine supports working, input-required, approval/auth-required, completed, failed, cancelled, and rejected outcomes.
- [ ] Cancellation and resumability are proven.
- [ ] Artifact storage, retention, scanning, and access control are defined.
- [ ] Delegated identity and downstream authority attenuation are defined.
- [ ] External callback SSRF and credential risks have mitigations.
- [ ] Commercial entitlement, support, and partner trust policies are accepted.
- [ ] A2A 1.0 interoperability has been prototyped without production exposure.

#### Gate decision

- [ ] Record an ADR to proceed, defer, or reject A2A implementation.

### Phase 9 — A2A implementation, only after approval

#### Discovery and interfaces

- [ ] Publish a minimal public Agent Card at `/.well-known/agent-card.json`.
- [ ] Keep sensitive or tenant-specific skills out of the public card.
- [ ] Implement authenticated extended Agent Cards only if needed.
- [ ] Declare supported interfaces, versions, content types, skills, and security schemes accurately.
- [ ] Consider signed Agent Cards and define key rotation if signing is enabled.
- [ ] Require and validate the `A2A-Version` header.
- [ ] Return a version-not-supported error for unsupported versions.

#### Task mapping

- [ ] Map each external A2A task to one internal run without using the external ID as the database authority key.
- [ ] Implement send message, get task, list tasks, cancel task, and subscribe operations required by the chosen binding.
- [ ] Map messages and artifacts to scanned, classified internal content.
- [ ] Scope every task read, list, cancel, subscription, and artifact operation before querying data.
- [ ] Preserve task state transition rules and terminal-state immutability.
- [ ] Make cancellation idempotent.
- [ ] Use `AUTH_REQUIRED` only with a safe out-of-band credential or approval flow.
- [ ] Never pass reusable credentials through an agent chain.

#### Streaming and push notifications

- [ ] Implement streaming with bounded connections, backpressure, and resumability.
- [ ] Authenticate push notification delivery.
- [ ] Validate callback URLs against SSRF, DNS rebinding, private-address, redirect, and scheme attacks.
- [ ] Use unique callback secrets and rotate them.
- [ ] Deliver notifications at least once and require idempotent receivers.
- [ ] Set retry limits, exponential backoff, timeout, and disable thresholds.
- [ ] Let operators inspect and disable failing subscriptions.

#### Exit gate

- [ ] Interoperability tests pass with at least one independent A2A implementation.
- [ ] Tenant/task enumeration and callback-security tests pass.
- [ ] Delegation never increases the originating authority.
- [ ] Production exposure is limited to approved peers and skills.

### Phase 10 — Production hardening and general availability

- [ ] Define SLOs for gateway availability, invocation latency, queue delay, approval delay, and result delivery.
- [ ] Define error budgets and capacity limits.
- [ ] Add dashboards by protocol, client, tenant, action, outcome, and risk class.
- [ ] Alert on authentication anomalies, denial spikes, cross-scope attempts, replay, duplicate effects, and queue backlog.
- [ ] Document client onboarding, credential rotation, revocation, and offboarding.
- [ ] Document incident response and emergency disablement.
- [ ] Document protocol and tool-version deprecation.
- [ ] Load-test discovery, invocation, streaming, and long-running polling.
- [ ] Run backup and restore exercises for grants, approvals, runs, and audit evidence.
- [ ] Complete privacy, security, and operational readiness reviews.
- [ ] Publish tested-client and supported-action documentation.
- [ ] Remove pilot allowlists only after formal go-live approval.

## 9. Action release checklist

Complete this checklist for every new action, regardless of protocol.

### Ownership and contract

- [ ] Owning domain and implementation owner are named.
- [ ] Business outcome and non-goals are stated.
- [ ] Input and output schemas are versioned.
- [ ] Risk class and data classification are correct.
- [ ] Runtime and actor support are explicit.
- [ ] Direct and white-label differences are documented.

### Authority

- [ ] Required grants and OAuth scopes are minimal.
- [ ] Tenant/organisation and client scope cannot be overridden by arguments.
- [ ] Entitlement and limits are enforced.
- [ ] Approval policy is defined and tested.
- [ ] Delegated authority cannot exceed originating authority.

### Execution safety

- [ ] Idempotency behaviour is defined.
- [ ] Timeout, retry, cancellation, and reconciliation are defined.
- [ ] External effect preview is available where applicable.
- [ ] Provider failure cannot create a false success.
- [ ] Result and error content are safe for external clients.

### Evidence and operations

- [ ] Audit event contains the required evidence.
- [ ] Sensitive payload fields are redacted or referenced safely.
- [ ] Usage and cost are metered.
- [ ] Metrics, traces, dashboards, and alerts exist.
- [ ] Tenant and platform kill switches exist.
- [ ] Runbook and support ownership exist.

### Testing and release

- [ ] Unit, schema, integration, and contract tests pass.
- [ ] Cross-tenant and cross-client tests pass.
- [ ] Replay and duplicate tests pass.
- [ ] Adversarial prompt and input tests pass.
- [ ] Feature-flagged pilot succeeds.
- [ ] Deprecation and rollback paths are defined.

## 10. Required test suites

| Suite | Required coverage |
| --- | --- |
| Action contract | Schema validation, version compatibility, stable errors, lifecycle state |
| Identity and OAuth | Discovery, PKCE, redirects, audience, issuer, scope, expiry, refresh, revocation |
| Policy | Roles, grants, entitlement, tenant/client scope, risk, approval, deny-by-default |
| Isolation | Direct versus white-label, tenant versus tenant, client versus client, cache/event/job scope |
| Execution | Idempotency, concurrency, crash recovery, retry, cancellation, compensation, reconciliation |
| MCP | Lifecycle, version negotiation, tools list/call, JSON-RPC errors, Streamable HTTP behaviour |
| A2A, when enabled | Agent Card, versions, task transitions, list/get/cancel scope, stream and push behaviour |
| Security | Injection, replay, SSRF, confused deputy, token passthrough, oversized input, rate limits |
| Operations | Kill switches, audit search, alerting, dead-letter replay, backup and restore |

## 11. Rollout controls

Every protocol and action release moves through:

```text
development
  -> automated conformance and security tests
  -> internal native-agent use
  -> selected test tenants
  -> allowlisted external clients
  -> limited production pilot
  -> general availability
```

Promotion requires recorded evidence from the preceding stage. A critical isolation, authorization, approval, duplicate-effect, or audit failure returns the action to the previous safe stage.

Required controls:

- [ ] protocol-level feature flag;
- [ ] client allowlist and revocation;
- [ ] tenant and organisation enablement;
- [ ] client-account scope enablement for white-label;
- [ ] action lifecycle state;
- [ ] per-action kill switch;
- [ ] approval-policy override toward stricter behaviour only;
- [ ] rate and spend limits;
- [ ] rollback or disable procedure tested before rollout.

## 12. Suggested implementation order

| Order | Work package | Depends on |
| --- | --- | --- |
| 1 | ADRs, threat model, protocol pins | Architecture accepted |
| 2 | Action types, registry, schemas, first three handlers | Work package 1 |
| 3 | Machine identities, grants, policy, entitlements | Work package 2 |
| 4 | Runs, approvals, effects, idempotency, audit and outbox | Work packages 2–3 |
| 5 | REST/webhook hardening and native-agent migration | Work package 4 |
| 6 | MCP OAuth protected resource and Streamable HTTP adapter | Work packages 3–5 |
| 7 | MCP read-and-draft pilot | Work package 6 |
| 8 | One controlled-write MCP action at a time | Successful work package 7 |
| 9 | A2A readiness review and prototype | Proven long-running internal execution and MCP operations |
| 10 | A2A limited partner pilot | Accepted A2A ADR and successful prototype |

## 13. Progress summary

Update this table as exit gates are verified. A phase is not complete because code exists; its exit gate must pass.

| Phase | Status | Evidence |
| --- | --- | --- |
| 0. Decisions and threat model | Not started | ADRs and threat model required |
| 1. Action foundation | In progress | Contracts, registry, schemas, scope enforcement, and initial definitions implemented; runtime handlers remain |
| 2. Grants and policy | Foundation in progress | Ordered fail-closed execution pipeline and abstract enforcement ports implemented; runtime adapters remain |
| 3. Runs and approvals | Not started | Recovery, replay, and audit evidence required |
| 4. REST/webhook hardening | Partial foundation | Product APIs and webhooks exist; shared action path not verified |
| 5. Native-agent validation | Not started | Existing workflows are not verified against the target gateway |
| 6. MCP read-and-draft pilot | Not started | No MCP server verified |
| 7. MCP controlled actions | Blocked by design | Requires successful read-and-draft pilot |
| 8. A2A readiness gate | Research | Requires proven internal execution and a real delegation use case |
| 9. A2A implementation | Not authorised | Requires accepted readiness ADR |
| 10. Production hardening | Not started | Begins incrementally with each production phase |

## 14. Completion rule

Checklist items are marked complete only when there is reviewable evidence: merged code, migrations, tests, security review, operational dashboard, runbook, or an accepted ADR. If evidence becomes invalid after an architecture or protocol change, reopen the item.
