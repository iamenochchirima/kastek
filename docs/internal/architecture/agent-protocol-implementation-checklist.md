---
title: Agent Protocol Implementation Checklist
slug: /architecture/agent-protocol-implementation-checklist
sidebar_position: 6
---

# Agent Protocol Implementation Checklist

This is the working checklist for implementing the REST, webhook, action, MCP, and later A2A architecture defined in the [Kasitek Platform Architecture](./kasitek-technical-blueprint.md).

Detailed requirements and exit gates are in the [Agent Protocol Implementation Plan](./agent-protocol-implementation-plan.md). The agreed code structure and production design are preserved in the [Action Platform Technical Design](./action-platform-technical-design.md). This page is the day-to-day progress tracker.

## How this checklist is used

- Mark an item complete only when reviewable evidence exists.
- Evidence can be code, tests, migrations, an accepted ADR, a security review, a dashboard, or a runbook.
- Code existing does not complete a phase; the phase exit gate must pass.
- Reopen an item if a later architecture or protocol change invalidates its evidence.
- Direct and white-label implementations must remain separate runtime and database boundaries.
- MCP and A2A must use the internal action layer. They may not call product databases directly.

## Status summary

| Phase | Status | Exit evidence |
| --- | --- | --- |
| 0. Architecture decisions and security baseline | In progress | ADRs, protocol pins, and threat model |
| 1. Action foundation | In progress | Contracts, registry, schemas, catalog, and contract tests implemented; runtime handlers remain |
| 2. Identity, grants, policy, and entitlements | Foundation in progress | Pipeline shell implemented; runtime policy adapters and persistence remain |
| 3. Runs, approvals, effects, and audit | Not started | Recovery, replay, and approval-integrity tests |
| 4. REST and webhook hardening | Partial foundation | Shared action path and contract tests |
| 5. Native-agent validation | Not started | One real workflow uses only actions |
| 6. MCP read-and-draft pilot | Not started | Secure allowlisted pilot |
| 7. MCP controlled actions | Blocked | Requires successful Phase 6 |
| 8. A2A readiness decision | Research | Accepted proceed, defer, or reject ADR |
| 9. A2A implementation | Not authorised | Requires accepted Phase 8 decision |
| 10. Production hardening | Not started | Operational and security readiness approval |

## Current focus

**Current phase:** Phase 1 — Protocol-neutral action foundation

**Completed slices:** Action contracts and registry; protocol-neutral execution pipeline shell.

**Next implementation slice:** Connect `customer.search` to separate direct and white-label domain handlers, with database isolation and pagination tests.

---

## Phase 0 — Architecture decisions and security baseline

### Documentation foundation

- [x] Publish the target Kasitek platform architecture.
- [x] Publish the detailed agent protocol implementation plan.
- [x] Publish this working implementation checklist.
- [x] Publish the action platform technical design for review.
- [ ] Name the engineering owner for the action and protocol platform.
- [ ] Define the review cadence for this checklist.

### Required architecture decisions

- [ ] Decide whether Kasitek will adopt or operate the OAuth 2.1 authorization server.
- [ ] Decide the MCP endpoint topology for direct and white-label runtimes.
- [ ] Decide whether the agent protocol gateway starts as a separate deployment or an application module.
- [x] Decide the action naming and versioning convention.
- [ ] Decide the OAuth scope naming convention.
- [ ] Decide the approval rules for each risk class.
- [ ] Decide approval expiry, revocation, payload binding, and four-eyes rules.
- [ ] Decide audit retention and sensitive-data redaction rules.
- [ ] Decide how existing automation workflows connect to the new execution model.
- [ ] Record each accepted decision as an ADR.

### Protocol baselines

- [ ] Pin MCP protocol revision `2025-11-25` in configuration and tests.
- [ ] Record that MCP experimental Tasks are not the internal source of execution truth.
- [ ] Record A2A `1.0` as research-only until the readiness gate passes.
- [ ] Define how protocol upgrades are reviewed and tested.
- [ ] Create the supported-client compatibility matrix.

### Threat model

- [ ] Threat-model authentication and OAuth redirect flows.
- [ ] Threat-model token theft, token passthrough, and confused-deputy attacks.
- [ ] Threat-model cross-tenant and cross-client discovery and invocation.
- [ ] Threat-model prompt injection causing unsafe tool calls.
- [ ] Threat-model replayed requests and replayed approvals.
- [ ] Threat-model malicious tool arguments and file references.
- [ ] Threat-model webhook and callback SSRF.
- [ ] Threat-model support and operator elevation.
- [ ] Define mitigations and owners for every high-risk threat.
- [ ] Define emergency kill switches by protocol, client, tenant, and action.

### Phase 0 exit gate

- [ ] Required ADRs are accepted.
- [ ] The threat model has no unowned critical mitigation.
- [ ] MCP is pinned and A2A remains disabled.

---

## Phase 1 — Protocol-neutral action foundation

### Shared action contracts

- [x] Create the shared `actions` crate/module.
- [x] Define action name and semantic version.
- [x] Define owning domain.
- [x] Define input and output JSON Schemas.
- [x] Define risk class.
- [x] Define supported product runtimes and actor types.
- [x] Define organisation, tenant, and client-scope requirements.
- [x] Define required grants and OAuth scopes.
- [x] Define required entitlement.
- [x] Define idempotency requirements.
- [x] Define approval requirements.
- [x] Define audit, usage, and data-classification requirements.
- [x] Define action lifecycle states.

### Invocation and result contracts

- [ ] Define the complete invocation context.
- [x] Require actor identity and delegated authority.
- [x] Require direct or white-label runtime selection.
- [x] Require organisation or tenant scope.
- [x] Require client scope for tenant-client actors.
- [x] Require invocation, correlation, and causation identifiers.
- [x] Support idempotency key and deadline.
- [x] Define succeeded, accepted, approval-required, denied, and failed outcomes.
- [x] Define safe stable error and denial codes.
- [ ] Prevent internal errors and cross-tenant resource existence from leaking.

### Action registry

- [x] Register action definitions by stable name and version.
- [x] Reject duplicate name and version registrations.
- [x] Validate action metadata during startup or build.
- [x] List actions by runtime, lifecycle, actor, and grant.
- [x] Prevent callers from selecting their own risk class or entitlement.
- [x] Add registry unit tests.

### First vertical slice

- [x] Define `customer.search` as a read action.
- [x] Define `conversation.get_summary` as a read action.
- [x] Define `conversation.draft_reply` as a draft action.
- [ ] Implement direct-runtime handlers.
- [ ] Implement white-label handlers.
- [ ] Enforce tenant-client scope in white-label handlers.
- [x] Validate input and output against the declared schemas.
- [x] Add usage and audit metadata.

### Phase 1 verification

- [x] Missing actor fails closed.
- [x] Missing runtime is unrepresentable because runtime is derived from the typed scope.
- [x] Missing organisation or tenant scope fails closed.
- [x] Missing required client scope fails closed.
- [x] Direct identities cannot enter white-label scope.
- [x] White-label identities cannot enter direct scope.
- [ ] Cross-tenant identifiers do not reveal resource existence.
- [ ] Cross-client identifiers do not reveal resource existence.
- [x] Schema validation failures return stable internal error categories.
- [x] Registry and contract-level realm isolation tests pass.

### Phase 1 exit gate

- [ ] All three actions execute through the registry.
- [ ] No handler trusts tenant scope supplied only in action arguments.
- [ ] Direct and white-label contract isolation tests pass.

---

## Slice 2 — Protocol-neutral execution pipeline shell

This slice proves orchestration behavior with in-memory adapters. It does not claim that identity, grants, entitlements, approvals, idempotency, or journalling are durable yet.

- [x] Create the separate `execution` crate.
- [x] Define ports for clock, identity, access, entitlements, policy, idempotency, journal, and action execution.
- [x] Inject time through a clock port for deterministic deadline enforcement.
- [x] Enforce the order: request validation, deadline, identity, access, entitlements, policy, idempotency, journal start, action execution, output validation, journal finish.
- [x] Stop before later stages when any gate denies or fails.
- [x] Return safe denial and failure codes without dependency error details.
- [x] Return approval-required without starting an action run.
- [x] Return an existing idempotent outcome without starting another run.
- [x] Require journal start to succeed before invoking an action handler.
- [x] Validate completed handler output against the registered action schema.
- [x] Reject empty durable-operation identifiers.
- [x] Prove ordering and short-circuit behavior with in-memory contract tests.
- [ ] Implement runtime-owned production adapters for every port.
- [ ] Add durable transaction boundaries for runs, idempotency, audit, and outbox records.

---

## Phase 2 — Identity, grants, policy, and entitlements

### Machine identity and grants

- [ ] Define human, API client, native agent, and external agent actor types.
- [ ] Store machine-client owner, runtime, status, redirect URIs, and scopes.
- [ ] Store action grants by actor and runtime scope.
- [ ] Support tenant and client-specific grants.
- [ ] Support grant expiry and immediate revocation.
- [ ] Map roles to default grants without making roles the only policy input.
- [ ] Reject inactive users, clients, tenants, organisations, and connections.

### Policy pipeline

- [ ] Implement identity validation.
- [ ] Implement runtime validation.
- [ ] Implement organisation or tenant validation.
- [ ] Implement client-scope validation.
- [ ] Implement grant evaluation.
- [ ] Implement entitlement and usage-limit evaluation.
- [ ] Implement risk and approval evaluation.
- [ ] Produce allow, deny, or approval-required decisions.
- [ ] Record policy version and decision basis.
- [ ] Add tenant and action kill switches.
- [ ] Apply rate limits before domain execution.

### Phase 2 exit gate

- [ ] Revocation meets the accepted response objective.
- [ ] REST, native-agent, and protocol callers receive consistent policy decisions.
- [ ] All missing or invalid policy context fails closed.

---

## Phase 3 — Durable runs, approvals, effects, and audit

### Persistence

- [ ] Add direct-runtime agent client and grant migrations.
- [ ] Add white-label agent client and grant migrations.
- [ ] Add run, step, and attempt records.
- [ ] Add approval request and decision records.
- [ ] Add idempotency and external-effect records.
- [ ] Add outbox records for run and approval changes.
- [ ] Add audit records and indexes.
- [ ] Ensure tenant-owned indexes begin with tenant/workspace scope.

### Approval integrity

- [ ] Bind approval to actor, scope, action, target, payload hash, version, and expiry.
- [ ] Invalidate approval when a bound field changes.
- [ ] Prevent self-approval where four-eyes policy applies.
- [ ] Make decisions append-only.
- [ ] Support reject, expire, revoke, and cancel.
- [ ] Show the exact external effect to the approver.
- [ ] Resume approved work exactly once.

### Execution safety

- [ ] Prevent concurrent duplicate execution.
- [ ] Reconcile unknown provider outcomes.
- [ ] Define timeout and retry behaviour.
- [ ] Define cancellation and compensation behaviour.
- [ ] Separate diagnostic telemetry from audit evidence.
- [ ] Trace an invocation from actor to provider result.

### Phase 3 exit gate

- [ ] Crash-recovery tests pass.
- [ ] Duplicate-effect and replay tests pass.
- [ ] Approval mutation and replay tests pass.
- [ ] Execution and audit evidence is queryable by operators.

---

## Phase 4 — REST and webhook foundation

- [ ] Route agent-facing REST actions through action handlers.
- [ ] Add idempotency keys to mutating APIs.
- [ ] Add durable operation-status endpoints.
- [ ] Standardise error envelopes and correlation identifiers.
- [ ] Publish machine-readable REST contracts.
- [ ] Add consumer contract tests.
- [ ] Verify webhook signatures, timestamps, identifiers, and replay windows.
- [ ] Acknowledge webhooks only after durable receipt.
- [ ] Add dead-letter and controlled replay handling.
- [ ] Add provider-event duplication and reordering tests.

### Phase 4 exit gate

- [ ] Product and agent calls produce the same domain and audit outcomes.
- [ ] Webhook retry, duplication, and reordering tests pass.
- [ ] Long-running work remains observable after disconnect.

---

## Phase 5 — Native-agent validation

- [ ] Select one existing native agent workflow.
- [ ] Move it to the invocation gateway.
- [ ] Remove its direct database and provider write path.
- [ ] Propagate actor, tenant, client, delegation, and correlation context.
- [ ] Exercise read and draft actions.
- [ ] Exercise one approved controlled action.
- [ ] Add operator views for runs, approvals, effects, and failures.
- [ ] Add cancellation, retry, and safe replay controls.
- [ ] Measure latency, failures, approvals, retries, and cost.

### Phase 5 exit gate

- [ ] The workflow operates entirely through actions in a controlled environment.
- [ ] It can be disabled independently.
- [ ] No direct-write escape path remains.

---

## Phase 6 — MCP read-and-draft pilot

### Transport and protocol lifecycle

- [ ] Implement MCP Streamable HTTP.
- [ ] Implement initialization and version negotiation.
- [ ] Implement capability negotiation.
- [ ] Require the negotiated protocol-version header.
- [ ] Validate `Origin`.
- [ ] Enforce content type, body size, timeout, concurrency, and rate limits.
- [ ] Separate protocol errors from tool-execution errors.

### OAuth protected resource

- [ ] Publish OAuth Protected Resource Metadata.
- [ ] Publish authorization-server discovery metadata.
- [ ] Return correct `WWW-Authenticate` challenges.
- [ ] Support authorization code with PKCE.
- [ ] Validate exact redirect URIs and state.
- [ ] Require OAuth resource indicators.
- [ ] Validate issuer, audience, signature, expiry, client, subject, and scopes.
- [ ] Prohibit token passthrough.
- [ ] Support refresh rotation and revocation where applicable.

### Tool adapter and pilot catalogue

- [ ] Implement `tools/list` from the action registry.
- [ ] Implement `tools/call` through the invocation gateway.
- [ ] Re-authorise every tool call.
- [ ] Return schema-valid structured results.
- [ ] Expose `customer.search`.
- [ ] Expose `conversation.get_summary`.
- [ ] Expose `conversation.draft_reply`.
- [ ] Keep send, publish, launch, delete, billing, credential, and access tools disabled.
- [ ] Restrict access with tenant and client allowlists.

### Phase 6 exit gate

- [ ] Test with at least two independent MCP clients.
- [ ] OAuth discovery and consent work end to end.
- [ ] Cross-tenant, token, schema, injection, and rate-limit tests pass.
- [ ] Revocation and kill-switch exercises pass.
- [ ] Security review approves the limited pilot.

---

## Phase 7 — MCP controlled actions

- [ ] Select one low-blast-radius controlled-write action.
- [ ] Define its exact grant, entitlement, limit, and approval policy.
- [ ] Provide dry-run or effect preview.
- [ ] Bind approval to the final effect.
- [ ] Re-authorise immediately before execution.
- [ ] Enforce idempotency and reconciliation.
- [ ] Add tenant-configurable enablement.
- [ ] Add metrics, alerts, and kill switch.
- [ ] Run a limited pilot before selecting another write action.

Suggested order:

- [ ] `assign_conversation`
- [ ] `schedule_approved_post`
- [ ] `send_approved_message`
- [ ] `publish_approved_post`
- [ ] `launch_approved_campaign`

### Phase 7 exit gate

- [ ] Duplicate and replay tests prove one logical effect.
- [ ] Approval displays the precise external effect.
- [ ] The action can be disabled without gateway downtime.
- [ ] Pilot evidence supports the next action.

---

## Phase 8 — A2A readiness decision

- [ ] A real delegation use case exists.
- [ ] MCP calls are insufficient for that use case.
- [ ] Internal long-running run states are proven.
- [ ] Cancellation and resumability are proven.
- [ ] Artifact storage and scanning are defined.
- [ ] Delegated authority attenuation is defined.
- [ ] Callback SSRF protections are proven.
- [ ] Partner trust and commercial policies are accepted.
- [ ] An A2A `1.0` interoperability prototype succeeds without production exposure.
- [ ] Record an ADR to proceed, defer, or reject A2A.

---

## Phase 9 — A2A implementation

This phase remains blocked until Phase 8 explicitly authorises it.

- [ ] Publish a minimal public Agent Card.
- [ ] Keep sensitive skills out of public discovery.
- [ ] Declare supported versions, interfaces, skills, and authentication accurately.
- [ ] Validate the `A2A-Version` header.
- [ ] Map external tasks to internal runs.
- [ ] Implement required message and task operations.
- [ ] Enforce task and artifact scope before database queries.
- [ ] Implement valid task-state transitions and terminal-state immutability.
- [ ] Implement idempotent cancellation.
- [ ] Keep credentials out of agent chains.
- [ ] Implement bounded streaming.
- [ ] Secure push callbacks against SSRF and replay.
- [ ] Test with an independent A2A implementation.

### Phase 9 exit gate

- [ ] Interoperability tests pass.
- [ ] Task enumeration and callback-security tests pass.
- [ ] Delegation never increases originating authority.
- [ ] Production access is limited to approved peers and skills.

---

## Phase 10 — Production hardening

- [ ] Define protocol and action SLOs.
- [ ] Define capacity limits and error budgets.
- [ ] Add dashboards by client, tenant, action, outcome, and risk.
- [ ] Alert on authentication anomalies and cross-scope attempts.
- [ ] Alert on approval replay, duplicate effects, and queue backlog.
- [ ] Document onboarding, rotation, revocation, and offboarding.
- [ ] Document emergency disablement and incident response.
- [ ] Document protocol and action deprecation.
- [ ] Load-test discovery, invocation, streaming, and polling.
- [ ] Restore-test grants, approvals, runs, and audit evidence.
- [ ] Complete security, privacy, and operational readiness reviews.

### Phase 10 exit gate

- [ ] Production readiness is formally approved.
- [ ] Pilot restrictions are removed only for approved actions and clients.
- [ ] Ongoing protocol review and checklist ownership are assigned.

---

## Per-action release checklist

Use this checklist for every action added to native agents, MCP, or A2A.

### Contract and ownership

- [ ] Owner and owning domain are named.
- [ ] Business outcome and non-goals are documented.
- [ ] Input and output schemas are versioned.
- [ ] Risk and data classification are reviewed.
- [ ] Supported runtimes and actors are explicit.

### Authority and isolation

- [ ] Grants and OAuth scopes are minimal.
- [ ] Tenant or organisation scope cannot be overridden by arguments.
- [ ] Client scope is enforced where required.
- [ ] Entitlement and limits are enforced.
- [ ] Approval policy is tested.
- [ ] Delegation cannot increase authority.

### Execution and evidence

- [ ] Idempotency behaviour is defined.
- [ ] Timeout, retry, cancellation, and reconciliation are defined.
- [ ] Provider failure cannot produce a false success.
- [ ] Audit evidence is complete and safely redacted.
- [ ] Usage and cost are metered.
- [ ] Metrics, alerts, and kill switch exist.

### Verification and rollout

- [ ] Unit, schema, integration, and contract tests pass.
- [ ] Cross-tenant and cross-client tests pass.
- [ ] Replay and duplicate tests pass.
- [ ] Adversarial prompt and input tests pass.
- [ ] Limited pilot succeeds.
- [ ] Disable, rollback, and deprecation paths exist.

## Evidence log

Add one row whenever a checklist group or exit gate is completed.

| Date | Checklist item or gate | Evidence | Reviewer |
| --- | --- | --- | --- |
| 2026-07-17 | Target architecture published | [Kasitek Platform Architecture](./kasitek-technical-blueprint.md) | Pending |
| 2026-07-17 | Detailed plan published | [Agent Protocol Implementation Plan](./agent-protocol-implementation-plan.md) | Pending |
| 2026-07-17 | Working checklist published | This document | Pending |
| 2026-07-18 | Core service design published for review | [Action Platform Technical Design](./action-platform-technical-design.md) | Pending |
| 2026-07-18 | Slice 1 action contracts and registry | `server/crates/actions`; 16 tests passed; strict Clippy passed; workspace check passed | Automated verification |
| 2026-07-18 | Slice 2 execution pipeline shell | `server/crates/execution`; 12 pipeline tests and 17 action tests passed; strict Clippy passed; workspace check passed | Automated verification |
