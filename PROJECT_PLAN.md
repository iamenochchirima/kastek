# KasiTek Project Plan

**Status:** Repository-level product and architecture direction

**Last reviewed:** 2026-08-13

## Purpose

This document defines the current system boundaries, product surfaces, and planning hierarchy for
the repository. It is the first reference for deciding which product and service owns a change.

It is not a feature checklist. Detailed programmes keep their implementation steps and completion
evidence in their own canonical execution documents. When a scoped execution plan exists, follow it
for that programme while preserving the boundaries in this file.

## Planning hierarchy

Use the narrowest current document that owns the work:

1. Explicit user instructions and approved product decisions for the task.
2. The scoped remediation or execution checklist for the active programme.
3. The approved architecture document for that programme.
4. This repository-level project plan for cross-product ownership and boundaries.
5. Supporting technical references and archived plans for historical context only.

For the current Agent Platform programme, the order is:

1. [`KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md`](KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md)
   for audited corrections that must be completed first.
2. [`KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md`](KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md)
   for ordered implementation and verification through all slices.
3. [`KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`](KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md)
   for approved architectural rationale and constraints.
4. This file for repository-wide ownership, especially separation between the direct and
   white-label platforms.

Documents under `docs/archive/` are not active plans. Documents under `docs/internal/` may explain
design or record progress, but they do not override a root canonical plan unless explicitly promoted.

## Product and service map

KasiTek has four related but distinct product areas.

### Direct KasiTek product

- `server/kasitek-core` owns the direct product backend, authoritative direct-product business data,
  existing product APIs, shared domain operations, provider effects, and the modular public `/v1`
  API.
- `client/apps/client` is the direct customer-facing application.
- Direct users authenticate through the direct-product identity and organization model.

### Internal KasiTek operations

- `client/apps/admin` is the internal operations application.
- Protected admin APIs and operator policy must remain distinct from customer product APIs.
- Support access, privileged commands, customer-content access, and dual-control operations require
  explicit policy. They must not be inferred from existing broad admin sessions.

### White-label tenant platform

- `server/kasitek-tenants` is the separate white-label backend.
- `client/apps/tenant-portal` is the unified white-label frontend for tenant staff and tenant clients.
- The tenant platform owns its own database and auth/session model.
- White-label runtime concerns must not be collapsed into `kasitek-core`.

### Shared Agent Platform

- `agents` owns agent definitions and installations, conversations, durable runs, model/tool runtime,
  approvals, capability grants, agent channels, knowledge/memory, and the separately deployed MCP
  gateway process.
- `kasitek-core` remains authoritative for direct-product business operations and final domain
  authorization. The Agent Platform receives no direct access to the core product database.
- `agents-api`, `agents-worker`, `agent-gateway`, and `kasitek-core` remain separate process
  responsibilities even when source code is housed in the same repository.
- The first implementation targets the direct KasiTek product while retaining explicit organization
  ownership and interfaces that can support the white-label platform later. This does not authorize
  the direct and tenant databases or identity systems to be merged.

## System boundaries

### Direct and white-label separation

- `kasitek-core` owns direct-product runtime concerns.
- `kasitek-tenants` owns tenant-specific auth, routing, data isolation, branding, and tenant runtime.
- The direct and white-label platforms use separate databases.
- Direct KasiTek users and tenant users are different identity systems.
- Shared contracts or libraries may be reused, but authoritative data and authentication boundaries
  remain explicit.

### API and transport separation

- Existing direct-product endpoints remain distinct from the independently managed public `/v1`
  API, private internal service routes, protected admin routes, provider webhooks, and anonymous
  website routes.
- MCP, public REST, browser controllers, and channels are transport adapters. They must converge on
  shared policy and domain operations rather than duplicate business logic.
- The public MCP gateway is a stateless transport process. It owns no database, Temporal workflow,
  approval, business policy, or product data.

### Data ownership

- PostgreSQL is authoritative for durable application and agent records in the service that owns
  them.
- Temporal owns durable agent workflow execution, waits, retries, schedules, and recovery; it is not
  the business database.
- Redis may support realtime delivery and caching but is not a source of truth.
- Credentials and provider secrets stay in the owning credential boundary and must not enter prompts,
  workflow history, logs, audit payloads, or protocol output.

### Identity and authorization

The repository supports multiple principal types; one authentication mechanism must not be treated
as interchangeable with another:

- direct product users and organization sessions;
- KasiTek internal administrators/operators;
- tenant staff;
- tenant clients;
- workspace API keys and service accounts;
- OAuth user and application grants;
- agent installations and short-lived service delegations.

Every consequential action must resolve a trusted organization and principal, evaluate current
scope/grant/entitlement/resource policy, and retain correlation and audit attribution. Authentication
alone is not authorization.

## White-label operating model

White-label remains a first-class product line with three live layers:

1. KasiTek platform
2. tenant admin/staff
3. tenant client/customer accounts

### KasiTek platform layer

KasiTek provisions and operates tenant workspaces, deployments, domains, plans, limits, billing,
support, and platform administration.

### Tenant admin/staff layer

Tenant administrators and staff manage their workspace, branding, staff, clients, services,
automations, conversations, reporting, and usage within their granted roles.

### Tenant client/customer layer

Tenant clients are first-class identities. They receive a tenant invitation or secure onboarding
flow, establish credentials, enter the branded tenant environment, and access only their own allowed
services and data.

Tenant staff and tenant clients should share `tenant-portal` where practical but retain separate
identity, authorization, layouts, and route areas.

## Agent Platform direction

The Agent Platform supports three modes through one installation, capability, runtime, approval, and
audit model:

- protected system-hosted KasiAi;
- KasiTek-hosted user agents;
- externally connected agents such as Codex, Claude, n8n, or customer runtimes.

The implementation must preserve these decisions:

- all modes use explicit organization-owned installations and filtered capabilities;
- hosted and external agents do not receive a shortcut around core business authorization;
- consequential effects require durable authorization, idempotency, approval where required,
  receipts, and recovery behavior;
- MCP and public REST are external adapters over common capability/domain operations;
- direct REST requests do not automatically become AgentRuns, but they retain API/action audit and
  usage evidence and link a run when an agent initiated them;
- production policy, entitlements, quotas, operator roles, and support access are implemented only
  from approved product decisions, never guessed by an implementation model.

Detailed sequencing and acceptance criteria live in the three root Agent Platform documents listed
in the planning hierarchy.

## Current execution priorities

### Agent Platform

1. Complete the root audit remediation checklist and its regression/integration gates.
2. Reconcile previously implemented foundations with the approved architecture.
3. Continue the execution blueprint from Slice 0 through Slice 13 in order.
4. Keep incomplete work unchecked and record genuine external/product blockers in `BLOCKERS.md`.
5. Do not expose MCP, public `/v1`, approvals, or real external effects until their security and
   recovery gates pass.

### White-label platform

Unless replaced by a newer scoped plan, preserve this dependency order:

1. tenant workspace resolution by domain/host;
2. tenant staff identity, roles, and sessions;
3. tenant client identity, invitations, credentials, and sessions;
4. real tenant backend integration in `tenant-portal`;
5. workspace/domain/branding/key/first-admin provisioning;
6. usage metering, billing controls, service entitlements, and operational tooling.

### Direct product and internal operations

- Extend existing domain implementations rather than building parallel placeholders.
- Keep product API migrations separate from styling migrations where practical.
- Preserve existing provider, auth, inbox, campaign, booking, content, billing, and PWA behavior while
  shared domain boundaries are introduced.
- Define explicit operator roles and support policy before enabling privileged Agent Platform admin
  actions.

## Decision and blocker policy

- Do not invent a product decision that changes access, billing, entitlement, retention, support,
  approval, or release policy.
- Record a genuine missing decision or unavailable external environment in root `BLOCKERS.md` with
  the affected checklist item, evidence, impact, and required next action.
- Ordinary unfinished implementation is not a blocker; it remains an unchecked item in its scoped
  execution plan.
- Continue all independent work after recording a blocker.
- Mark checklist items complete only after their implementation and required verification exist.

## Keeping this plan current

Update this file when repository-level ownership, product surfaces, identity boundaries, or the
canonical planning hierarchy changes. Put detailed feature steps and progress evidence in the scoped
execution document instead of expanding this file into a duplicate checklist.

When adding or superseding a canonical plan:

1. state its scope and status in that document;
2. link it from the planning hierarchy here;
3. update `AGENTS.md` if agent reading order changes;
4. archive or clearly demote superseded documents;
5. preserve settled cross-product boundaries unless an explicit approved decision changes them.
