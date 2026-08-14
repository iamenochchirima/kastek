# KasiTek Agent System Execution Blueprint

**Status:** Canonical implementation plan and progress checklist
**Architecture source:** [`KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`](KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md)
**Scope:** KasiAi, KasiTek-hosted agents, externally connected agents, shared capabilities, channels, and KasiTek internal operations

## 1. Purpose

This is the single checklist implementation agents follow and update. The architecture document
records why the system is designed this way; this document records what must be delivered, tested,
and verified for the system to be complete.

Each implementation slice includes:

- the product and technical outcome;
- end-to-end deliverables across storage, APIs, runtime, UI, audit, and operations;
- required automated and runtime verification;
- a completion gate.

An item is checked only when its code, migration, test, or operational evidence exists. Partial
existing implementations are useful starting points but do not complete a slice until its exit gate
passes. Implementation commits should update this checklist with a short evidence note where useful.

## 2. Agreed system plan

### Product modes

The system has one shared Agent Platform and three execution modes:

```text
KasiAi                 system_hosted       protected KasiTek platform agent
Hosted user agent      kasitek_hosted      general agent run by KasiTek
External agent         external_connected  Codex, Claude, n8n, or customer runtime
```

All three use the same installation identity, capability policy, approvals, audit attribution, and
core business boundary. Agent workflows use shared run records; a direct general REST request uses
core API/action records and links to an AgentRun only when a workflow initiated it. KasiAi does not
receive a private shortcut into `kasitek-core`.

Hosted agents may call both KasiTek capabilities and separately granted external connectors.
External agents call KasiTek through the public REST API or MCP server using installation
credentials; they do not need a logged-in human session.

The public REST API is broader than agents. Applications, workspace integrations, service
accounts, OAuth clients, scripts, and n8n may use it through their appropriate principal type.

### Service boundary

```text
Browser / channel / hosted agent       External MCP client
                 |                              |
                 v                              v
             Agent Platform <────── TypeScript MCP gateway
                 |
       short-lived signed delegation
                 |
                 v
         shared core domain operations <── `api::public_v1`
                 |                                      ^
                 v                                      |
 business state · authorization · effects       apps/services/agents
```

Temporal owns durable execution, retries, waiting, schedules, and recovery. PostgreSQL owns durable
agent records. Redis may support realtime delivery and caching but is not a source of truth.

### Deployment and code placement

The initial deployment has four relevant processes. The public API is a module, not a fifth service:

| Deployment | Language | Owns |
| --- | --- | --- |
| `kasitek-core` | Rust | Existing product endpoints, modular public `/v1`, shared domain commands/queries, final authorization, data, and provider effects. |
| `agents-api` | TypeScript | Agent control plane, installations, conversations, runs, approvals, capability policy, and internal capability API. |
| `agents-worker` | TypeScript | Temporal workflows, model/tool activities, schedules, and durable recovery. |
| `agent-gateway` | TypeScript | Public MCP transport, authentication adaptation, discovery, protocol mapping, rate limits, and health only. |

Required module boundaries:

```text
server/kasitek-core/src/
├── main.rs                     # process selection and server startup only
├── lib.rs                      # testable application composition root
├── bootstrap/
│   ├── app.rs                  # Actix application assembly
│   ├── state.rs                # AppState: pool, config, clients, registries
│   └── routes.rs               # mounts each API surface without business logic
├── api/
│   ├── product/                # existing direct-product /api/* adapters
│   ├── admin/                  # protected /api/admin/* adapters
│   ├── public_v1/              # independently managed /v1 subsystem
│   │   ├── auth/               # API keys, service accounts, OAuth, agent principals
│   │   ├── contracts/          # versioned public request/response DTOs
│   │   ├── middleware/         # scope, rate, idempotency, request/audit context
│   │   ├── routes/             # typed resource/action routes
│   │   ├── openapi/            # core-owned OpenAPI 3.1
│   │   ├── webhooks/           # public subscriptions and deliveries
│   │   └── metrics/            # usage, latency, errors, and availability
│   ├── internal/               # private /api/internal/* service adapters
│   ├── provider_webhooks/      # Meta, TikTok, WhatsApp, Twilio, Paystack
│   └── website/                # anonymous quote/waitlist endpoints; not public /v1
├── identity/
│   ├── principal.rs            # normalized human and machine principal types
│   ├── request_context.rs      # actor, organization, grants, correlation, idempotency
│   ├── product_session.rs
│   ├── admin_session.rs
│   ├── api_key.rs
│   ├── service_account.rs
│   └── internal_delegation.rs
├── domains/                    # reusable vertical business modules
│   ├── bookings/
│   │   ├── model.rs
│   │   ├── commands.rs
│   │   ├── queries.rs
│   │   ├── policy.rs
│   │   └── postgres.rs
│   ├── content/
│   ├── campaigns/
│   ├── contacts/
│   ├── conversations/
│   ├── connections/
│   ├── social/
│   │   ├── channels/
│   │   ├── posts/
│   │   ├── publishing/
│   │   ├── oauth/
│   │   ├── webhooks/
│   │   └── providers/          # Meta, Instagram, Threads, TikTok, Bluesky, X, LinkedIn
│   ├── whatsapp/
│   │   ├── connections/
│   │   ├── contacts/
│   │   ├── templates/
│   │   ├── campaigns/
│   │   ├── inbox/
│   │   ├── calls/
│   │   └── delivery/
│   ├── billing/
│   └── organizations/
├── capabilities/
│   ├── catalog.rs              # core action definitions and registrations
│   ├── handlers.rs             # typed action-to-domain dispatch
│   └── core_adapter.rs          # execution/delegation integration
├── infrastructure/
│   ├── database.rs
│   ├── crypto.rs
│   ├── http.rs
│   ├── email.rs
│   └── realtime.rs
├── workers/
│   ├── social_publishing.rs
│   ├── whatsapp_inbox.rs
│   ├── whatsapp_campaigns.rs
│   └── billing_reconciliation.rs
└── error.rs

agents/src/
├── capabilities/           # agent manifests, policy, and invocation adapter
└── gateway/                # separately deployed TypeScript MCP process
    ├── server.ts
    ├── mcp.ts
    ├── authentication.ts
    ├── capability-adapter.ts
    └── health.ts
```

This is a modular-monolith structure inside the existing `kasitek-core` binary, not a request to
create more Rust services. API modules are inbound adapters. Domain commands and queries own
business behavior and final resource authorization. Infrastructure modules implement database and
provider access. Repository traits are introduced only where substitution or transaction testing is
valuable; simple Postgres queries may remain concrete inside a domain's `postgres.rs`.

Existing `/api/*`, admin, public `/v1`, provider webhook, and private agent-delegation handlers all
reuse the same domain commands and queries. They do not call one another as HTTP clients or
duplicate database/provider logic. Transport DTOs do not live in the database model module, and
domain operations do not inspect cookies, bearer headers, or Actix request types. `agent-gateway`
does not own a database or call `kasitek-core` directly; it calls the Agent Platform's internal
capability boundary.

The shared invocation path is:

```text
surface-specific HTTP/MCP contract
              |
              v
authenticated RequestContext
              |
              v
domain command or query <---- capability/action adapter
              |
              v
business policy and final resource authorization
              |
              v
Postgres/provider effect, audit, usage, and receipt
```

### Current core baseline and migration constraints

The August 2026 core is a working starting point, not the target boundary:

- `src/routes.rs` centrally mounts product, admin, agent, internal, webhook, and anonymous website
  routes.
- `src/db/models.rs` mixes SQL row models with product request and response DTOs.
- `services/social.rs`, `services/whatsapp.rs`, `services/inbox.rs`, and `services/billing.rs` are
  large transaction-script modules containing database, provider, and business behavior.
- several controllers, especially auth, admin, profile, and workspace, issue SQL directly.
- `middleware/mod.rs` resolves browser/admin sessions but does not represent all approved public
  and machine principal types as one normalized request context.
- `controllers/agent_internal.rs` is a narrow initial service boundary, but its shared static token
  and direct SQL must be replaced by typed delegation and shared domain operations.
- `server/crates/actions` and `server/crates/execution` already define action, actor, scope, risk,
  approval, idempotency, and execution primitives. Core must integrate these crates rather than
  create a competing capability model.
- the current `controllers/public.rs` and `services/public.rs` are anonymous website quote/waitlist
  handlers. They become `api/website`; the name `public_v1` is reserved for the general developer
  API.

Migration is incremental. Existing URLs and response contracts remain stable while handlers are
moved behind shared domain operations. Moving files without removing transport, SQL, policy, and
provider coupling does not complete the reorganization.

### The 14 agreed architecture layers

| Layer | Settled direction |
| --- | --- |
| 1. Product and installation | Versioned definitions installed into a workspace; each installation has a non-human principal and one of the three execution modes. |
| 2. Identity and credentials | Multiple named copy-once secrets, hashed at rest, exchanged for one-hour audience-bound tokens; immediate suspend/revoke checks; public-key assertions before broad production. |
| 3. Permissions and resources | Effective authority is the intersection of grants, credential restrictions, workspace/resource scope, availability, approval, and limits. Controlled testing uses an explicit broad-access profile with hard exclusions. |
| 4. Capability catalog | One versioned JSON-Schema manifest registry generates agent tools, MCP, UI metadata, agent documentation, and audit descriptions. Core owns public REST/OpenAPI contracts; overlapping schemas and outcomes are contract-tested. |
| 5. Action safety | Reads and drafts may run directly; real external effects require exact, single-use approvals initially. Mutations require idempotency, receipts, reconciliation, and execution-time authorization. |
| 6. Core boundary | Core owns product data, business authorization, transactional effects, and provider idempotency. Agent Platform uses short-lived asymmetric per-invocation delegation. |
| 7. MCP and REST | A separate TypeScript gateway hosts MCP at `agents.kasitek.co.za/mcp`. The independently managed `api::public_v1` Rust module inside core hosts the general public REST API at `api.kasitek.co.za/v1/*`. Equivalent operations converge on shared domain commands and queries. |
| 8. Runtime durability | One AgentRun model across agent entry points; Temporal handles durable agent work, retries, approvals, schedules, cancellation, and recovery. General REST uses core API/action execution records and links runs when applicable. |
| 9. Conversations and channels | Personal conversations are user-owned; business conversations are customer/thread-owned. Channel adapters are thin and never silently merge unrelated chats. |
| 10. Context and memory | Reviewed product knowledge, bounded recent history plus summaries, scoped memory namespaces, provenance, consent, deletion, and strict trusted/untrusted boundaries. |
| 11. Product experience | One Agents area for KasiAi, hosted agents, external connections, templates, activity, approvals, usage, credentials, channels, and settings. |
| 12. Observability and governance | Immutable audit, separate traces/logs/metrics, usage attribution, alerts, redaction, support access, exports, and hierarchical kill switches. |
| 13. Security | Isolation, replay defense, confused-deputy prevention, prompt/tool injection controls, secret minimization, webhook/SSRF defenses, rate limits, scans, and incident response. |
| 14. Rollout | Separate environments, seeded testing, feature flags, release gates, rollback drills, real-client compatibility tests, and progressive read → draft → sandbox effect → real effect enablement. |

### Initial delivery choices

- Bookings is the small structural pilot for the core module pattern; this does not make it the
  first complete external agent-capability release.
- Content/social is the first complete capability domain. Contacts/inbox, full bookings exposure,
  campaigns, automations/agent administration, and reporting follow using the same contracts.
- Controlled test workspaces behave as fully entitled while usage is still measured from day one.
- Real external effects always use approval during initial testing.
- Hosted agent creation starts with guided forms and templates. The visual workflow builder is a
  later phase on the same durable graph model.
- OpenRouter is the initial default model route; provider-neutral OpenAI, Anthropic, and Gemini
  adapters remain part of the shared model gateway.
- KasiTek internal administration is implemented in `client/apps/admin` through a protected core
  operator API; the browser never accesses Agent Platform storage or Temporal directly.
- The public API remains in the `kasitek-core` deployment initially but is modularized for
  independent versioning, authentication, documentation, metering, flags, monitoring, tests, and
  possible later extraction.
- The MCP gateway is a separately deployed TypeScript process built from the `agents` codebase.

## 3. Working rules

- Work through the slices in order unless a task is explicitly independent.
- Do not duplicate business logic across MCP, public REST, product controllers, or private agent
  handlers. Extend the shared domain commands/queries and their contracts.
- Do not mark a checkbox complete based only on code presence. Run the required verification.
- Every database change needs a migration, rollback/recovery consideration, and migration test.
- Every public or internal API change needs typed contracts and authorization tests.
- Every external effect needs idempotency, durable status, audit, and ambiguous-outcome recovery.
- Preserve unrelated worktree changes and make coherent commits after verified slices.
- Record genuine deferrals explicitly; do not silently omit a required end-to-end layer.

## 4. Implementation order and checklist

### Reconciliation evidence — 2026-08-13

The checked items below were reconciled against the current repository, migrations, focused tests,
and the commits listed in `docs/internal/architecture/agent-system-slices-2-7-progress.md`.
The Agent Platform suite now passes 49 files / 202 tests / 0 skips against isolated PostgreSQL and
local Temporal, and the Agent build and core format/check/library tests pass. A checked
implementation item does **not** assert that its slice completion gate or production-release
verification has passed.

At this reconciliation point, 152 of 224 implementation/verification items are checked. The count
is a work map, not a claim that the first production release is ready.

The remaining unchecked items are deliberate: route-surface parity, full public `/v1` policy and
OpenAPI, exact external-provider recovery, external MCP client testing, browser/admin end-to-end
testing, and policy-dependent operator/entitlement work. Those are tracked in the audit checklist
and `BLOCKERS.md`; they must not be converted to checked items merely because a foundation exists.

## Slice 0 — Reconcile the existing implementation

**Layers covered:** all layers as baseline inventory

### Deliverables

- [x] Map existing migrations, models, APIs, Temporal workflows, tool registry, model gateway,
  conversations, memory, channels, KasiAi UI, Agents UI, and admin endpoints to this blueprint.
- [x] Record implemented, partial, missing, and obsolete paths without treating old placeholders as
  completed architecture.
- [x] Confirm legacy `/api/bots` and old provisioning paths remain absent and no fallback or
  dual-write path is active.
- [ ] Confirm local development starts the core, client, Agent API, Temporal worker, databases, and
  required realtime services with documented health checks.
- [x] Create or update ADRs for any settled architecture decision not represented in code/docs.
- [x] Establish a short evidence format for completed slices: migration/API/test/command/commit.

**Slice 0 evidence (2026-08-13):** inventory and baseline results are recorded in
[`docs/internal/architecture/agent-system-slice-0-baseline.md`](docs/internal/architecture/agent-system-slice-0-baseline.md).
Pending environment and pre-existing frontend verification gaps are tracked in [`BLOCKERS.md`](BLOCKERS.md).

**Reconciliation evidence:** Agent migrations `027`–`035` applied locally and the complete Agent
suite passed 49 files / 202 tests / 0 skipped with PostgreSQL and an isolated Temporal dev server
(`RUN_AGENTS_DB_INTEGRATION_TESTS=true RUN_TEMPORAL_INTEGRATION_TESTS=true`). `pnpm build` passed;
`cargo fmt --check`, `cargo check -p kasitek-core`, and `cargo test -p kasitek-core --lib` passed
105 tests with three explicitly ignored seeded/infrastructure cases. Local Temporal recovery is
verified; authenticated browser, provider, hosted, Redis, and seeded-core gates remain open in
`BLOCKERS.md`.

### Verification

- [x] Run the existing Agent Platform unit and database suites.
- [x] Run Agent Platform typecheck/build, `kasitek-core` formatting/check/tests, and client/admin
  lint/typecheck/build baselines.
- [ ] Run local authenticated KasiAi and Agents health smoke tests and record genuine failures.

**Complete when:** the team has a verified baseline, every remaining item maps to this blueprint,
and agents can implement without relying on a superseded checklist.

## Slice 1 — Core modular-monolith foundation

**Layers covered:** prerequisite for 3, 4, 6, 7, 12, and 13

This slice reorganizes `kasitek-core` before the permanent public and agent surfaces expand. It is
an incremental responsibility migration, not a big-bang rewrite. Bookings is the pilot because its
current controller/service flow is small but exercises reads, writes, organization scope, admin
policy, customer references, validation, conflicts, and database effects. Content/social remains
the first complete agent-capability domain in Slice 5.

### Application shell and route surfaces

- [x] Add `src/lib.rs` and a testable composition root without changing the production binary name,
  process commands, health endpoints, or deployment topology.
- [x] Introduce `bootstrap::state::AppState` for the pool, configuration, HTTP/provider clients,
  action registry, and execution dependencies; avoid adding unrelated global state.
- [x] Move Actix assembly and route mounting from `main.rs` and the monolithic `routes.rs` into
  `bootstrap`, keeping `main.rs` responsible for environment loading, process selection, startup,
  and shutdown only.
- [x] Split route registration into `api::product`, `api::admin`, `api::internal`,
  `api::provider_webhooks`, and `api::website` modules while preserving every existing URL, method,
  middleware requirement, status code, and response contract. Evidence: `c5c2cb7` moves the
  complete registry into boundary modules, and its route inventory test confirms all 225 pre-split
  path literals remain present plus representative mounted-route checks.
- [x] Rename the current anonymous quote/waitlist `public` concept to `website` before creating
  `api::public_v1`; do not expose those handlers as developer API operations. Evidence: `62e2ec2`
  renames the website controller/service modules and isolates the versioned public module.
- [x] Move social publishing, WhatsApp inbox/campaign, and billing reconciliation loops from
  `main.rs` into `workers/*` modules while preserving `KASITEK_PROCESS` behavior and independent
  worker deployment support.

### Identity and request context

- [x] Define normalized principal types for direct users, admins, workspace API keys, service
  accounts, OAuth users/applications, agent installations, and trusted internal services.
- [x] Define `RequestContext` with principal, identity realm, organization, optional user/client or
  installation, effective grants, correlation/causation IDs, idempotency key, and request metadata.
- [x] Make product-session, admin-session, public credential, and internal-delegation adapters build
  `RequestContext`; domain operations must not inspect Actix requests, cookies, or raw headers.
  Evidence: `identity::product_session`, `identity::admin_session`, `identity::internal_delegation`,
  and the public installation adapter all normalize request identity before the bookings/content
  domain and capability operations; pilot operations accept only `RequestContext` (`838d32e`,
  `15d3f77`, `f63cdc3`).
- [x] Preserve the active-organization cookie only as a product-session preference and continue to
  verify organization membership from durable state.
- [ ] Add negative tests for wrong organization, wrong realm, missing membership, wrong principal
  kind, revoked/suspended machine identity, and attempts to supply organization scope through an
  untrusted body or header.

### Pilot domain: bookings

- [x] Create `domains/bookings/{model,commands,queries,policy,postgres}.rs` (or equivalent module
  files) and move booking business behavior there without changing the existing product API.
- [x] Move booking request/response DTOs out of `db/models.rs`; keep transport contracts distinct
  from persistence rows and domain inputs/results. Evidence: `domains/bookings/transport.rs` owns
  the booking request DTOs and shared service response envelope; `db/models.rs` has no booking
  transport types.
- [x] Implement shared booking queries and commands for service listing/creation/update and booking
  listing/creation/update using `RequestContext` and typed inputs.
- [x] Move organization/resource authorization, admin requirements, customer ownership, scheduling
  validation, overlap checks, status transitions, and conflict/not-found behavior into the shared
  booking operation boundary.
- [x] Keep SQL in `domains/bookings/postgres.rs` initially; introduce repository traits only where
  transaction control, substitution, or isolated policy testing requires them.
- [x] Adapt the existing `/api/bookings/*` handlers to the new operations with response-parity tests.
  Evidence: product handlers use the shared booking commands/queries, the internal service adapter
  uses the same query boundary, and `domains/bookings/transport.rs` tests the shared response
  envelope (`15d3f77`).
- [x] Expose one typed internal booking capability through the same operations to prove a second
  adapter does not duplicate SQL, validation, or authorization. Evidence: the internal
  `/api/internal/agents/v1/bookings/services` route resolves the delegated `RequestContext` and
  calls `capabilities::core_adapter::list_booking_services`; the Agent client/tool and route
  regression test cover the typed boundary (`15d3f77`).

### Capability and execution integration

- [x] Add the existing workspace `actions` and `execution` crates as `kasitek-core` dependencies.
- [x] Create `capabilities::catalog`, `capabilities::handlers`, and `capabilities::core_adapter` and
  register the pilot booking actions using the existing `ActionDefinition`, actor, scope, risk,
  approval, idempotency, and execution primitives.
- [x] Map capability handlers to domain commands/queries; do not implement business behavior inside
  the registry or capability transport.
- [x] Establish typed conversion between `actions::Actor`/`Scope` and core `RequestContext`, with
  explicit rejection of realm, runtime, organization, and client-scope mismatches.
- [x] Establish a repeatable domain migration template covering models, commands, queries, policy,
  Postgres/provider adapters, product adapter, internal capability adapter, tests, and evidence.
  Evidence: `docs/internal/architecture/domain-migration-template.md` defines the migration,
  adapter, verification, completion, and evidence gates.

### Large-domain decomposition order

- [x] Record the migration order after the bookings pilot: contacts/customers, connections,
  content/social posts, campaigns, conversations/inbox, social providers/publishing, WhatsApp,
  billing, then auth/admin; change the order only with documented dependency evidence. Evidence:
  `docs/internal/architecture/domain-migration-template.md` records the ordered dependency list.
- [x] Split social into channels, posts, publishing, OAuth, webhooks, and per-provider adapters rather
  than moving the existing `services/social.rs` unchanged. Evidence: `0747b4f`, `09f5e68`,
  `c16727f`, `ddf8474`, `8b1fc14`, `5e2d6d8` extract the channel lifecycle, post lifecycle,
  OAuth, webhook, publishing, and provider-account boundaries while preserving controller-facing
  `social::` exports; `cargo fmt --check`, `cargo check -p kasitek-core`, and the core library suite
  pass (85 tests, 3 infrastructure-gated ignores).
- [x] Split WhatsApp into connections, contacts, templates, campaigns, inbox transport, provider
  webhooks, calls, and delivery workers rather than moving `services/whatsapp.rs` unchanged.
  Evidence: `07069a4`, `7be54cf`, `9ffd858`, `f42a00e`, `ec4842c`, and `ca89e40` extract the
  template, connection, contact/list, campaign/worker, provider-webhook, and inbox/delivery
  boundaries while preserving controller-facing `whatsapp::` exports; `cargo fmt --check`,
  `cargo check -p kasitek-core`, and the core library suite pass (85 tests, 3 infrastructure-gated
  ignores).
- [x] Remove migrated request DTOs and row types from the global `db/models.rs`, and remove obsolete
  controller/service functions only after callers and parity tests have moved. Evidence:
  `7daf4da`, `afb64dc`, `7baa1ae`, `b8dec88`, `cf94066`, `dd5338c`, and `f7a7a99` move the
  WhatsApp, call, inbox, social, notification, website/AI, and auth/admin model definitions into
  owning modules; `db/models.rs` now contains only compatibility re-exports. Caller inventory and
  the core route/library suite pass (85 tests, 3 infrastructure-gated ignores), and no obsolete
  controller/service function remained after the active export/parity review.

### Verification

- [x] Run `cargo fmt --check`, `cargo check -p kasitek-core`, and `cargo test -p kasitek-core` after
  each coherent migration step. Evidence: the latest WhatsApp decomposition/model slices through
  `f7a7a99` and `cf94066` were each followed by format, check, and core library verification;
  the current suite passes 85 tests with 3 infrastructure-gated ignores.
- [x] Add route-inventory tests proving all pre-existing routes remain mounted during the structural
  migration and that `/v1` is not accidentally served by product or website modules. Evidence:
  `c5c2cb7` and `62e2ec2` preserve the 225 path inventory, exercise representative route mounts,
  and assert `/v1` ownership in `api::public_v1`.
- [ ] Add booking unit tests for normalization, validation, policy, status, overlap, and organization
  isolation plus database integration tests for transactional outcomes.
- [x] Add product-versus-internal booking parity tests proving both adapters invoke the same business
  behavior while preserving their distinct authentication and response envelopes. Evidence:
  `41778a7` centralizes request normalization and typed list envelopes in the shared bookings
  transport; product and delegated handlers call the same query boundary and serialize identical
  service/booking response contracts, with focused parity tests in `domains/bookings/transport.rs`.
- [ ] Run existing workspace, customer, connection, and billing database suites to detect unrelated
  regressions caused by application-state or route restructuring.
- [x] Record the changed paths, preserved contracts, test commands, and commit for the slice.
  Evidence: the progress record lists the booking transport/internal capability, public content,
  identity, and policy slices with preserved envelopes, commits, and verification commands.

**Complete when:** `kasitek-core` has testable composition, separately mounted API surfaces, a
normalized identity boundary, one real domain shared by product and capability adapters, and a
repeatable migration pattern; no public `/v1` or agent operation needs to call a legacy controller
or duplicate booking SQL/business rules.

## Slice 2 — Shared contracts, installations, and identity

**Layers covered:** 1, 2, 3, and 4

### Deliverables

- [x] Define shared types for execution modes, definition/version/installation lifecycle,
  `AgentPrincipal`, actor attribution, resource selectors, grants, limits, and availability.
- [x] Implement migrations and repositories for principals, named credentials, installation grants,
  resource constraints, connector grants, limits, and usage attribution.
- [x] Implement installation create/read/update/archive and suspend/resume/revoke APIs with strict
  organization ownership and protected KasiAi rules.
- [x] Implement copy-once installation secrets stored only as hashes, credential listing metadata,
  rotation, revocation, expiry, and last-use tracking.
- [x] Implement token exchange for short-lived audience-bound access tokens and enforce current
  credential, installation, organization, scope, and resource status on every request.
- [x] Implement `development_full_access` for controlled test workspaces with immutable exclusions
  for secrets, billing mutation, organization privilege, workspace deletion, and policy bypass.
- [x] Expose installation lifecycle, credential metadata, grants, usage, and health to customer and
  operator read models without exposing secret material.
- [x] Add public-key client assertion support before production external-agent release. Evidence:
  `a0521bb` adds P-256 SPKI registration, ES256 assertion verification, atomic database replay
  consumption, UI registration, integration documentation, and focused HTTP/auth/migration tests.

### Verification

- [x] Add migration/repository tests for installation ownership, lifecycle, credentials, grants,
  resource constraints, and usage records.
- [x] Add auth tests for token exchange, expiry, narrowing, replay, rotation, revocation, suspended
  installations, wrong audience, and cross-organization access.
- [x] Run Agent Platform tests, database integration tests, typecheck, and build.
- [x] Smoke-test a named test credential obtaining a token and losing access immediately after
  revocation.

**Complete when:** each agent installation has an independent non-human identity and can be safely
authenticated, scoped, audited, suspended, and revoked without a human browser session.

## Slice 3 — Capability registry and core authorization boundary

**Layers covered:** 3, 4, and 6

### Deliverables

- [x] Make one versioned `CapabilityManifest` registry authoritative for schemas, scopes, resources,
  risk, approval policy, idempotency, availability, errors, receipts, and redaction metadata.
- [x] Define common invocation, result, error, pagination, batch-result, and effect-receipt envelopes.
- [x] Generate internal tools, MCP tools, permission UI, audit descriptions, and agent documentation
  from capability manifests. Keep public REST/OpenAPI contracts core-owned, while sharing or
  contract-testing overlapping business/action schemas. Evidence: `2952291` adds the manifest
  surface projector, generated catalog command/output, MCP/public discovery projections, UI
  permission/audit metadata, and parity tests.
- [x] Implement central policy evaluation using installation grants, credential restrictions,
  resource scope, availability, approval, and limits with structured denial reasons.
- [x] Implement filtered capability discovery for the authenticated installation. Evidence:
  Agent Platform `/v1/installations/:installationId/capabilities` applies effective installation
  grants and is covered by `capability-discovery.test.ts`.
- [x] Replace static internal core authentication with one-to-two-minute ES256 per-invocation
  delegation, JWKS publication/rotation, audience checks, and replay protection.
- [x] Add typed internal core handlers that independently validate organization, agent principal,
  capability/version, resources, user/approval authority, and business preconditions.
- [ ] Ensure core owns business mutations, transactional outbox/action records, provider
  idempotency, effect receipts, and signed lifecycle events back to Agent Platform.

### Verification

- [x] Add manifest schema/version/compatibility and generated-surface parity tests.
- [x] Add policy matrix tests covering allowed, narrowed, denied, unavailable, approval-required,
  rate-limited, and cross-resource invocations.
- [x] Add delegation signature, issuer, audience, expiry, replay, rotation, and confused-deputy tests.
- [ ] Contract-test each initial core domain operation through its product, public REST, and
  private delegated adapters where those surfaces exist.
- [x] Run TypeScript and Rust unit/integration suites, typecheck, formatting, and builds.

**Complete when:** every agent entry point reaches product operations through the same manifest,
policy, delegation, and typed core handler, while product and public REST adapters reach the same
domain commands and queries with no direct database or special-agent bypass.

## Slice 4 — Durable runtime, model gateway, and run lifecycle

**Layers covered:** 5 and 8

### Deliverables

- [x] Use one AgentRun, attempt, ordered-event, tool-call, model-call, approval, and effect model for
  browser, channels, hosted agents, MCP, schedules, and agent webhooks. Link core API/action records
  when an AgentRun invokes a public or private core operation.
- [x] Route model work, multi-step workflows, waits, approvals, schedules, provider effects,
  polling, and recovery through Temporal with stable idempotency-derived workflow IDs.
- [x] Enforce per-conversation, installation, provider, recipient, and effect concurrency rules.
- [x] Implement bounded retries, timeouts, cancellation, terminal state, needs-attention state,
  dead-letter/recovery behavior, and safe stream-disconnect polling.
- [x] Keep OpenRouter, OpenAI, Anthropic, and Gemini behind a provider-neutral model gateway with
  model discovery, credentials isolated to activities, fallback policy, usage, latency, and cost.
- [x] Keep attachments/media in object storage through ownership-checked references, hashes, MIME
  validation, scanning state, expiry, and retention.
- [x] Persist safe run activity before broadcasting it to realtime clients.

### Verification

- [x] Add workflow tests for idempotent start, duplicate send, concurrent send, retries, timeout,
  cancellation, worker restart, approval wait, and effect recovery.
- [x] Add model gateway contract tests for each configured provider, fallback, errors, metering, and
  secret redaction.
- [ ] Test stream interruption followed by polling/reconciliation without false network errors or
  duplicate messages.
- [ ] Run Agent Platform tests, Temporal tests, typecheck/build, and at least one configured live
  provider smoke test.

**Complete when:** a run survives process/connection failures without losing state, duplicating
effects, leaking credentials, or leaving the UI unable to determine its true status.

## Slice 5 — First complete capability domain: content and social

**Layers covered:** 4, 5, 6, 8, and 12

### Deliverables

- [x] Implement manifests and typed core handlers for content listing, content detail, and
  idempotent drafts; the shared internal route is now used by the Agent Platform client.
- [x] Complete typed handlers for updates, publish status, scheduling, unscheduling, publishing,
  and delete/archive behavior supported by the product. Evidence: the normalized content adapter
  now exposes draft update, publish, schedule, unschedule, and unpublished-delete transitions;
  Agent internal routes, core client methods, approval/idempotency manifests, and generated
  capability documentation cover the full typed surface. Rust core checks/tests and the Agent suite
  (33 files, 145 passed, 24 environment-gated skips) pass.
- [x] Apply organization, capability, ownership, and resource checks to the current read, draft,
  and approval-gated publish handlers.
- [x] Implement draft operations as immediate safe writes and real publish/schedule effects through
  immutable preview, approval, idempotent core action/outbox, provider receipt, and reconciliation.
  Evidence: `server/kasitek-core/src/capabilities/content_adapter.rs` routes draft, publish, schedule,
  unschedule, and delete actions through organization-scoped durable content jobs with idempotency
  markers and provider receipt/reconciliation state; `agents/src/temporal/activities.ts` captures
  bounded content projections before approval and reuses the persisted snapshot on resume; commit
  `61a514c` adds the cross-runtime preview and review UI. Agent suite (161 passed, 24 gated skips),
  Agent build, client targeted lint, and client TypeScript checks pass.
- [x] Return platform capability differences and partial batch results explicitly rather than
  claiming unsupported behavior.
- [x] Record run, tool, approval, effect, provider, delivery, usage, and audit events with shared IDs.
- [ ] Expose the same content capabilities to KasiAi tools, hosted agents, MCP, and REST without
  duplicating handlers.
- [x] Add customer activity and content-operator investigation views for content actions and failures.
  Evidence: `GET /api/social/posts/{id}/activity` returns an organization-scoped, secret-safe
  durable timeline, and `client/apps/client/src/components/social/posts-workspace.tsx` now shows
  provider job status/error details with retry, run-now, and cancel recovery controls that refresh
  the activity projection after each action. Global KasiTek admin investigation remains a separate
  Slice 12 deliverable.

### Verification

- [x] Add contract tests for every content manifest and core handler. Evidence: `agents/test/content-capability-contract.test.ts` validates all eight content manifests, argument schemas, grant/approval gates, and redaction metadata; `agents/test/core-client.test.ts` covers every typed Agent-to-core content route; `server/kasitek-core/src/capabilities/content_adapter.rs` covers invalid publish/schedule and missing-idempotency guards without database access.
- [ ] Add authorization/isolation tests across organizations, installations, connected accounts,
  platforms, and content ownership.
- [ ] Add idempotency, duplicate provider callback, delayed/out-of-order callback, partial batch,
  ambiguous outcome, reconciliation, and approval mutation tests.
- [ ] Run database migrations, TypeScript/Rust suites, typechecks, lint/format, builds, and provider
  sandbox smoke tests for each configured social platform.

**Complete when:** one approved content action can travel end to end from any supported agent entry
point to the provider and back to a durable, auditable result with no duplicate effect.

## Slice 6 — Grounded KasiAi

**Layers covered:** 9, 10, and 11

### Deliverables

- [x] Replace generic product claims with reviewed, versioned KasiTek knowledge and remove all
  unsupported projects/resources/repositories guidance.
- [x] Build minimal dynamic context from the authenticated user, organization, enabled modules,
  route/entity, current conversation, and currently available capabilities. The shared context
  builder now includes authenticated actor/organization identity, granted capability names and
  capability modules, durable conversation context, and bounded route/entity/page context as
  untrusted data; `agents/src/runtime/context.ts`, `agents/src/temporal/activities.ts`,
  `agents/test/context.test.ts`, and commit `4e8df19`.
- [x] Grant KasiAi real read, draft, and approved action capabilities only through the shared
  Capability Gateway. The protected v3 policy now grants scoped content reads, reviewable draft/
  update writes, and approval-gated publish/schedule effects; runtime grant resolution and the
  release gate still reject any capability outside the registered allowlist.
- [x] Make answers distinguish tool-derived facts, reviewed product knowledge, unavailable actions,
  and uncertain information; never claim a tool or data source that was not used. Completed runs now
  carry a redacted `kasiai-grounding-v1` provenance summary with organization scope, reviewed-source
  counts, authorized/used tools, unavailable actions, and an explicit no-unsupported-certainty marker;
  `KasiAiChat` renders the safe summary without prompts, arguments, or provider output.
- [x] Preserve independent user-owned conversations, explicit browser conversation IDs, durable
  history, summaries, model selection, chat naming, new-chat behavior, and channel defaults.
- [x] Show tool activity, approval previews, results, errors, retries, and final run status clearly in
  the KasiAi workspace without exposing hidden reasoning. The chat surface shows durable run events,
  terminal status, activity deep links, and the safe grounding summary; approval previews and durable
  effect evidence remain available on the linked activity view.
- [x] Provide relevant starter suggestions and page help derived from real available capabilities.
- [x] Expose KasiAi health, rollout version, failure class, and usage in the operator console.

### Verification

- [x] Add deterministic and adversarial evaluations for grounded answers, unsupported claims,
  correct tool choice, authorization denials, injection attempts, and safe failure language. The
  versioned KasiAi catalog covers navigation, unavailable-feature handoff, organization isolation,
  prompt injection, denied effects, and permitted read-only tools; provenance and capability-contract
  suites add deterministic evidence/redaction and policy-boundary assertions.
- [x] Add conversation isolation, new-chat, deep-link, refresh, concurrent-send, idempotency,
  channel-default, archive/delete, and model-preference tests.
- [x] Add client component/accessibility and sidebar send/history/reconnect/cancel tests.
- [ ] Run Agent Platform/core/client tests, typechecks, lint/format, production builds, and an
  authenticated browser smoke test using real workspace data.

**Complete when:** KasiAi accurately describes and operates the implemented KasiTek product using
real capabilities, preserves independent chats, and never invents platform features or results.

## Slice 7 — Public REST API and external MCP gateway

**Layers covered:** 2, 3, 4, 6, 7, 12, and 13

### Deliverables

- [x] Create a separately deployed TypeScript `agent-gateway` process inside the `agents` package;
  give it independent configuration, health, logs, rate limits, tests, scaling, and kill switch.
- [x] Add `dev:gateway` and `start:gateway` package commands and a Railway service using the latter;
  route `agents.kasitek.co.za/mcp` to this process without routing `/v1` through it.
- [x] Implement remote MCP Streamable HTTP initialization, negotiation, `tools/list`, `tools/call`,
  structured results/errors, cancellation, and filtered discovery over the Agent Platform
  Capability Gateway. Keep the gateway stateless initially and give it no direct core/database
  access or ownership of runs, approvals, definitions, or product data.
- [x] Create the separately managed Rust `api::public_v1` module inside `kasitek-core` and mount it
  only at `/v1`; keep existing `/api/*` product routes, `/api/admin/*`, anonymous website routes,
  provider webhooks, and private `/api/internal/*` routes distinct.
- [x] Serve `/v1` from the existing `kasitek-core` process and route `api.kasitek.co.za/v1/*` to it;
  do not create a separate public API deployment during the initial implementation.
- [ ] Give `/v1` dedicated routes, authentication, contracts, middleware, OpenAPI, webhooks,
  metering, rate limits, flags, metrics, versioning, deprecation, and tests while reusing shared core
  domain commands and queries. Current partial evidence: `59ad609` adds centralized correlation,
  stable error codes, rate-limit response metadata, and required draft idempotency; `587f101`
  validates `version=v1` across every paginated resource list and updates the core OpenAPI contract.
  `8a68bab`, `81912a5`, `2480e6e`, `753d84f`, and `859ec5e` add durable signed webhook
  subscriptions/deliveries, redacted content domain events, idempotent subscription creation,
  delivery diagnostics, route feature flags, standard deprecation headers, explicit
  capability-discovery policy metadata, and focused REST/OpenAPI contract assertions. `90c2bf5`
  centralizes the executable boundary policy for `direct_user` and `agent_installation`, gives
  unsupported workspace API-key, service-account, and OAuth issuer kinds a stable
  `unsupported_principal` denial before resource lookup, and expands OpenAPI coverage to the
  anonymous document route, concrete principal/transport policy schemas, and every mounted `/v1`
  operation. The approved issuer matrix, action feature/resource policy, and full external REST
  conformance remain open.
- [x] Require each `/v1` operation to enter through normalized `RequestContext`; no public handler
  may call a legacy product controller, inspect product session cookies, or duplicate domain SQL,
  provider calls, authorization, validation, or idempotency behavior. All authenticated public data
  routes call the shared `public_context` boundary and then the typed core adapter/query services;
  only the intentionally anonymous health/OpenAPI documents bypass context resolution.
- [ ] Support the approved public API principals—workspace API keys, service accounts, OAuth
  user/application grants, and agent installations—through explicit scopes and resource policy.
  `90c2bf5` makes the current boundary explicit and testable: direct users and agent installations
  are supported, while the not-yet-implemented workspace API-key, service-account, and OAuth issuer
  kinds are rejected deterministically with `unsupported_principal`; adding those issuers and their
  scope/resource policy remains required.
- [x] Publish typed public resource/action endpoints and only add a generic versioned action route
  where it benefits non-agent API consumers. A direct REST call does not automatically create an
  `AgentRun`; it always creates API/action audit and usage records and links an AgentRun when one
  actually initiated the call. The current typed slice covers organization-scoped content,
  contacts, inbox, bookings, campaigns, and templates; request accounting is durable and action
  attribution is attached by the shared public capability boundary.
- [x] Publish core-owned OpenAPI 3.1 for `/v1` and agent-readable MCP integration documentation;
  validate overlapping MCP schemas and outcomes against the shared business/action contracts.
  The current public resource contract is served at `/v1/openapi.json` from
  `server/kasitek-core/openapi/v1.json`; MCP authentication, discovery, protocol, idempotency,
  and structured outcomes are documented in `agents/docs/mcp-integration.md` and covered by the
  gateway/core contract suites (`c5c48a4`). `90c2bf5` adds the anonymous OpenAPI document operation,
  concrete principal/transport policy schemas, and the core contract assertion that enumerates every
  mounted `/v1` operation with required success/error responses and protected/anonymous security
  behavior. Broader principal and provider conformance remains open.
- [x] Protect the initial `/v1/capabilities` route with the normalized direct-user request context,
  exclude non-public/unsupported actions, return a stable public capability DTO, and document the
  current session-authenticated contract in the core-owned OpenAPI file.
- [x] Add optional core verification of Agent Platform ES256 installation tokens with the exact
  `kasitek-public-api` audience and configured issuer; installation revocation/introspection and
  grant/entitlement lookup remain runtime policy work.
- [x] Expose the first typed public resource slice through the shared content adapter: organization-
  scoped post list/detail and idempotent draft creation; keep publish/schedule effects outside the
  initial public route set until their approval/effect contract is externally verified.
- [x] Use installation token exchange and protected-resource metadata for MCP. When an installation
  uses REST, issue/validate a REST-audience token through the public API principal framework rather
  than routing the request through MCP.
- [x] Add an installation-scoped REST transport for external agents: filtered capability discovery,
  tool invocation, idempotent durable operation references, operation timelines, and workflow
  cancellation. Keep its grants and API scopes separate from MCP scopes while reusing the same
  tool-run acceptance boundary.
- [x] Implement signed outbound webhooks with subscription scope, delivery records, exponential
  retry, replay protection, disable/re-enable policy, and diagnostics. `8a68bab`, `81912a5`, and
  `753d84f` and `859ec5e` add encrypted organization-scoped subscriptions, HMAC-SHA256 delivery
  signatures over timestamp plus raw body, idempotent request/content event enqueueing and
  subscription creation, stale-claim recovery, capped retries, automatic disablement after ten
  failures, redirect-disabled SSRF protection, and `/v1/webhooks/subscriptions/{id}/deliveries`;
  focused core tests, cargo check, OpenAPI parsing, and Prisma schema validation pass.
- [x] Add an external-agent connection wizard with named credentials, copy-once setup, grants,
  resource scope, health diagnostics, rotation/revocation, examples, and audit activity. The
  `/agents/connect` flow reuses installation credential/grant APIs, shows capability availability
  and resource/connector health, offers MCP/REST examples, and links to detail controls for
  rotation/revocation and durable audit activity. Evidence: `client/apps/client/src/app/(dashboard)/agents/connect/page.tsx`,
  `client/apps/client/src/components/dashboard/agents/agent-connection-wizard.tsx`, commit `eaf6106`.
- [x] Add the first credential-management slice: named installation credentials, independent
  API/MCP scopes, copy-once secret display, list, and revocation in the Agents UI.
- [x] Add installation capability discovery and grant controls through the authenticated core proxy;
  keep invocation-time grant checks as the final enforcement boundary.
- [x] Add a local stdio bridge only for clients that cannot connect to hosted Streamable HTTP.
  `1efd1bb` adds the stateless line-delimited JSON-RPC proxy at `agents/src/gateway/stdio.ts` with
  bounded request/response size, bearer/protocol forwarding, notification silence, and unit tests.
- [x] Add gateway transport hardening: bounded pre-authenticated/authenticated rate windows,
  explicit emergency disable configuration, protocol revision negotiation, and explicit unsupported
  GET/session behavior; keep policy and kill-switch ownership in Agent API/runtime.

### Verification

- [ ] Add MCP protocol, authentication, discovery filtering, cancellation, error, instance-isolation,
  stateless scaling, and Agent Platform adapter tests. Focused coverage now includes the Agent API
  and gateway HTTP matrices, protocol notifications/cancellation, structured errors, token claim
  ownership checks, MCP/REST acceptance parity, gateway replica behavior, and the stdio bridge
  (`8dfa645`, `187b427`, `773b250`, `1efd1bb`); full external-client and live infrastructure proof
  remains open.
- [x] Add focused gateway tests for rate limiting, protocol negotiation, transport disable, bounded
  lifecycle methods, and upstream header propagation.
- [x] Add gateway readiness against the Agent API, correlation-id propagation, and redacted
  operational counters/latency metrics without introducing business-state ownership.
- [ ] Add REST/OpenAPI conformance tests for every principal type, scope/resource authorization,
  pagination, validation, idempotency, rate limits, metering, webhooks, versioning, and deprecation.
  The route/status/security matrix and direct-user/agent-installation policy assertions now pass in
  `90c2bf5`; Agent installation REST now also shares the protocol-neutral acceptance service with MCP,
  rejects malformed idempotency keys, verifies token-record ownership, and has a runnable generic
  Python smoke client (`8dfa645`, `74a43ec`, `773b250`, `730fc2b`). Issuer-specific, resource-policy,
  n8n, and external-client verification remains open.
- [x] Add focused installation REST tests for audience authentication, API scope enforcement,
  installation isolation, durable invocation/idempotency, operation inspection, and cancellation.
- [ ] Add behavior-parity tests proving equivalent MCP and REST operations converge on the same core
  domain command/query and compatible authorization, approval, idempotency, effect, receipt, and
  audit outcomes without requiring identical protocol envelopes.
- [ ] Verify real Codex, Claude Code, and one generic MCP client.
- [ ] Verify n8n and one plain TypeScript or Python REST client.
- [ ] Run typechecks, lint, builds, security checks, and externally hosted smoke tests.

**Complete when:** general integrations can use the independently managed core `/v1` API, external
agents can use the separately deployed MCP gateway, agent installations can also authenticate to
REST where permitted, and equivalent operations share business behavior without duplicated logic.

## Slice 8 — KasiTek-hosted user agents and external connectors

**Layers covered:** 1, 8, 10, and 11

### Deliverables

- [x] Implement general hosted agent definitions with instructions, model policy, capability grants,
  connector grants, knowledge/memory, channels, schedules, workflow graph, limits, and handoff.
  Evidence: the hosted-agent create and draft-version flows persist validated runtime ceilings in
  `client/apps/client/src/components/dashboard/agents/agent-runtime-limits.tsx`,
  `client/apps/client/src/components/dashboard/agents/create-agent-page-client.tsx`, and
  `client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx`; the existing
  Agent detail UI covers grants, connectors, knowledge/memory, channels, schedules, runs, and
  workflow editing. Durable handoff is implemented across `agents/src/workflows/executor.ts`,
  `agents/src/temporal/workflows.ts`, and the external-event API (commit `5f4aeed`). Agent build,
  client typecheck/lint/production build, and core checks passed.
- [x] Implement guided creation for a small set of real templates; templates create ordinary
  versioned definitions and do not introduce template-specific runtime paths.
- [x] Implement draft/publish/rollback/retire versioning and safe installation updates.
- [x] Implement provider-neutral external connector manifests, vault references, ownership,
  OAuth/API-key lifecycle, tool schemas, output redaction, retry, rate limits, and audit receipts.
- [x] Keep external connector credentials out of prompts, workflow history, traces, MCP output, and
  Agent Platform records except opaque references and safe metadata.
- [x] Add schedules, triggers, workflow execution, channel binding, test runs, and deterministic
  human handoff using the shared runtime.
- [x] Build hosted agent detail/configuration UI covering overview, versions, capabilities,
  connections, knowledge/memory, channels, runs, approvals, usage, and settings. Evidence:
  `client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx`,
  `client/apps/client/src/app/(dashboard)/agents/activity/[runId]/page.tsx`, commits
  `152192e`, `81807cb`, `87c9e12`, `5765e7e`, `55e33d6`, `52def06`, and `4e04a17`;
  client lint/typecheck/production build passed with the existing unrelated image warning.
- [x] Add the installation operations slice: capability grants, credential lifecycle, and recent
  durable run history are available from the authenticated core-proxied Agent details view.
- [x] Preserve the later visual workflow builder as an editor over the same graph/version/runtime,
  with validation, installed-version test runs linked to durable timelines, publishing, rollback,
  and secret-safe import/export. Evidence: `client/apps/client/src/components/dashboard/agents/agent-workflow-editor.tsx`,
  `client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx`, and commits
  `b2de22f`, `0812616`, `bcb7ba2`. The run detail also consumes the core-proxied SSE stream for
  live durable timeline updates, terminal refresh, and degraded/retry handling (`4466439`, `9d0635a`).

### Verification

- [x] Add definition/version/installation lifecycle, template creation, connector ownership,
  credential isolation, schedule, workflow, and handoff tests. Evidence:
  `agents/test/hosted-agent-boundaries.integration.test.ts` covers organization-scoped definitions, published versions,
  installation status/settings, resource and connector grants, schedules, and workflow validation;
  `agent-lifecycle.integration.test.ts`, `template.integration.test.ts`, `credential.integration.test.ts`,
  and `workflow-graph.test.ts` cover rollback/template/credential/workflow-handoff paths. The full
  PostgreSQL + Temporal suite passed 49 files / 202 tests / 0 skipped.
- [ ] Add tests proving hosted agents cannot escape declared capabilities, resources, connectors,
  budgets, concurrency, or approval policy.
- [ ] Run a complete template scenario from creation through test, publish, channel/connector use,
  approval, effect, activity, and rollback.
- [x] Run Agent Platform/core/client suites, typechecks, lint/format, and production builds. Current
  verification: Agent suite 202 passed with zero skips against isolated PostgreSQL and local
  Temporal, Agent build and client typecheck/lint/production build pass, and `kasitek-core`
  format/check/unit suite is green (105 passed, 3 seeded/infrastructure ignores).

**Complete when:** a user can create, test, publish, observe, pause, update, and roll back a hosted
agent that safely combines KasiTek capabilities with approved external services.

## Slice 9 — Conversations, channels, knowledge, and memory

**Layers covered:** 9 and 10

### Deliverables

- [x] Enforce personal user-owned and business customer/thread-owned conversation identity with
  organization, installation, participant, external identity, channel, and thread isolation.
- [x] Keep browser new chats explicit and prevent fallback to an external channel-default chat.
- [x] Standardize inbound/outbound channel envelopes, dedupe, ordering, consent/opt-out, delivery
  status, provider IDs, attachments, retries, handoff, and reply-before-delivery persistence.
- [x] Complete thin WhatsApp, Telegram, and Discord adapters; add email later using the same boundary.
- [x] Make authorized external-channel conversations observable in the product without merging
  separate agents, users, customers, or threads.
- [x] Implement bounded recent history, scoped summaries, on-demand older history, reviewed
  knowledge ingestion, source attribution, and trusted/untrusted content boundaries.
- [x] Implement selective memory with conversation/user-private/organization-shared/agent-private
  namespaces, provenance, confidence, consent, edit/delete, expiry, export, and retention.
- [x] Add attachment scanning, prompt-injection boundaries, provider privacy settings, and minimal
  model-bound data policy.

### Verification

- [ ] Add channel signature, replay, duplicate, ordering, reconnect, delivery retry, opt-out,
  attachment, handoff, and identity-mapping tests.
- [ ] Add cross-user, cross-organization, cross-installation, cross-channel, and customer/thread
  isolation tests.
- [ ] Add summary window, memory scope, provenance, consent, deletion, export, poisoning, and prompt
  injection tests/evaluations.
- [ ] Run browser plus configured WhatsApp/Telegram/Discord end-to-end scenarios, service tests,
  typechecks, and builds.

**Slice 9 evidence (2026-08-14):** `MemoryRepository` deletion and revalidation now enforce
namespace-specific installation, conversation, and user ownership; `KnowledgeRepository` source
lookup, ingestion, listing, and deletion now enforce agent/installation scope; and channel delivery
attempt creation verifies the message's organization and conversation before inserting a retry. The
new cross-scope regressions live in `agents/test/memory.integration.test.ts` and
`agents/test/channel.integration.test.ts`. The full PostgreSQL + Temporal suite passed 49 files /
202 tests / 0 skipped. Browser/provider scenarios, opt-out, reconnect, and the complete channel
matrix remain open.

**Complete when:** every supported channel reaches the same durable agent runtime while identity,
conversation history, delivery, knowledge, and memory remain correctly scoped and recoverable.

**Slice 10 evidence (2026-08-14):** Enabled content effects now capture an explicit, bounded
operation preview alongside the immutable content-post projection: publish includes its target
platform, schedule includes its requested time, unschedule includes the reviewed scheduled time,
and delete records the reviewed-to-deleted transition. `agents/test/approval-preview.test.ts`
covers all four transitions, the persisted operation preview, and fail-closed behavior when the
resource cannot be read. The full PostgreSQL + Temporal suite passed 49 files / 202 tests / 0
skipped. Sending/replying, campaigns, bookings, and later-domain previews remain intentionally
open until their real effect handlers and provider boundaries are enabled.

## Slice 10 — Approvals, effects, and operational recovery

**Layers covered:** 5, 8, and 12

### Deliverables

- [x] Bind each approval to organization, installation, capability/version, normalized argument hash,
  resources, immutable preview revision, approver, expiry, and one permitted effect.
- [x] Implement authenticated web approval, denial, cancellation, expiration, execution-time
  reauthorization, polling/wait/webhook status, and structured `APPROVAL_REQUIRED` responses.
- [ ] Implement domain previews for publishing, sending/replying, campaigns, bookings, destructive
  actions, and later domains before enabling their real effects.
- [x] Persist effect state and provider receipts; classify ambiguous outcomes as
  `reconciliation_required` and prohibit blind retry.
- [x] Implement safe retry, cancellation, compensation where supported, scheduled-action revision,
  and kill-switch cancellation.
- [x] Present approvals, receipts, reconciliation, and recovery consistently in the shared Agents
  experience. Run details expose immutable approval previews plus safe step/tool/effect evidence;
  Activity exposes audited effect reconciliation and organization/agent/installation/tool kill
  switches through the authenticated core proxy. Evidence: `f345261`, `2b29142`, `4e63f82`,
  `c05e506`.

### Verification

- [ ] Add approval hash/version/resource/expiry/single-use, self-approval, changed-permission,
  cancellation, and concurrent-decision tests.
- [x] Add effect idempotency, crash-after-provider-call, timeout, duplicate callback, reconciliation,
  compensation, and kill-switch tests.
- [ ] Run end-to-end approved and denied actions from KasiAi, hosted agent, MCP, REST, and a channel.
- [ ] Run all service tests, database/Temporal recovery tests, typechecks, and builds.

**Complete when:** no real external effect can execute outside its exact current authorization and
every success, denial, failure, or ambiguous outcome has a durable operator-visible resolution path.

## Slice 11 — Shared Agents product experience

**Layers covered:** 11

### Deliverables

- [x] Build one `/agents` overview for KasiAi, hosted agents, external connections, templates,
  approvals, activity, usage, and health.
- [x] Build creation/connection flows with visible capabilities, resources, connectors, models,
  channels, limits, testing access, and approval behavior. Evidence spans the versioned creation
  flow and graph editor (`client/apps/client/src/components/dashboard/agents/create-agent-page-client.tsx`,
  `agent-workflow-editor.tsx`), external connection wizard (`agent-connection-wizard.tsx`), and
  installation detail controls; commit `6afb085` builds workflow configuration into creation.
- [x] Build common detail views for overview, configuration, versions, capabilities, connections,
  knowledge/memory, channels, conversations, runs, approvals, usage, credentials, and settings.
  `client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx` composes the
  shared installation controls, durable test chat, run/approval links, and usage summaries; the
  client lint/typecheck/build passed. Full browser/component verification remains open.
- [x] Add per-installation recent run history with status and safe error visibility; keep the broader
  detail-view areas open until their corresponding controls and tests are implemented.
- [x] Add connected-channel and binding observability with owner-scoped disconnect controls; provider
  secrets remain outside the browser and Agent Platform records.
- [x] Build credential create/copy-once/rotate/revoke and installation suspend/resume/archive UX.
- [x] Show safe run/tool/model/effect timelines, errors, recovery actions, usage, cost estimates, and
  current service readiness without exposing chain-of-thought or secrets.
- [x] Enforce personal KasiAi privacy, appropriate business-agent staff access, and workspace-owned
  administration throughout the UI.
- [x] Implement loading, empty, stale, degraded, retry, permission-denied, and accessibility states.

### Verification

- [ ] Add component, accessibility, permission, form validation, lifecycle, credential, approval,
  activity, usage, and degraded-state tests.
- [ ] Add end-to-end flows for KasiAi, template hosted agent, external agent connection, credential
  rotation/revocation, approval, suspension, and rollback.
- [ ] Run client lint/typecheck/build and cross-browser authenticated smoke tests.

**Complete when:** users can understand, create, connect, operate, inspect, and safely stop every
agent type from one consistent product area.

## Slice 12 — KasiTek admin operations console

**Layers covered:** 11, 12, 13, and 14

### Deliverables

- [ ] Define operator roles/permissions, data classifications, redaction rules, support-access
  grants, dual-control actions, emergency access, and prohibited operations.
- [ ] Implement a protected core operator API and short-lived signed core-to-agents operator
  delegation; never allow the admin browser to query Agent storage or Temporal directly.
- [ ] Build rebuildable read models for agent health, runs/events, usage/cost, deliveries/webhooks,
  providers/workers, alerts, and projection lag.
- [ ] Implement global search and investigation across organization/workspace, user, agent,
  installation, conversation, run, approval, effect, delivery, provider message, and correlation IDs.
- [ ] Build admin Operations pages for overview, organizations, agents/installations, runs/workflows,
  conversations/channels, approvals/effects, providers/connectors, queues/workers, usage/cost,
  alerts/incidents, audit/security, support access, and controls.
- [ ] Implement idempotent, version-checked, audited commands for retry, cancel, reconcile, assign,
  suspend/resume, credential revoke, safe webhook replay, scoped pause, feature flags, holds,
  export/deletion workflow requests, and hierarchical kill switches.
- [ ] Require time-limited audited support access for customer content; never reveal secrets, raw
  tokens, hidden prompts, or unrestricted customer data.
- [ ] Add operator notifications and runbooks for provider outage, queue backlog, stuck run,
  duplicate effect, webhook storm, model outage, credential compromise, and data access incidents.

### Verification

- [ ] Add role, resource-scope, redaction, support-grant, expiry, dual-control, command idempotency,
  delegation, and immutable audit tests.
- [ ] Add integration tests for core-to-agents operator reads/commands and projection rebuild/lag.
- [ ] Add end-to-end admin tests for viewer, support, operator, security, admin, and owner roles.
- [ ] Test organization isolation, secret absence, stale/degraded dependencies, retry/replay,
  cancellation, reconciliation, suspension, and every kill-switch level.
- [ ] Run core/Agent/admin tests, typechecks, lint/format, builds, and an internal incident drill.

**Complete when:** an authorized KasiTek operator can trace organization → installation → run →
model/tool → approval → effect → delivery and perform only safe, attributable, auditable recovery.

## Slice 13 — Security, observability, expansion, and production release

**Layers covered:** 12, 13, and 14

### Deliverables

- [x] Emit immutable redacted audit events and separate operational traces, metrics, and diagnostic
  logs with stable correlation across edge, Agent Platform, Temporal, core, and providers.
- [x] Attribute tokens/cost, tools, effects, connectors, channels, storage, schedules, failures,
  latency, and concurrency to organization, installation, definition/version, and credential.
- [ ] Implement health dashboards and alerts for auth, credentials, APIs, model providers, Temporal,
  queues/workers, databases, Redis, tools, provider effects, webhooks, delivery, approvals, cost,
  rate limits, and suspicious access.
- [x] Enforce the global → organization → definition → installation → capability → connector/channel
  kill-switch hierarchy and test rollback before destructive recovery.
- [ ] Implement retention, redaction, deletion, export, backup/restore, legal-hold readiness, and
  periodic access review for audits, traces, logs, webhook payloads, conversations, and memory.
- [x] Apply credential/replay/confused-deputy, injection, data minimization, attachment, SSRF,
  redirect, webhook, rate-limit, abuse, dependency, image, secret-scan, and deployment least-
  privilege controls.
- [ ] Expand capability domains in order—contacts/inbox, bookings, campaigns, automation/agent
  administration, workspace/reporting—using the same complete domain pattern proven by content.
- [ ] Maintain separate local, shared test, controlled beta, and production configurations with
  seeded test workspaces, independent flags, migrations, rollback paths, and production secrets.
- [ ] Publish REST/OpenAPI/MCP, customer, agent, admin, security, incident, runbook, catalog,
  changelog, and deprecation documentation.
- [ ] Decide and implement production entitlements, quotas, budgets, and approval policy only after
  controlled end-to-end testing is complete.

### Verification

- [ ] Run complete unit, database, contract, integration, Temporal recovery, MCP, REST/OpenAPI,
  webhook, provider, UI, end-to-end, evaluation, redaction, isolation, and security suites.
- [ ] Run TypeScript typechecks/builds, Rust formatting/check/tests, frontend lint/typecheck/builds,
  migration tests, dependency/image/secret scans, and production configuration validation.
- [ ] Prove grounded KasiAi; hosted agent channel/connector/approval; Codex/Claude MCP; n8n REST;
  immediate revocation; no duplicate effects; webhook replay rejection; isolation; admin recovery;
  backup restore; provider outage; worker restart; and rollback.
- [ ] Conduct security review and controlled internal beta with audit review before public beta.
- [ ] Promote each domain through read → draft → sandbox effect → real effect gates, with monitored
  rollback and incident ownership.

**Complete when:** the system can be deployed, monitored, secured, recovered, rolled back, and
expanded domain by domain with evidence that every supported agent mode works end to end.

## 5. Standard verification commands

Use the repository's actual package scripts and workspace commands. If a command changes, update
this section rather than allowing agents to invent inconsistent verification.

```bash
cd agents
pnpm test
pnpm build

cd ../server
cargo fmt --check
cargo check -p kasitek-core
cargo test -p kasitek-core

cd ../client
pnpm --filter client lint
pnpm build:client
pnpm --filter admin lint
pnpm build:admin
```

`agents` uses `tsc` for its build/typecheck. The Next.js production builds perform application
type validation. Browser, provider, hosted, Redis, and seeded-core tests remain separate required
gates because the basic commands above cannot prove those integrations.

- [x] Agent Platform unit tests pass.
- [x] Agent Platform database/integration tests pass against an isolated test database.
- [x] Agent Platform TypeScript typecheck and production build pass.
- [x] `kasitek-core` formatting, compile checks, unit tests, and relevant database integration tests
  pass.
- [ ] Direct client lint, typecheck, component tests, and production build pass.
- [ ] Admin client lint, typecheck, component tests, and production build pass.
- [ ] Relevant migrations apply from a clean database and from the supported previous schema.
- [x] Relevant local Temporal workflow/recovery tests pass against an isolated dev server; hosted
  Temporal and provider-side crash recovery remain separate release gates.
- [ ] Relevant provider sandbox or live smoke tests pass without logging credentials.
- [ ] Repository diff check, secret scan, and targeted security tests pass.

## 6. Final system definition of done

The agent system is complete for its first production release when:

- [ ] KasiAi, hosted user agents, and external agents all use one installation/capability/runtime
  model and can perform the supported product flows end to end.
- [ ] Content/social is proven completely and every additional enabled domain meets the same
  authorization, approval, effect, audit, UI, admin, and verification standard.
- [ ] Conversations, channels, knowledge, and memory remain isolated and recoverable across users,
  customers, organizations, installations, and providers.
- [ ] Credentials, tokens, connectors, and secrets can be rotated/revoked without leakage or
  downtime beyond their documented lifecycle.
- [ ] Every consequential action has authorization, idempotency, approval where required, a durable
  receipt, audit evidence, and a recovery path.
- [ ] Users can operate agents from the shared Agents experience and KasiTek staff can safely
  monitor and recover the system from the admin console.
- [ ] All required automated suites, typechecks, lint/format checks, builds, migrations, recovery
  drills, real-client compatibility checks, and release gates pass.
