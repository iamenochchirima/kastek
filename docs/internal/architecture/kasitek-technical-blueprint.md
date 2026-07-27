---
title: Architecture
slug: /architecture
sidebar_position: 4
---

# Kasitek Platform Architecture

This document defines the target architecture for the complete Kasitek platform. It is the technical reference for product boundaries, identity, tenancy, business domains, data, integrations, agents, security, and operations.

The target design is intentionally separate from the current implementation. [Implementation status](#16-implementation-status) appears at the end and does not constrain the architecture described above it.

## 1. Purpose and scope

### 1.1 Platform definition

The **Kasitek Platform** is the complete software ecosystem operated by Kasitek Labs. It includes:

- the platform control plane used to operate Kasitek;
- the direct Kasitek product sold to organisations;
- the white-label product operated for agencies and partners;
- shared standards and platform capabilities used by those products;
- controlled connections to messaging, social, AI, billing, automation, and customer systems.

```text
Kasitek Platform
|
|-- Platform Control Plane
|   `-- tenant lifecycle, domains, plans, usage, billing and support
|
|-- Direct Product Runtime
|   `-- Kasitek organisations, users and business data
|
|-- White-Label Runtime
|   `-- tenant workspaces, tenant staff and tenant client accounts
|
`-- Shared Platform Capabilities
    `-- contracts, policy standards, observability and reusable infrastructure
```

The direct and white-label products are separate product runtimes. They may reuse code, contracts, and infrastructure patterns, but they do not share an application database or identity/session store.

### 1.2 Product surfaces are not service boundaries

Kasitek product names describe customer experiences and commercial packaging. They do not automatically define backend services or databases.

```text
Product surface
    |
    v
Uses business capabilities from one or more domains
    |
    v
Implemented by modules inside a product runtime
    |
    v
Separated into deployable services only when justified
```

For example, KasiReach uses customer, audience, consent, campaign, messaging, integration, and reporting capabilities. It must not create separate copies of those business concepts merely because it is a distinct product surface.

### 1.3 Out of scope

This document does not define release dates, sales packaging, screen designs, individual provider API fields, or step-by-step implementation tasks. Those belong in the [Product Roadmap](../roadmap/product-roadmap.md), [Product Features](../features/product-features.md), product specifications, contracts, and delivery plans.

## 2. Architecture charter

The following principles govern implementation and future architecture decisions.

1. **One connected business system.** Customer communication, campaigns, content, workflows, and reporting use consistent business concepts rather than disconnected product copies.
2. **Separate direct and white-label runtimes.** Each has its own backend boundary, database, and identity/session model.
3. **Three first-class white-label layers.** Kasitek platform operators, tenant staff, and tenant client accounts are present from the start.
4. **Domains own business rules and data.** A UI, agent, integration, or protocol adapter may not bypass the domain that owns an operation.
5. **Scope is established before access.** Every protected action resolves the product runtime, organisation or tenant, actor, client scope, role, entitlement, and policy.
6. **Human and machine actions use the same controls.** Agents, workflows, API clients, and people act through typed, permissioned capabilities.
7. **External effects are safe to repeat.** Message sends, publishing, billing, webhooks, and jobs use idempotency, durable state, retries, and reconciliation.
8. **Sensitive actions are auditable.** Access changes, approvals, external sends, publishing, spending, exports, and destructive actions produce durable audit records.
9. **Modularity precedes distribution.** Each runtime starts as a well-modularised system. Deployment units split only for security, scale, reliability, ownership, or release independence.
10. **Failure is contained.** A provider, AI model, workflow engine, or analytics failure must not make the whole product unavailable.
11. **Security and privacy are design inputs.** Tenant isolation, least privilege, data minimisation, retention, recovery, and POPIA obligations are addressed in the architecture.
12. **The target design is measured.** Architecture decisions must be testable through automated checks, operational metrics, or reviewable evidence.

## 3. Stakeholders and quality goals

### 3.1 Primary stakeholders

| Stakeholder | Needs from the architecture |
| --- | --- |
| Kasitek platform operators | Provision, support, meter, secure, and recover the platform without unrestricted routine access to customer data. |
| Direct Kasitek organisation owners | A reliable workspace with clear ownership, permissions, billing, integrations, and audit history. |
| Direct organisation staff | Access appropriate to their role and assigned work. |
| White-label tenant owners and staff | A branded workspace for operating multiple client accounts with controlled delegation. |
| Tenant client users | Access only to their own organisation, services, data, approvals, and reports. |
| Developers and operators | Clear domain boundaries, contracts, failure behaviour, observability, and safe deployment paths. |
| Integration and agent builders | Stable, scoped APIs and capabilities without database access. |
| Data subjects | Lawful, secure, explainable handling of their personal information and communication preferences. |

### 3.2 Quality priorities

The priorities are ordered. Trade-offs should preserve the higher priority unless an architecture decision records why not.

| Priority | Quality | Required outcome |
| --- | --- | --- |
| 1 | Tenant isolation and security | No request, job, cache entry, event, export, or agent execution crosses an unauthorised organisation, tenant, or client boundary. |
| 2 | Correctness and auditability | External actions and access changes have traceable actors, inputs, decisions, effects, and outcomes. |
| 3 | Reliability and recoverability | Provider and worker failures are retried or reconciled without duplicate external effects or silent data loss. |
| 4 | Evolvability | New channels and product experiences extend canonical domains and contracts instead of duplicating them. |
| 5 | Operational simplicity | The platform remains understandable and supportable by the team; distributed infrastructure is introduced deliberately. |
| 6 | Performance and cost efficiency | Interactive work is responsive and background work scales independently without permanent over-provisioning. |

### 3.3 Initial service objectives

These are baseline targets to validate during capacity and commercial planning, not claims about the current implementation.

- Protected interactive APIs target 99.9% monthly availability, excluding planned maintenance and upstream provider failures.
- Normal interactive API requests target a p95 server response time below 500 ms, excluding long-running work and upstream provider latency.
- Valid provider webhooks should be durably accepted and acknowledged within 2 seconds before asynchronous processing.
- No acknowledged business event may be silently discarded. Failed processing must be visible and recoverable.
- Transactional data targets an initial recovery point objective of 15 minutes and recovery time objective of 4 hours.
- Every production restore procedure must be tested on a schedule, not assumed from the existence of backups.

## 4. System landscape and context

### 4.1 System landscape

```text
                         Kasitek Labs
                              |
                    +---------+---------+
                    |                   |
             Kasitek Platform       Services delivery
                    |              implementation/support
        +-----------+-----------+
        |                       |
 Direct Kasitek product   White-label product
        |                       |
 Organisations             Agencies / partners
 and their teams           and their client accounts
        |                       |
        +-----------+-----------+
                    |
   Inbox | Reach | Social | Agents | future product surfaces
                    |
        Shared business-domain capabilities
```

Kasitek services may configure or extend the platform, but service delivery does not become an alternate data or permission path.

### 4.2 System context

```text
 People                                  Kasitek Platform                         External systems

 Platform operators  ---------------->  Control plane  <--------------------  Billing provider
 Direct users        ---------------->  Direct runtime <--------------------  Identity/email services
 Tenant staff        ---------------->  White-label    <--------------------  WhatsApp / SMS / voice
 Tenant clients      ---------------->  runtime        <--------------------  Social networks
 Customer contacts   <--------------->  Channel edges  <--------------------  CRM / ERP / calendars
 Agent/API clients   ---------------->  API/MCP edge   <--------------------  AI and automation systems
                                                                             Object/file services
```

The platform owns its internal business state and audit records. Providers remain authoritative for provider-side delivery, account status, and channel-specific objects. Reconciliation resolves differences between the two.

## 5. Product operating model

### 5.1 Control plane and product data planes

```text
                         PLATFORM CONTROL PLANE
       tenant registry | provisioning | domains | plans | entitlements
       usage and billing | platform policy | support | operational status
                                  |
                    routing and entitlement metadata
                                  |
              +-------------------+-------------------+
              |                                       |
              v                                       v
       DIRECT PRODUCT RUNTIME                 WHITE-LABEL RUNTIME
       organisations and users                tenants and branding
       direct business records                tenant staff identities
       direct integrations                    tenant client accounts
       direct sessions                        tenant business records
              |                                       |
       direct database                         tenant database
```

The control plane manages the platform. It does not own conversations, campaigns, content, customer records, or routine tenant sessions. Product runtimes continue serving existing users if a non-critical control-plane function is temporarily unavailable, using bounded cached entitlement and routing data.

### 5.2 Control-plane responsibilities

- tenant and product-runtime registration;
- workspace provisioning and lifecycle state;
- domains, certificates, and routing metadata;
- plans, feature entitlements, limits, and usage summaries;
- subscriptions, invoices, and billing-provider coordination;
- platform-wide policy distribution;
- support access requests and time-bounded elevation;
- operational health and provisioning history.

### 5.3 Direct product runtime

The direct runtime serves organisations buying Kasitek directly. It owns direct users, memberships, sessions, customer operations, provider connections, and product-domain records.

### 5.4 White-label runtime

The white-label runtime serves agencies and partners under branded domains. It owns tenant-local identities and sessions, branding, client accounts, tenant business records, and client-scoped access.

The white-label runtime must not call the direct runtime to authenticate users or read normal business records.

### 5.5 Shared platform capabilities

Shared means reusable, not globally mutable by default. Suitable shared capabilities include:

- versioned API and event specifications;
- reusable domain libraries where semantics are identical;
- policy, audit, observability, tracing, and error standards;
- secure file-processing and notification infrastructure;
- provider adapter patterns and conformance tests;
- platform-issued machine identity and key-management standards.

Shared infrastructure must preserve separate runtime ownership and explicit tenant context.

## 6. Identity, tenancy, and access

### 6.1 Identity realms

```text
Kasitek Platform
|
|-- Platform identity realm
|   `-- platform operators and support identities
|
|-- Direct identity realm
|   `-- direct users -> organisation memberships -> roles and grants
|
|-- White-label identity realm
|   `-- tenant staff -> tenant roles and client assignments
|   `-- tenant clients -> one client account -> client roles and grants
|
`-- Machine identity realm
    `-- API clients, integrations, workers, agents and service accounts
```

An email address appearing in multiple realms does not make those identities the same account. Authentication, session revocation, and authorisation remain realm-specific.

### 6.2 White-label hierarchy

```text
Kasitek platform
`-- Tenant workspace
    |-- Tenant owner
    |-- Tenant staff
    |   |-- administrator
    |   |-- operator
    |   `-- analyst
    |
    `-- Client account
        |-- client owner
        |-- client collaborator
        `-- client viewer
```

A tenant staff member may be assigned to all clients or a defined subset. A tenant client identity belongs to a single client account unless an explicit future federation design is approved.

### 6.3 Request authorisation pipeline

```text
Request
  -> trusted host and domain resolution
  -> product runtime selection
  -> tenant or organisation resolution
  -> authentication and session validation
  -> actor status and membership
  -> client scope, where applicable
  -> role and explicit grants
  -> plan entitlement and usage limit
  -> action policy and approval requirement
  -> domain operation
  -> audit record
```

Client-supplied tenant, organisation, or client identifiers are never trusted by themselves. The server derives and verifies scope against the authenticated identity and resolved host.

### 6.4 Access-control model

Kasitek uses role-based access for understandable defaults and attribute/policy checks for context-sensitive actions.

- Roles group common permissions.
- Grants allow narrow exceptions without creating many roles.
- Attributes include organisation, tenant, client assignment, resource ownership, data sensitivity, entitlement, and action risk.
- Policies decide whether an action is allowed, denied, or requires approval.
- Deny is the default when scope or policy information is missing.

Privileged platform support access is time-bound, reason-bound, approved, and audited. Routine support must use metadata and diagnostics that do not expose customer content.

## 7. Domain model and ownership

### 7.1 Domain map

| Domain | Owns | Does not own |
| --- | --- | --- |
| Identity and access | identities, credentials, sessions, memberships, roles, grants, invitations | product-domain records |
| Platform and tenancy | tenant lifecycle, domains, branding, plans, entitlements, provisioning | tenant conversations or customer content |
| Customer and CRM | contacts, companies, leads, lifecycle, consent references, relationships | provider credentials |
| Conversations | threads, messages, participants, assignments, inbox state, handoff | campaign definitions or billing |
| Campaigns and journeys | audiences, segments, templates, schedules, sends, sequence state | tenant provisioning |
| Content and social | assets, brand guidance, calendars, posts, approvals, publishing state | customer authentication |
| Integrations | external connections, credentials, scopes, webhook registrations, sync cursors, health | product business policy |
| Agents and workflows | definitions, runs, steps, tools, approvals, execution state | unrestricted domain data |
| Billing and usage | plans, prices, entitlements, meters, invoices, payment state | customer communications |
| Reporting and analytics | derived metrics, projections, reporting models | authoritative transactional state |
| Audit and compliance | actor/action evidence, access history, retention and legal-hold metadata | mutable product workflow state |
| Notifications | user-facing notification requests, delivery preferences, delivery state | domain decisions that trigger notifications |

### 7.2 Product-to-domain mapping

| Product surface | Primary domains used |
| --- | --- |
| KasiInbox | Customer and CRM, Conversations, Integrations, Agents, Reporting |
| KasiReach | Customer and CRM, Campaigns, Conversations, Integrations, Reporting |
| KasiSocial | Content and social, Integrations, Agents, Reporting |
| KasiAgents | Agents and workflows plus controlled capabilities from every authorised domain |
| Future product surfaces | Must compose existing domains first and introduce a new domain only for a genuinely new business responsibility |

### 7.3 Dependency rules

- A domain changes its authoritative state only through its application service or command interface.
- Cross-domain reads use defined query contracts or purpose-built read models.
- Cross-domain side effects use application calls for immediate consistency or versioned events for asynchronous work.
- Reporting consumes domain events and projections; it does not become the source of transactional truth.
- Provider adapters translate external formats at the integration boundary and do not leak provider models into core domains.

## 8. Logical platform architecture

```text
EXPERIENCE
  Direct web app | Internal operations app | Tenant staff portal
  Tenant client portal | Embedded widgets | Approved API/agent clients
                                |
EDGE
  DNS/CDN/WAF | domain resolver | API edge | webhook edge | realtime edge
                                |
APPLICATION RUNTIMES
  Control plane | Direct product runtime | White-label runtime
                                |
DOMAIN MODULES
  Identity | Tenancy | CRM | Conversations | Campaigns | Content
  Integrations | Agents/Workflows | Billing/Usage | Reporting | Audit
                                |
ASYNC EXECUTION
  transactional outbox | queues | schedulers | workers | dead-letter handling
                                |
DATA AND PLATFORM SERVICES
  relational stores | object storage | cache | search | secrets | observability
                                |
EXTERNAL PROVIDERS
  messaging | social | voice | email | AI | billing | CRM/ERP | automation
```

### 8.1 Experience architecture

The user experiences remain separately deployable applications even when they share a design system, API client, and domain types.

| Experience | Audience | Boundary |
| --- | --- | --- |
| Direct Kasitek application | Direct organisation owners and staff | Uses only direct-runtime sessions and APIs. |
| Internal operations application | Authorised Kasitek operators | Uses control-plane and separately authorised support capabilities. |
| Tenant portal: staff area | Tenant owners, administrators, operators, and analysts | Uses tenant-staff sessions, tenant-wide permissions, and assigned client scope. |
| Tenant portal: client area | Tenant client owners, collaborators, and viewers | Uses tenant-client sessions and a mandatory single-client scope. |
| Embedded widgets | External customer contacts | Use narrow public or short-lived channel-specific credentials. |

The tenant staff and client areas may share one frontend application, but they have separate route areas, layouts, session checks, and capability navigation. Hiding a control in the interface is not authorisation; the runtime enforces every action.

Tenant branding is resolved from a trusted host and a versioned branding configuration. Branding may change names, themes, assets, support details, and enabled navigation, but it may not change security policy or expose unavailable capabilities.

Shared frontend packages should contain presentation primitives, accessible components, typed API clients, validation helpers, and stable domain types. They must not contain product-specific authorisation assumptions that collapse the direct and white-label identity realms.

### 8.2 Initial deployment style

The direct and white-label backends should each begin as a modular application with independently scalable workers. A module becomes a separate service only when at least one of these conditions is demonstrated:

- it requires materially different scaling;
- it has a stronger security or compliance boundary;
- its failure must be isolated from the main runtime;
- it needs independent release ownership;
- its workload or technology is unsuitable for the main runtime;
- operational evidence shows the modular deployment is insufficient.

This avoids distributed-system cost while preserving clear extraction boundaries.

## 9. Data architecture

### 9.1 Data ownership and isolation

```text
Control-plane database
  tenants | domains | plans | entitlements | usage summaries | billing

Direct product database
  direct identities | organisations | direct business-domain records

White-label database
  tenant identities | tenant clients | tenant business-domain records

Object storage
  runtime + tenant/organisation namespaces | encryption | lifecycle rules

Analytics store / read models
  derived, minimised, lineage-tracked data only
```

The direct and white-label databases are separate. The default white-label model is pooled multi-tenancy within the white-label database, with mandatory `tenant_id` ownership on tenant-controlled records and `client_id` where client isolation applies.

Tenant isolation is enforced in several layers:

- host-to-tenant resolution;
- authenticated membership and client assignment;
- repository/query scope that cannot be omitted by normal callers;
- database constraints and row-level policies where practical;
- tenant-aware cache keys, object paths, events, jobs, logs, and search indexes;
- automated cross-tenant isolation tests.

A dedicated database or deployment may be offered for tenants with contractual isolation requirements, but it must preserve the same domain contracts and operational model.

### 9.2 Transaction and event pattern

```text
Domain command
    |
    +-- update authoritative records --+
    |                                  | one transaction
    +-- append outbox event -----------+
                                       |
                                       v
                              Outbox publisher
                                       |
                                       v
                       Queue / event subscribers
                     workers | analytics | notifications
```

The transactional outbox prevents a successful database change from losing its corresponding event. Consumers are idempotent and record processed event identifiers where duplicate delivery could cause harm.

### 9.3 Canonical event envelope

Every durable business event contains:

- globally unique event identifier;
- stable event type and schema version;
- occurrence and publication timestamps;
- originating runtime and organisation or tenant scope;
- client scope when applicable;
- actor, correlation, and causation identifiers;
- data classification;
- minimal event payload or a scoped reference to authoritative data.

Events must not contain credentials or unnecessary personal information.

### 9.4 Data lifecycle

- Data is classified as public, internal, confidential, or restricted.
- Collection and retention are limited to defined product, legal, security, and operational purposes.
- Deletion and export operate across authoritative records, objects, search indexes, caches, analytics projections, and eligible backups.
- Audit and financial records may follow different retention rules, recorded with their lawful basis.
- Backups are encrypted, access-controlled, monitored, and restore-tested.

## 10. Integrations and event processing

### 10.1 Standard provider path

```text
Provider webhook
      |
      v
Edge validation: source, signature, timestamp, size, rate limit
      |
      v
Durable receipt and acknowledgement
      |
      v
Provider adapter and canonical event
      |
      +--> domain state update
      +--> workflow or agent trigger
      +--> notification
      +--> reporting projection
      `--> audit evidence
```

Outbound operations follow the inverse pattern: a domain records the requested operation, a worker calls the provider with an idempotency key, and webhook or reconciliation results update the operation state.

### 10.2 External connection model

An external account belongs to an organisation or tenant, not to a product screen.

```text
Organisation or tenant
    |
External connection
    |-- provider identity and lifecycle status
    |-- granted scopes and business capabilities
    |-- consuming product surfaces
    |-- health, sync cursor and webhook status
    `-- encrypted provider credential reference
```

Lifecycle states are `NOT_CONNECTED`, `CONNECTING`, `CONNECTED`, `NEEDS_ATTENTION`, `DISCONNECTED`, and `REVOKED`. A connection can be usable only when its provider status, required scopes, entitlement, credential state, and health policy all permit the requested capability.

### 10.3 Integration rules

- Verify provider signatures before business processing.
- Store secrets in a managed secret system or encrypted credential store; never in events or logs.
- Refresh and rotate credentials without changing the owning business connection.
- Apply timeouts, bounded retries with jitter, circuit breaking, and provider-specific rate limits.
- Quarantine malformed or repeatedly failing events for investigation and replay.
- Reconcile provider state on a schedule because webhooks can be delayed, duplicated, or absent.
- Version canonical contracts independently from provider payload versions.

### 10.4 Initial canonical events

```text
customer.created
customer.consent.changed
conversation.message.received
conversation.message.sent
conversation.assignment.changed
message.delivery.updated
campaign.started
campaign.delivery.updated
content.publish.requested
content.publish.completed
integration.connection.changed
workflow.run.changed
approval.requested
approval.decided
usage.recorded
```

The final event catalogue must define producer, owner, schema, ordering expectations, sensitivity, retention, and consumer behaviour for each event.

## 11. Agents and workflows

KasiAgents is both a native agent and workflow platform and the controlled gateway through which approved external AI clients interact with Kasitek.

```text
Human | schedule | business event | approved external agent
                         |
                         v
                  Trigger validation
                         |
                         v
              Workflow / run orchestration
                         |
                         v
       identity + scope + entitlement + policy + approval
                         |
                         v
                 Capability registry
                         |
       +-----------------+------------------+
       |                 |                  |
       v                 v                  v
     Read              Draft          Controlled action
  domain data       proposed work     send/publish/change
       |                 |                  |
       +-----------------+------------------+
                         |
                         v
             execution and audit record
```

### 11.1 Capability model

| Risk class | Examples | Default policy |
| --- | --- | --- |
| Read | search customers, read assigned conversation | Allowed only within granted scope |
| Draft | draft reply, campaign, or social post | May be automated; no external effect |
| Controlled write | assign conversation, update lead status, schedule approved content | Requires explicit permission and policy evaluation |
| External action | send message, publish post, launch campaign | Human approval unless an accepted policy pre-approves the exact conditions |
| Privileged action | change access, billing, retention, credentials, or delete/export data | Strong authentication and privileged approval |

### 11.2 Execution requirements

Every run records:

- triggering actor and delegated authority;
- product runtime, organisation or tenant, and client scope;
- workflow and capability versions;
- inputs, relevant context references, model/tool calls, and outputs;
- policy and approval decisions;
- step status, retries, cost and timing;
- resulting domain actions and external effects;
- cancellation, timeout, compensation, and failure state.

Agents never receive unrestricted SQL, provider credentials, or broad internal APIs. Prompt instructions cannot increase the actor's authority.

### 11.3 Protocol roles

| Interface | Role |
| --- | --- |
| REST/HTTP APIs and webhooks | Foundational product and integration contracts. |
| MCP | Discovery and invocation of approved Kasitek capabilities by external AI clients. |
| A2A | Future delegation of structured work between independently operated agents. |

MCP and A2A are adapters over the capability and policy layers. They are not alternate permission systems.

The delivery design is defined in the [Agent Protocol Implementation Plan](./agent-protocol-implementation-plan.md). The core code and production structure are defined in the [Action Platform Technical Design](./action-platform-technical-design.md). Day-to-day progress is tracked in the [Agent Protocol Implementation Checklist](./agent-protocol-implementation-checklist.md).

## 12. Security, privacy, and compliance

### 12.1 Trust boundaries

```text
Internet
  |
  v
Edge trust boundary: TLS, WAF, rate limits, request validation
  |
  v
Identity boundary: authentication, session and machine identity
  |
  v
Tenant boundary: runtime, organisation/tenant and client scope
  |
  v
Application boundary: domain permissions, policy and approval
  |
  v
Data boundary: scoped queries, encryption, audit and retention
  |
  v
Provider boundary: isolated credentials, adapters and reconciliation
```

### 12.2 Required controls

- Strong password hashing and secure recovery flows; multi-factor authentication for privileged users.
- Short-lived sessions or tokens, rotation where appropriate, revocation, secure cookies, and CSRF protection for browser sessions.
- Hashed API keys with prefixes for identification; scoped machine credentials and rotation.
- TLS in transit and encryption at rest for databases, objects, backups, and provider secrets.
- Least-privilege database, cloud, provider, and operator permissions.
- Input validation, output encoding, upload scanning, content-type enforcement, and size limits.
- Rate limiting by source, actor, tenant, capability, and provider where appropriate.
- Append-oriented audit evidence protected from normal product mutation.
- Security alerts for suspicious authentication, privilege changes, cross-scope attempts, secret access, bulk exports, and destructive actions.
- Dependency, secret, static analysis, and security tests in the delivery pipeline.
- A maintained threat model for authentication, tenant isolation, webhooks, agents, file handling, and support access.

### 12.3 Privacy and POPIA direction

Kasitek must record whether it acts as responsible party, operator, or another role for each processing context. Product design must support purpose limitation, data minimisation, access and correction, deletion where applicable, processor records, security safeguards, breach handling, and auditable consent or communication preference changes.

The architecture enables compliance; it does not by itself establish legal compliance. Retention periods, lawful bases, cross-border processing, and customer agreements require formal policy and legal review.

## 13. Critical runtime scenarios

Static diagrams show ownership; runtime scenarios show whether those boundaries hold during real work. The following flows are architecture requirements.

### 13.1 Tenant domain and authenticated request

```text
Browser -> Edge: request for branded tenant host
Edge -> Domain resolver: resolve verified host
Domain resolver -> Edge: runtime + tenant + branding reference
Edge -> Tenant portal/runtime: forward trusted resolution context
Tenant runtime -> Session store: validate realm-specific session
Tenant runtime -> Access policy: tenant + actor + client + action
Access policy -> Tenant runtime: allow / deny / require approval
Tenant runtime -> Domain module: execute scoped operation
Domain module -> Audit: record sensitive action or denial
Tenant runtime -> Browser: scoped response
```

Unknown, unverified, disabled, or conflicting domains fail closed. Domain changes are versioned and propagated with bounded cache expiry.

### 13.2 Inbound customer message

```text
Provider -> Webhook edge: signed message event
Webhook edge -> Receipt store: verify and durably record provider event ID
Webhook edge -> Provider: acknowledge
Worker -> Integration adapter: normalise provider payload
Integration adapter -> Conversations: resolve connection, contact and thread
Conversations -> Database/outbox: store message and canonical event atomically
Outbox -> Subscribers: routing, agent trigger, realtime update, reporting
Subscribers -> Audit/operations: record result or recoverable failure
```

Duplicate provider events resolve to the same receipt or domain operation. Agent failure cannot prevent the human inbox from receiving an accepted message.

### 13.3 Campaign launch and delivery

```text
Author -> Campaigns: request launch with idempotency key
Campaigns -> Policy: permission, consent, entitlement and approval checks
Campaigns -> Database: freeze campaign version and audience snapshot
Campaigns -> Queue: create bounded delivery batches
Workers -> Provider adapter: send with tenant rate and provider limits
Provider -> Webhook edge: delivery updates
Webhook worker -> Campaigns: idempotently update recipient state
Campaigns -> Reporting/usage/audit: publish derived events
```

A campaign is not reported as launched until a durable operation exists. Cancellation stops unsent work but preserves the history of work already submitted to providers.

### 13.4 Agent-controlled external action

```text
Trigger -> Agent orchestrator: start scoped run
Orchestrator -> Capability registry: request typed action
Capability registry -> Policy: actor + tenant/client + risk + entitlement
Policy -> Approval service: request decision when required
Approval service -> Human: show exact proposed effect
Human -> Approval service: approve or reject
Capability registry -> Domain module: execute approved command once
Domain module -> Provider worker: perform external effect
Orchestrator -> Execution log: record inputs, decisions, effect and result
```

Approval binds to the exact action, target, content or payload version, scope, and expiry. A materially changed action requires a new approval.

### 13.5 Tenant client invitation

```text
Tenant staff -> Tenant runtime: invite client user
Tenant runtime -> Policy: verify tenant role and client assignment
Tenant runtime -> Identity: create single-use, expiring invitation
Identity -> Notification provider: send neutral invitation link
Client user -> Branded tenant host: redeem invitation
Identity -> Client user: establish tenant-client identity and session
Client user -> Client area: receive only permitted client-scoped capabilities
Audit -> Tenant: record invitation, redemption and access changes
```

Invitation tokens are stored safely, expire, can be revoked, and cannot be moved to another tenant, client, email identity, or host.

## 14. Deployment, reliability, and operations

### 14.1 Target production topology

```text
Users and providers
        |
DNS / CDN / WAF / certificate management
        |
Load-balanced web and API entry points
        |
        +-- Control-plane application ---- Control-plane database
        |
        +-- Direct application ----------- Direct database
        |       `-- Direct workers
        |
        +-- White-label application ------ White-label database
        |       `-- Tenant workers
        |
        +-- Webhook and realtime edges
        |
        +-- Queue / scheduler / dead-letter handling
        |
        +-- Object storage / cache / search
        |
        `-- Logs / metrics / traces / audit / alerts

External providers are reached through controlled outbound adapters.
Secrets and encryption keys are supplied through managed secret infrastructure.
```

### 14.2 Environment model

- Local development uses isolated developer data and test provider accounts.
- Test environments support automated contract, migration, security, and integration tests.
- Staging mirrors production topology closely enough to validate deployment and recovery procedures.
- Production uses separate credentials, data, networks, and access policy.
- Customer personal data is not copied into lower environments unless explicitly approved, minimised, and protected.

### 14.3 Reliability patterns

- Health checks distinguish process health, dependency readiness, and business capability health.
- Background work is durable, observable, idempotent, and bounded by retry policy.
- Dead-lettered work records the failure reason and has a controlled replay path.
- Deployments use backward-compatible database and event changes, health gates, and rollback or roll-forward procedures.
- Provider dependencies use timeouts, bulkheads, circuit breakers, and degraded modes.
- Backups, point-in-time recovery, object versioning, and infrastructure configuration support disaster recovery.
- Capacity, queue depth, error budgets, latency, saturation, provider health, and cost are monitored.

### 14.4 Observability context

Logs, metrics, and traces carry correlation identifiers and a safe organisation or tenant reference. They must not expose credentials, message bodies, prompts, or personal information by default. Audit records and diagnostic telemetry are separate: telemetry helps operate the system; audit evidence establishes who did what and why.

## 15. API and contract standards

### 15.1 Contract rules

- APIs are organised around business resources and capabilities, not database tables.
- Authentication and scope requirements are explicit for every operation.
- Commands that may be retried accept idempotency keys.
- Errors use a stable machine code, safe human message, correlation identifier, and field details where appropriate.
- Pagination, filtering, sorting, dates, money, identifiers, and optional fields follow one platform convention.
- Breaking changes require a versioned migration path and communicated retirement policy.
- Webhook and event contracts define signing, replay protection, ordering, duplication, versioning, and retry behaviour.
- Generated or shared types do not replace domain validation at runtime boundaries.

### 15.2 Synchronous versus asynchronous work

Use synchronous calls when the caller needs an immediate authoritative answer and the work is bounded. Use asynchronous commands and events for provider calls, bulk sends, publishing, imports, exports, AI generation, reporting projections, and other long-running or failure-prone work.

An accepted asynchronous request returns a durable operation identifier whose status can be queried or streamed.

## 16. Implementation status

This section is the only current-state view in this document. It uses the visible [Product Features](../features/product-features.md) and [Product Roadmap](../roadmap/product-roadmap.md) as its baseline; it is not a repository audit.

### 16.1 Status definitions

- **Implemented:** documented as live for real customer use.
- **Partial:** some required capability is live or in progress, but the target boundary is incomplete.
- **Planned:** accepted product direction without a complete implementation.
- **Research:** direction still being validated.
- **Needs verification:** the visible documents do not establish enough evidence.

### 16.2 Target-to-current matrix

| Target architecture area | Status | Visible evidence or gap |
| --- | --- | --- |
| Connected cross-product business context | Planned | Product Features lists shared customer, conversation, campaign, content, and workflow context as planned. |
| Direct organisation and team access model | Planned | Organisation, workspace, and team access are listed as planned. |
| Separate white-label runtime and database | Needs verification | Accepted architecture direction; implementation completeness is not established by the visible product documents. |
| Tenant staff and tenant client identities | Planned | Branded workspace plus tenant staff and client accounts are listed as planned. |
| Multi-client agency management | Planned | Listed as planned. |
| WhatsApp agent and routing | Implemented | WhatsApp Business Cloud API agent, multi-agent routing, lead qualification, FAQ flows, and document sending are listed as live. |
| Voice and appointment workflows | Partial | Both are listed as in progress. |
| Human handoff and unified inbox | Planned | Handoff is planned; KasiInbox remains a future portfolio direction. |
| WhatsApp campaigns | Partial | Broadcast capability is listed as in progress; segmentation, scheduling, analytics, consent, and follow-up are planned. |
| Social connections and publishing | Partial | Facebook and Instagram connection/publishing are in progress; broader scheduling, content, analytics, and collaboration are planned. |
| Capability registry and governed agent execution | Planned | Native tool access, approvals, and execution history are planned. |
| External agent access through MCP | Planned | MCP access is planned. A2A delegation remains research. |
| Canonical event and outbox architecture | Needs verification | Target decision established here; implementation evidence is not present in the visible product documents. |
| Security, privacy, recovery, and service objectives | Needs verification | Target controls are established here and require a dedicated evidence review. |
| Unified reporting and analytics | Planned | Product-specific analytics and unified cross-product reporting are planned. |

Implementation status must be updated from verified evidence. A roadmap date or an accepted architecture decision does not by itself make an item implemented.

## 17. Architecture decision register

### 17.1 Accepted target decisions

| ID | Decision | Consequence |
| --- | --- | --- |
| A-001 | Kasitek is one connected business platform with multiple product surfaces. | Products compose shared business domains instead of duplicating records. |
| A-002 | Direct and white-label products use separate runtimes, databases, and identity/session models. | Shared code must not create shared business-state ownership. |
| A-003 | White-label has platform, tenant staff, and tenant client layers. | Identity, routes, permissions, data ownership, and invitations support all three layers. |
| A-004 | The control plane owns platform lifecycle, not tenant business records. | Product operations can be isolated and remain available through bounded control-plane outages. |
| A-005 | White-label uses pooled tenant storage by default with enforced tenant and client scope. | Isolation controls and automated cross-tenant tests are mandatory; dedicated isolation remains possible. |
| A-006 | Product runtimes begin modular, with workers separated for asynchronous work. | Microservices require evidence from scale, security, reliability, or ownership. |
| A-007 | Transactional outbox and idempotent consumers carry reliable domain events. | Cross-domain and background processing can recover without silent event loss. |
| A-008 | External accounts belong to an organisation or tenant, not a product surface. | Several products can use one connection through explicit capabilities. |
| A-009 | Agents act through the same domain permissions, policy, approvals, and audit as other clients. | AI protocols cannot bypass platform authority. |
| A-010 | REST and webhooks are foundational; MCP and A2A are adapters. | Agent interoperability does not replace stable product contracts. |

Major, expensive, security-sensitive, or difficult-to-reverse decisions should graduate from this register into individual architecture decision records containing context, options, decision, consequences, and review conditions.

### 17.2 Open decisions

- Final infrastructure provider and regional deployment model.
- When a tenant qualifies for a dedicated database or deployment.
- Authoritative identity provider strategy and multi-factor authentication rollout.
- Queue, workflow orchestration, search, analytics, and secret-management technologies.
- Formal data classification, retention schedule, and cross-border processing policy.
- Detailed recovery objectives by commercial tier and workload.
- Which external actions may be pre-approved and which always require a person.
- First externally available MCP capabilities and their commercial entitlement.
- Conditions for introducing A2A delegation.
- Whether realtime delivery uses server-sent events, WebSockets, or a managed service per runtime.

An open technology choice must not weaken the accepted product, identity, data, security, or domain boundaries defined above.

## 18. Architecture governance

This document changes when the target system boundary, quality goals, domain ownership, runtime model, data isolation, security model, or integration strategy changes.

Architecture changes follow this sequence:

1. identify the business driver and affected quality goals;
2. describe viable options and operational consequences;
3. record the decision before implementation when it is expensive or difficult to reverse;
4. update affected diagrams, contracts, and glossary terms;
5. add automated architecture checks where possible;
6. update implementation status only after verification.

Useful architecture checks include dependency rules between modules, tenant-isolation tests, API and event schema validation, migration compatibility tests, secret scanning, restore exercises, and verification that privileged actions emit audit evidence.
