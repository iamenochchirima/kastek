---
title: Action Platform Technical Design
slug: /architecture/action-platform-technical-design
sidebar_position: 5
---

# Action Platform Technical Design

**Status:** Accepted for Slice 1; later-phase decisions remain open  
**Scope:** Core action contracts, authorisation, execution, approvals, audit, and protocol adapters  
**Related:** [Platform Architecture](./kasitek-technical-blueprint.md) · [Implementation Plan](./agent-protocol-implementation-plan.md) · [Implementation Checklist](./agent-protocol-implementation-checklist.md)

This document preserves the agreed implementation design for the core service that will support product APIs, native agents, MCP, and future A2A integrations.

It exists so this platform is implemented deliberately rather than becoming a collection of protocol handlers, database queries, and provider calls.

## 1. Naming

The code uses simple, direct names.

| Name | Meaning |
| --- | --- |
| **Action** | A typed business operation such as searching customers, drafting a reply, assigning a conversation, or sending a message. |
| **Action registry** | The catalogue of supported actions and their contracts. |
| **Execution** | The controlled process that authorises and runs an action. |
| **Run** | One durable attempt to complete a requested action or workflow. |
| **Effect** | A change made outside the process, especially a provider call, send, publish, payment, or destructive change. |
| **Gateway** | The adapter that accepts REST, MCP, and later A2A requests and translates them into internal action requests. |
| **Handler** | Runtime-owned code that implements one action by calling the appropriate domain service. |

The architecture may still use the general word “capability” when describing what Kasitek permits or provides. Executable code units are named **actions** so “capability” is not overloaded across code, entitlements, provider features, OAuth scopes, and product packaging.

### Proposed code names

```text
server/
|-- crates/
|   |-- actions/
|   |-- execution/
|   `-- action-testing/
|
|-- kasitek-core/
|   `-- src/actions/
|
|-- kasitek-tenants/
|   `-- src/actions/
|
`-- kasitek-gateway/
    |-- src/rest/
    |-- src/mcp/
    `-- src/a2a/
```

These names describe responsibility without encoding a temporary protocol or product name into the core.

## 2. Design goals

The implementation must provide:

1. one typed action contract usable by product APIs, native agents, MCP, and A2A;
2. fail-closed organisation, tenant, and client scoping;
3. separate direct and white-label runtime ownership;
4. central policy and approval decisions without centralising product business logic;
5. durable, idempotent execution of long-running and external work;
6. clear evidence connecting actor, decision, run, domain change, and provider effect;
7. horizontal production scaling without requiring premature microservices;
8. code boundaries that can later be extracted into services if evidence justifies it.

## 3. Non-goals

The action platform does not:

- own customer, conversation, campaign, content, billing, or integration business rules;
- combine direct and white-label databases;
- replace product-domain services;
- let agents run arbitrary SQL or code;
- store provider credentials in action definitions, requests, events, or logs;
- make MCP or A2A the internal execution model;
- guarantee that an external provider performs an operation exactly once;
- require every module to become an independently deployed service.

## 4. System boundary

```text
Product UI       Native agent       MCP client       Future A2A peer
    |                 |                 |                   |
    v                 v                 v                   v
REST adapter      Internal adapter    MCP adapter          A2A adapter
    |                 |                 |                   |
    +-----------------+-----------------+-------------------+
                              |
                              v
                       Action application API
                              |
                  +-----------+-----------+
                  |                       |
                  v                       v
             Action registry         Execution pipeline
                                          |
                          scope + grants + entitlement
                          risk + policy + approval
                          idempotency + run + audit
                                          |
                                          v
                                  Typed action handler
                                          |
                         +----------------+----------------+
                         |                                 |
                         v                                 v
                  Direct domain service          White-label domain service
                         |                                 |
                  Direct database                 White-label database
```

Protocol adapters validate protocol-specific messages and establish the caller. They do not decide product policy or query product databases.

## 5. Code organization

### 5.1 `crates/actions`

This is a small, protocol-neutral library. It contains no HTTP server, database connection, OAuth client, queue, provider adapter, or product-domain implementation.

```text
actions/src/
|-- lib.rs
|-- action.rs          action identity and definition
|-- actor.rs           human and machine actor identity
|-- scope.rs           direct, tenant staff, and tenant client scopes
|-- request.rs         untrusted and validated action requests
|-- result.rs          safe action outcomes
|-- risk.rs            risk and approval classes
|-- schema.rs          input/output schema metadata and validation contract
|-- registry.rs        deterministic registration and lookup
|-- error.rs           stable internal error categories
`-- catalog/
    |-- customers.rs
    `-- conversations.rs
```

Responsibilities:

- define stable action names and versions;
- define complete actor and scope types;
- define input and output schema contracts;
- define risk, approval, idempotency, audit, and data classification metadata;
- register action definitions deterministically;
- reject invalid or conflicting definitions;
- expose no persistence or transport implementation.

### 5.2 `crates/execution`

This is the application-level orchestration layer.

```text
execution/src/
|-- lib.rs
|-- pipeline.rs         ordered invocation flow
|-- authorizer.rs       grants and scope decisions
|-- entitlements.rs     product availability and limits
|-- policy.rs           risk and approval policy
|-- approvals.rs        approval binding and decisions
|-- idempotency.rs      logical request ownership
|-- runs.rs             run and step state transitions
|-- effects.rs          external-effect tracking
|-- audit.rs            required evidence contract
|-- outbox.rs           reliable event publication contract
|-- ports.rs            persistence and domain interfaces
`-- error.rs
```

It depends on `actions`, but `actions` never depends on `execution`.

Responsibilities:

- execute the action pipeline in one defined order;
- call abstract ports for identity, grants, entitlements, approvals, persistence, audit, and handlers;
- create and transition durable runs;
- enforce idempotency and approval binding;
- record external-effect attempts and outcomes;
- produce safe, protocol-neutral results.

It does not contain SQL tied to either product runtime.

### 5.3 `crates/action-testing`

This contains reusable test harnesses, fixtures, fake clocks, fake providers, and contract suites. Production crates do not depend on it.

It must support the same isolation and execution tests against both direct and white-label runtime adapters.

### 5.4 `kasitek-core/src/actions`

The direct runtime owns:

- direct action handlers;
- direct organisation scope resolution;
- direct grants and execution persistence adapters;
- direct domain-service calls;
- direct database migrations;
- direct audit and outbox integration.

### 5.5 `kasitek-tenants/src/actions`

The white-label runtime owns:

- tenant staff and tenant client action handlers;
- workspace and client scope resolution;
- tenant grants and execution persistence adapters;
- white-label domain-service calls;
- tenant database migrations;
- tenant audit and outbox integration.

This module may share action definitions with the direct runtime, but it never shares database connections, sessions, or authoritative business records.

### 5.6 `kasitek-gateway`

The gateway is a protocol adapter. Initially it may be implemented as a module if a separate deployment would add more operational cost than value. Its interfaces must still support later extraction.

Responsibilities:

- accept REST, MCP, and later A2A messages;
- validate transport and protocol requirements;
- authenticate the client through the approved identity boundary;
- translate protocol requests into internal action requests;
- call the owning direct or white-label runtime;
- translate internal results into protocol responses;
- enforce gateway-level size, timeout, concurrency, origin, and rate limits.

The gateway must not:

- connect directly to product databases;
- hold provider credentials;
- define action risk or entitlement;
- manufacture tenant scope from tool arguments;
- become the authoritative run or approval store.

## 6. Dependency rules

```text
actions
   ^
   |
execution
   ^
   |
runtime adapters and action handlers
   ^
   |
REST / MCP / A2A adapters
```

Allowed dependencies:

- protocol adapters may depend on action contracts and application-facing runtime clients;
- execution may depend on actions and abstract ports;
- product runtimes may implement execution ports and typed handlers;
- handlers may call their own runtime's domain services.

Forbidden dependencies:

- actions depending on Actix, SQLx, OAuth, providers, or product runtimes;
- execution depending on direct or white-label SQL models;
- gateway depending on product database modules;
- direct handlers depending on tenant handlers or tenant persistence;
- tenant handlers depending on direct handlers or direct persistence;
- domain modules depending on MCP or A2A types.

These rules should become automated architecture checks where practical.

## 7. Core types

### 7.1 Action definition

```text
ActionDefinition
  name
  version
  owning_domain
  title
  description
  input_schema
  output_schema
  risk
  supported_runtimes
  supported_actors
  client_scope_requirement
  required_grants
  required_oauth_scopes
  required_entitlement
  idempotency_rule
  approval_rule
  data_classification
  audit_rule
  usage_rule
  lifecycle
```

Definitions are immutable within a version. A breaking input, output, authority, or effect change requires a new major action version.

### 7.2 Actor

```text
Actor
  type
  id
  identity_realm
  authenticated_client_id
  delegated_by
```

Actor types initially include:

- direct user;
- tenant staff user;
- tenant client user;
- platform operator;
- native agent;
- approved API client;
- approved external agent.

### 7.3 Scope

Scope must not be represented as unrelated optional strings.

```text
Scope
|-- Direct
|   `-- organisation_id
|
|-- TenantStaff
|   |-- workspace_id
|   `-- assigned_client_ids or all_clients grant
|
`-- TenantClient
    |-- workspace_id
    `-- tenant_client_id
```

A tenant client action cannot exist without both workspace and client identity. A direct identity cannot be attached to a white-label scope.

Repository operations accept a validated scope object rather than separate raw identifiers.

### 7.4 Request lifecycle

```text
IncomingActionRequest
        |
        v
ValidatedActionRequest
        |
        v
AuthorisedAction
        |
        v
RunningAction
        |
        v
ActionResult
```

Types should prevent handlers from accepting an unvalidated or unauthorised request.

### 7.5 Result

```text
ActionResult
|-- Succeeded(structured output)
|-- Accepted(durable operation ID)
|-- ApprovalRequired(safe approval reference)
|-- Denied(stable reason code)
`-- Failed(safe error code and correlation ID)
```

Stack traces, SQL errors, provider secrets, raw tokens, and cross-scope resource existence never appear in an external result.

## 8. Typed handlers

JSON is used at protocol and persistence boundaries. Handlers use typed Rust inputs and outputs.

Conceptually:

```rust
trait ActionHandler {
    type Input;
    type Output;

    fn definition(&self) -> ActionDefinition;

    async fn execute(
        &self,
        action: &AuthorisedAction,
        input: Self::Input,
    ) -> Result<Self::Output, ActionError>;
}
```

The final implementation may use type erasure inside the registry, but typed handler boundaries remain the developer-facing API.

Handlers must:

- receive only an `AuthorisedAction`;
- call the owning runtime's domain service;
- use the validated scope supplied by the pipeline;
- return domain-safe errors;
- avoid starting background tasks outside the execution system;
- avoid calling external providers directly when an effect worker is required.

## 9. Execution pipeline

The pipeline order is fixed:

```text
1. Receive request and correlation context
2. Resolve action definition and version
3. Validate external input schema
4. Establish trusted actor and client
5. Resolve product runtime
6. Resolve organisation, workspace, and client scope
7. Verify actor and account status
8. Evaluate grants and OAuth scopes
9. Evaluate entitlement, usage, and rate limits
10. Evaluate risk and approval policy
11. Reserve idempotency key
12. Create or resume durable run
13. Deserialize typed handler input
14. Execute domain handler or enqueue effect
15. Validate structured output
16. Record run, usage, effect, audit, and outbox evidence
17. Return safe result
```

Handlers are never called if an earlier stage fails.

Every policy decision records the action version, policy version, actor, resolved scope, grants, entitlement result, approval result, and correlation identifier.

## 10. Persistence model

Direct and white-label databases implement the same logical model through separate migrations and repositories.

```text
action_clients
action_grants
action_runs
action_run_steps
action_run_attempts
approval_requests
approval_decisions
external_effects
idempotency_keys
outbox_events
audit_events
```

### Ownership columns

Direct records carry `organisation_id`. White-label records carry `workspace_id`, and `tenant_client_id` where client isolation applies.

White-label indexes begin with `workspace_id`; client-owned workload indexes continue with `tenant_client_id` before unscoped lookup fields.

### Storage rules

- IDs are server-generated and globally unique.
- Mutable state includes an explicit version for optimistic concurrency.
- Approval decisions and audit evidence are append-only.
- Attempts are separate from the logical run and logical effect.
- Large artifacts live in object storage and are referenced through scoped records.
- Sensitive payloads are minimised, encrypted where required, and redacted from telemetry.
- Retention class and deletion state are explicit.

## 11. Transaction boundaries

### 11.1 Creating a run

One database transaction:

1. reserve or resolve the idempotency key;
2. create the logical run;
3. record the initial policy decision;
4. create approval or initial step state;
5. append the outbox event.

### 11.2 Completing a domain change

Where the domain record and run use the same runtime database, one transaction should:

1. apply the domain change;
2. update the run and step;
3. record usage and audit evidence;
4. append the outbox event.

### 11.3 External effects

Provider calls do not occur inside a database transaction.

```text
Transaction: reserve effect + append outbox
    -> worker claims effect
    -> provider call with idempotency key
    -> transaction: record outcome + update run + append outbox
```

An unknown provider outcome moves to reconciliation rather than being reported as success or automatically retried without policy.

## 12. Run and effect state machines

### 12.1 Run states

```text
requested
  -> evaluating
  -> approval_required
  -> queued
  -> running
  -> succeeded

Alternative terminal or interrupted states:
  denied | rejected | cancelled | failed | expired

Recoverable states:
  retry_scheduled | input_required | reconciliation_required
```

Terminal states cannot transition back to running. Resumption creates a valid transition or a new run according to the action contract.

### 12.2 Effect states

```text
reserved
  -> submitted
  -> confirmed

Alternative states:
  failed | cancelled | outcome_unknown | reconciliation_required
```

Provider delivery states may continue after an effect is confirmed as submitted. Those delivery events belong to the owning product domain.

## 13. Idempotency and concurrency

The platform promises one logical Kasitek effect, not impossible universal exactly-once delivery.

Required controls:

- a unique key over owner, action, actor or client, and idempotency key;
- a stored hash of the action version, scope, target, and relevant input;
- rejection when one key is reused for a different request;
- transactional run ownership;
- optimistic versioning for state transitions;
- bounded worker leases and lease recovery;
- provider idempotency keys where supported;
- reconciliation when submission outcome is unknown;
- immutable attempt history.

Concurrent callers receiving the same idempotency key receive the same logical run reference.

## 14. Tenant isolation

Isolation is enforced in every layer:

1. trusted host and runtime resolution;
2. realm-specific authentication;
3. validated scope types;
4. grants and client assignment;
5. repositories requiring scope objects;
6. tenant-leading SQL predicates and indexes;
7. tenant-aware cache, queue, object, event, search, and log keys;
8. denial before queries that could reveal resource existence;
9. cross-tenant and cross-client automated tests.

Client-supplied organisation, workspace, or client IDs are treated as requested targets, never proof of authority.

## 15. Production scaling

### 15.1 Synchronous work

- gateway and runtime instances remain stateless;
- instances scale horizontally behind load balancing;
- authoritative identity, grants, runs, and approvals are never memory-only;
- all unbounded lists use pagination;
- request sizes, deadlines, and concurrency are bounded;
- database access uses measured connection pools;
- caches contain versioned, expiring derived data only.

### 15.2 Asynchronous work

```text
Runtime database
  -> transactional outbox
  -> publisher
  -> partitioned queue
  -> horizontally scalable workers
  -> effect/result transaction
```

Queue partitioning must preserve tenant fairness. One tenant's campaign or failing workflow cannot exhaust all workers.

### 15.3 Data growth

- use tenant-leading indexes;
- partition high-volume run attempts, audit, usage, and outbox data when measurements justify it;
- move large files and artifacts to object storage;
- use derived read models for reporting;
- archive according to retention rules;
- prevent analytics queries from competing with action execution.

### 15.4 Service extraction

A module becomes a separate service only when there is evidence of:

- materially different scaling;
- a stronger security boundary;
- required failure isolation;
- independent deployment ownership;
- incompatible workload or technology;
- database contention that modular deployment cannot address.

Extraction preserves action contracts and does not introduce shared database access.

## 16. Failure handling

- Provider and model calls use deadlines, bounded retries, jitter, and circuit breaking.
- Retriable and terminal errors are explicitly classified.
- Workers persist progress before acknowledging queue work.
- Dead-lettered work retains safe diagnostic evidence and a controlled replay path.
- Provider, AI, analytics, and notification failures are isolated from core reads.
- Approval and idempotency failures fail closed.
- Unknown outcomes require reconciliation.
- Kill switches exist at protocol, client, tenant, action, and provider levels.

## 17. Observability and audit

Every request carries:

- invocation ID;
- correlation and causation IDs;
- action name and version;
- safe actor reference;
- safe organisation, workspace, and client references;
- run, step, attempt, approval, and effect references where present.

Metrics include:

- request, denial, approval, execution, retry, and failure counts;
- latency per pipeline stage;
- queue delay, worker saturation, and lease recovery;
- provider error and unknown-outcome rates;
- idempotency conflict and duplicate-prevention counts;
- tenant fairness and rate-limit activity;
- cost and usage by action and tenant.

Telemetry does not contain credentials, message bodies, prompts, personal information, or unrestricted action inputs by default. Audit evidence and operational telemetry remain separate.

## 18. Test architecture

### Unit tests

- action-definition validation;
- registry ordering and conflicts;
- scope construction and invalid realm combinations;
- risk and policy decisions;
- run and effect state transitions;
- approval binding;
- stable safe errors.

### Contract tests

- input and output schema compatibility;
- direct and white-label handler conformance;
- protocol adapter mapping;
- action-version compatibility.

### Database integration tests

- tenant and client isolation;
- idempotency uniqueness under concurrency;
- optimistic transition conflicts;
- outbox atomicity;
- worker lease recovery;
- append-only approval and audit behaviour;
- migration upgrade and rollback compatibility.

### Failure tests

- crash after run creation;
- crash before and after provider submission;
- provider timeout with unknown result;
- duplicate queue delivery;
- replayed approval;
- expired or revoked grants during execution;
- control-plane and entitlement lookup outage;
- unavailable audit or outbox dependency.

### Security tests

- direct-to-tenant and tenant-to-direct attempts;
- tenant-to-tenant and client-to-client attempts;
- indirect identifier guessing;
- token audience and scope failures;
- prompt injection and malicious arguments;
- payload and recursion limits;
- callback SSRF when A2A is introduced.

### Performance tests

- registry and policy lookup latency;
- database pool saturation;
- high-cardinality tenant traffic;
- one noisy tenant versus normal tenant latency;
- queue backlog recovery;
- audit and run-table growth.

## 19. Implementation sequence

Implementation proceeds in vertical, verifiable slices.

### Slice 1 — Contracts and scope

- create `actions` with definitions, actors, scopes, requests, results, and registry;
- define the first three read/draft actions;
- add invalid-realm and missing-scope tests;
- do not expose new endpoints.

### Slice 2 — Pipeline shell

- create `execution` ports and ordered pipeline;
- use in-memory test adapters only;
- prove fail-closed ordering and safe outcomes.

### Slice 3 — First real read action

- connect `customer.search` to one direct domain service;
- connect it separately to the white-label runtime;
- add database isolation and pagination tests;
- keep it internal.

### Slice 4 — Grants and entitlements

- add runtime-owned persistence;
- integrate role defaults, explicit grants, revocation, entitlement, and limits;
- add policy evidence.

### Slice 5 — Durable execution

- add runs, steps, attempts, idempotency, audit, and outbox;
- prove recovery and concurrency behaviour.

### Slice 6 — Draft action

- connect `conversation.draft_reply` through the durable pipeline;
- store safe execution evidence;
- measure model cost and failure.

### Slice 7 — Approval-controlled action

- choose a low-blast-radius write;
- implement exact effect preview and payload-bound approval;
- prove replay and idempotency safety.

### Slice 8 — Native workflow

- migrate one existing agent workflow;
- remove its direct-write path;
- validate operator controls.

### Slice 9 — MCP adapter

- add OAuth protected-resource handling;
- add Streamable HTTP and tool mapping;
- expose only approved read/draft actions to an allowlisted pilot.

A2A remains outside this sequence until its documented readiness gate is accepted.

## 20. Slice 1 architecture decisions

The following decisions are accepted for Slice 1:

| Decision | Accepted direction |
| --- | --- |
| Code vocabulary | Use **action**, **execution**, and **gateway**. |
| Crate boundary | Keep `actions` protocol-neutral and separate from the later `execution` crate. |
| Schema validation | Use JSON Schema Draft 2020-12 through `jsonschema`, with network and file resolution disabled. Compile schemas when actions are registered. |
| Action versions | Use semantic versions. Definitions are immutable within a version. |
| Identifiers | Treat IDs as opaque, non-empty strings at the contract boundary. Decide generation format with persistence design. |
| Time | Use UTC timestamps in contracts. Introduce an injectable clock in the execution layer for deterministic policy and state tests. |
| Dependency enforcement | Use Rust crate boundaries, package-level linting, workspace compilation, and later automated dependency checks. |

OAuth hosting, gateway deployment, approval persistence, ID generation, queue technology, and physical service extraction remain later decisions because the action contract layer does not depend on them.

## 21. Slice 2 architecture decisions

The following decisions are accepted for the execution pipeline shell:

| Decision | Accepted direction |
| --- | --- |
| Pipeline boundary | Keep execution protocol-neutral and database-free. REST, MCP, native agents, and later A2A must adapt into the same request contract. |
| Dependency direction | Execution depends on `actions`; product runtimes implement the execution ports. `actions` never depends on execution or product services. |
| Evaluation order | Validate request and deadline, then identity, access, entitlements, policy, idempotency, journal start, handler, output schema, and journal finish. |
| Failure behavior | Deny or fail closed at the first unsuccessful stage. Do not invoke later stages or expose dependency error details. |
| Time | Read time through an injected clock port so deadline and later policy tests are deterministic. |
| Handler boundary | Handlers receive a validated request and registered definition. They return structured output or a durable operation identifier. |
| Journal boundary | A journal must start before a handler runs. Production persistence and atomic run/audit/outbox behavior are deferred to the durable-execution slice. |
| Test adapters | Use in-memory adapters only to prove ordering and short-circuit behavior. They are not production enforcement. |

Runtime policy adapters, transaction ownership, retry semantics for external effects, and journal payload redaction remain follow-on decisions.

## 22. Review standard

This design is approved only when the names, boundaries, dependency rules, core types, transaction model, isolation model, and first implementation slice are accepted.

Once approved, the [Implementation Checklist](./agent-protocol-implementation-checklist.md) must be updated to reference this design, and each completed item must link to code or test evidence.
