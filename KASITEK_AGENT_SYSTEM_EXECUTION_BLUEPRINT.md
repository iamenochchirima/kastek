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

### Reconciliation evidence — 2026-08-14

The checked items below were reconciled against the current repository, migrations, focused tests,
and the commits listed in `docs/internal/architecture/agent-system-slices-2-7-progress.md`.
The Agent Platform suite now passes 58 files / 213 tests / 36 expected integration skips, and the
Agent build and core format/check/library tests pass. A checked
implementation item does **not** assert that its slice completion gate or production-release
verification has passed.

At the 2026-08-15 reconciliation point, 187 of 226 implementation/verification items are checked.
The count is a work map, not a claim that the first production release is ready.

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
- [x] Confirm local development starts the core, client, Agent API, Temporal worker, databases, and
  required realtime services with documented health checks. Follow-up evidence in
  `docs/internal/architecture/agent-system-slice-0-baseline.md` records the isolated and standard
  local stack starts, health/readiness checks, and authenticated Agent/gateway smoke paths; hosted,
  provider, browser, and Redis gates remain separate.
- [x] Create or update ADRs for any settled architecture decision not represented in code/docs.
- [x] Establish a short evidence format for completed slices: migration/API/test/command/commit.

**Slice 0 evidence (2026-08-13):** inventory and baseline results are recorded in
[`docs/internal/architecture/agent-system-slice-0-baseline.md`](docs/internal/architecture/agent-system-slice-0-baseline.md).
Pending environment and pre-existing frontend verification gaps are tracked in [`BLOCKERS.md`](BLOCKERS.md).

**Reconciliation evidence:** Agent migrations `027`–`035` applied locally and the complete Agent
suite passed 58 files / 249 tests / 0 skipped with PostgreSQL and an isolated Temporal dev server
(`RUN_AGENTS_DB_INTEGRATION_TESTS=true RUN_TEMPORAL_INTEGRATION_TESTS=true`). `pnpm build` passed;
`cargo fmt --check`, `cargo check -p kasitek-core`, and `cargo test -p kasitek-core --lib` passed
123 tests with three explicitly ignored seeded/infrastructure cases. Local Temporal recovery is
verified; authenticated browser, provider, hosted, Redis, and seeded-core gates remain open in
`BLOCKERS.md`.

### Verification

- [x] Run the existing Agent Platform unit and database suites.
- [x] Run Agent Platform typecheck/build, `kasitek-core` formatting/check/tests, and client/admin
  lint/typecheck/build baselines.
- [x] Run local authenticated KasiAi and Agents health smoke tests and record genuine failures.

**Slice 0 smoke evidence (2026-08-14):** core `/health` and `/v1/health`, Agent `/health/live` and
`/health/ready`, gateway `/health/ready`, client `/login`, and admin `/login`/`/dashboard` were
checked on a local stack. `pnpm run test:e2e:local` passed on both isolated `4110/4210` and standard
`4100/4200` Agent/gateway ports, covering installation credential exchange, filtered discovery,
REST idempotency, durable execution, MCP authentication, negotiation, and tool acceptance. A
temporary verified product session rendered `/agents` with HTTP 200 after fixing the SSR-only
`window.location` access in `KasiAiChat`; a local admin principal rendered `/dashboard` with HTTP
200. The temporary session was deleted after the check. Provider recovery, browser automation,
hosted deployment, seeded core fixtures, and isolated Redis replay remain explicit blockers.

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
- [x] Add negative tests for wrong organization, wrong realm, missing membership, wrong principal
  kind, revoked/suspended machine identity, and attempts to supply organization scope through an
  untrusted body or header. Core principal/realm and product-scope tests live in
  `identity/principal.rs`, `middleware/mod.rs`, and `db/social_models.rs`; workspace and booking
  fixtures cover missing membership and organization isolation; Agent HTTP/run integration tests
  cover cross-organization access plus revoked and suspended installations.

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
- [x] Add booking unit tests for normalization, validation, policy, status, overlap, and organization
  isolation plus database integration tests for transactional outcomes. `domains/bookings/transport.rs`
  and `domains/bookings/policy.rs` cover request normalization, boundaries, status transitions, and
  principal policy; `server/kasitek-core/scripts/test-bookings-db.sh` runs the disposable-local
  `tests/bookings_integration.sql` fixture, which passed against a cloned local schema and verifies
  organization-scoped reads, overlap exclusion for cancelled bookings, and cross-organization
  customer rejection inside a transactional rollback.
- [x] Add product-versus-internal booking parity tests proving both adapters invoke the same business
  behavior while preserving their distinct authentication and response envelopes. Evidence:
  `41778a7` centralizes request normalization and typed list envelopes in the shared bookings
  transport; product and delegated handlers call the same query boundary and serialize identical
  service/booking response contracts, with focused parity tests in `domains/bookings/transport.rs`.
- [x] Run existing workspace, customer, connection, and billing database suites to detect unrelated
  regressions caused by application-state or route restructuring. On 2026-08-14 the guarded
  disposable-local wrappers for workspace, customers, connections, and billing all passed against
  a newly migrated empty schema; the connection fixture seeds its projection rows inside a
  rollback transaction so the ownership/capability/consumer assertions are repeatable. The
  reusable `scripts/test-seeded-core-db.sh` fixture also runs the two previously ignored Core
  organization-ownership tests successfully against that clean schema. Redis replay recovery
  remains open in `BLOCKERS.md` B-008.
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

Local delegated-boundary evidence (2026-08-15): `server/kasitek-core/src/services/agent_platform.rs`
now has one transport contract test covering all 70 non-operator adapters across installation
lifecycle, capabilities and grants, operations, knowledge and memory, KasiAi/chat/channels, and
run controls. It asserts the exact method/path/query shape, organization and actor headers,
single-scope delegation claims, correlation binding, and write content types. Product mutation
ownership, public REST convergence, and live provider/effect verification remain open.

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
- [x] Test stream interruption followed by polling/reconciliation without false network errors or
  duplicate messages.
  Local resumable-stream evidence now uses `advanceSseCursor` in
  `agents/src/http/sse.ts`/`agents/src/http/app.ts`; `agents/test/sse.test.ts` proves malformed,
  duplicate, and out-of-order event rows cannot move a reconnect cursor backwards. The real HTTP
  stream has a local disconnect/reconnect regression in `agents/test/sse.integration.test.ts`; the
  same test polls `GET /v1/runs/:runId` after reconnect and verifies terminal status plus the
  original ordered events without duplication. The handler closes polling on request abort,
  socket/response close, or stream error. Full live
  provider recovery remains open.
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
- [x] Expose the same content capabilities to KasiAi tools, hosted agents, MCP, and REST without
  duplicating handlers. The protected KasiAi grant list and hosted runtime use the shared registry;
  MCP and public REST content-draft calls converge on the same invocation acceptance boundary, with
  shared argument/context assertions in `agents/test/content-capability-contract.test.ts` and
  `agents/test/http.test.ts`. Typed Agent-to-core routes remain covered by
  `agents/test/core-client.test.ts` and the core content adapter.
- [x] Add customer activity and content-operator investigation views for content actions and failures.
  Evidence: `GET /api/social/posts/{id}/activity` returns an organization-scoped, secret-safe
  durable timeline, and `client/apps/client/src/components/social/posts-workspace.tsx` now shows
  provider job status/error details with retry, run-now, and cancel recovery controls that refresh
  the activity projection after each action. Global KasiTek admin investigation remains a separate
  Slice 12 deliverable.

### Verification

- [x] Add contract tests for every content manifest and core handler. Evidence: `agents/test/content-capability-contract.test.ts` validates all eight content manifests, argument schemas, grant/approval gates, and redaction metadata; `agents/test/core-client.test.ts` covers every typed Agent-to-core content route; `server/kasitek-core/src/capabilities/content_adapter.rs` covers invalid publish/schedule and missing-idempotency guards without database access.
- [x] Add authorization/isolation tests across organizations, installations, connected accounts,
  platforms, and content ownership. Evidence: `server/kasitek-core/tests/social_content_integration.sql`
  now verifies workspace-member ownership, organization-matched primary accounts, platform-matched
  publish jobs, and cross-organization content visibility; `agents/test/hosted-agent-boundaries.integration.test.ts`
  covers installation/resource/connector isolation; and `agents/test/http.test.ts` plus
  `agents/test/run.integration.test.ts` cover installation-bound capability and approval scopes.
  The guarded social fixture passes against the cloned local schema and the full Agent PostgreSQL
  suite passes 58 files / 249 tests / 0 skipped.
- [x] Add idempotency, duplicate provider callback, delayed/out-of-order callback, partial batch,
  ambiguous outcome, reconciliation, and approval mutation tests. The rollback fixture
  `server/kasitek-core/tests/social_content_integration.sql`, executed by
  `server/kasitek-core/scripts/test-social-content-db.sh`, covers organization-scoped content,
  duplicate TikTok event-key insertion, terminal duplicate/late callback protection, usage
  idempotency, mixed partial-batch outcomes, and reconciliation of an ambiguous provider state.
  `agents/test/run.integration.test.ts` and `agents/test/http.test.ts` cover exact approval-field
  mutation rejection, concurrent approval decisions, changed-grant/installation rejection, and
  duplicate approval submissions. Provider sandbox execution remains a separate verification gate.
- [ ] Run database migrations, TypeScript/Rust suites, typechecks, lint/format, builds, and provider
  sandbox smoke tests for each configured social platform.

**Complete when:** one approved content action can travel end to end from any supported agent entry
point to the provider and back to a durable, auditable result with no duplicate effect.

## Slice 6 — Grounded KasiAi

**Layers covered:** 9, 10, and 11

### Deliverables

- [x] Replace generic product claims with reviewed, versioned KasiTek knowledge and remove all
  unsupported projects/resources/repositories guidance. The scoped content policy is pinned as
  knowledge corpus v2 in `agents/src/system/kasiai-knowledge.ts` with regression coverage in
  `agents/test/kasiai-knowledge.test.ts`.
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

- [x] Add MCP protocol, authentication, discovery filtering, cancellation, error, instance-isolation,
  stateless scaling, and Agent Platform adapter tests. Focused coverage now includes the Agent API
  and gateway HTTP matrices, protocol notifications/cancellation, structured errors, token claim
  ownership checks, MCP/REST acceptance parity, gateway replica behavior, and the stdio bridge
  (`8dfa645`, `187b427`, `773b250`, `1efd1bb`). The full local Agent suite now passes 59 files /
  255 tests with PostgreSQL and isolated Temporal, while real Codex/Claude/generic-client and hosted
  gateway proof remain separate unchecked gates.
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
  n8n, and external-client verification remains open. A source-derived local matrix in
  `agents/test/rest-mcp-conformance.test.ts` now inventories all 114 mounted Agent `/v1` operations
  and guards all 113 protected operations at the unauthenticated boundary, then asserts the
  zero-scope HMAC boundary, covers installation REST ownership,
  feature, scope, cursor, and audience failures, and checks the Core route table against all 21
  OpenAPI operations. This closes local route-drift and transport-boundary coverage only; it does
  not claim the unsupported issuer, resource-policy, hosted, or external-client gates.
- [x] Add focused installation REST tests for audience authentication, API scope enforcement,
  installation isolation, durable invocation/idempotency, operation inspection, and cancellation.
- [ ] Add behavior-parity tests proving equivalent MCP and REST operations converge on the same core
  domain command/query and compatible authorization, approval, idempotency, effect, receipt, and
  audit outcomes without requiring identical protocol envelopes. The local matrix now adds an
  approval-required `kasitek.core.content_post_publish` parity case and asserts matching run,
  approval, argument, installation, and idempotency outcomes across both adapters; hosted-domain,
  effect-receipt, audit, and external-client parity remain open.
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
  PostgreSQL + Temporal suite passed 58 files / 249 tests / 0 skipped.
- [x] Add tests proving hosted agents cannot escape declared capabilities, resources, connectors,
  budgets, concurrency, or approval policy. Evidence: `agents/test/hosted-agent-boundaries.integration.test.ts`
  now verifies organization-scoped installation/resource/connector grants and rejects a third active
  run beyond the published `maxConcurrentRuns` policy; `agents/test/installation-capability-invocation.test.ts`
  covers capability/resource/kill-switch gates; `agents/test/run.integration.test.ts` covers model
  request budgets and exact approval bindings; and `agents/test/runtime.test.ts` covers bounded
  tool-call and iteration limits. The focused hosted-boundary integration passes all four tests.
- [x] Run a complete template scenario from creation through test, publish, channel/connector use,
  approval, effect, activity, and rollback. Evidence: `agents/test/template-lifecycle.integration.test.ts`
  installs the real `lead-intake` template, grants and pairs a Telegram channel, persists inbound
  activity, drives a durable run through approval and exact effect-receipt consumption, records the
  provider receipt, delivers the outbound response, and publishes then rolls back a second version.
  The PostgreSQL-backed Agent run passes this scenario as part of 61 files / 257 tests with zero
  skips; provider sandbox credentials and browser authentication remain separate release gates.
- [x] Run Agent Platform/core/client suites, typechecks, lint/format, and production builds. Current
  verification: normal Agent suite 213 passed with 36 expected integration skips; the full
  PostgreSQL + Temporal matrix passed 249 tests with zero skips. Agent build and client
  typecheck/lint/production build pass, and `kasitek-core`
  format/check/unit suite is green (123 passed, 3 seeded/infrastructure ignores).

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

- [x] Add channel signature, replay, duplicate, ordering, reconnect, delivery retry, opt-out,
  attachment, handoff, and identity-mapping tests. Local evidence covers webhook signatures and
  attachment normalization (`server/kasitek-core/src/services/inbox.rs`,
  `agents/test/channel-adapters.test.ts`), WhatsApp opt-out keywords
  (`server/kasitek-core/src/services/whatsapp_webhooks.rs`), signed webhook replay protection
  (`agents/test/webhook-security.test.ts`), delivery retry/status ordering and pairing replay
  (`agents/test/channel.integration.test.ts`), external identity/thread mapping and duplicate
  delivery suppression (`agents/test/platform-chat.integration.test.ts`), handoff resumption
  (`agents/test/workflow-graph.test.ts`, `agents/test/http.test.ts`), and monotonic reconnect
  cursors plus durable polling (`agents/test/sse.test.ts`, `agents/test/sse.integration.test.ts`).
  The focused Agent channel suite passes 18 tests and the Core inbox/opt-out unit suites pass 25
  tests with one seeded-database ignore. Live provider reconnect and browser end-to-end matrix
  coverage remain open in the following unchecked item.
- [x] Add cross-user, cross-organization, cross-installation, cross-channel, and customer/thread
  isolation tests. Evidence: `agents/test/platform-chat.integration.test.ts` proves independent
  user-owned chats, external WhatsApp thread routing, duplicate provider-message suppression,
  owner binding revocation, and channel-specific delivery; `agents/test/channel.integration.test.ts`
  proves organization/installation/binding/conversation boundaries; and
  `agents/test/memory.integration.test.ts` proves installation and agent-private memory/knowledge
  isolation. The full PostgreSQL + Temporal Agent suite passes 58 files / 249 tests / 0 skipped.
- [x] Add summary window, memory scope, provenance, consent, deletion, export, poisoning, and prompt
  injection tests/evaluations. Evidence: rolling summary bounds and scoped memory/knowledge
  isolation are covered by `agents/test/memory.integration.test.ts`; grounding metadata and
  untrusted summary/long-term-memory/UI boundaries are covered by
  `agents/test/grounding-provenance.test.ts` and `agents/test/context.test.ts`; channel consent/
  opt-out and export-request paths remain covered by
  `server/kasitek-core/src/services/whatsapp_webhooks.rs` and
  `agents/test/operator-commands.integration.test.ts`;
  deletion/expiry/quarantine behavior is asserted by the memory integration suite and
  `agents/test/memory-poisoning.test.ts`.
- [ ] Run browser plus configured WhatsApp/Telegram/Discord end-to-end scenarios, service tests,
  typechecks, and builds.

**Slice 9 evidence (2026-08-14):** `MemoryRepository` deletion and revalidation now enforce
namespace-specific installation, conversation, and user ownership; `KnowledgeRepository` source
lookup, ingestion, listing, and deletion now enforce agent/installation scope; and channel delivery
attempt creation verifies the message's organization and conversation before inserting a retry. The
new cross-scope regressions live in `agents/test/memory.integration.test.ts` and
`agents/test/channel.integration.test.ts`. The full PostgreSQL + Temporal suite passed 58 files /
249 tests / 0 skipped. Browser/provider scenarios, opt-out, reconnect, and the complete channel
matrix remain open.

**Complete when:** every supported channel reaches the same durable agent runtime while identity,
conversation history, delivery, knowledge, and memory remain correctly scoped and recoverable.

**Slice 10 evidence (2026-08-14):** Enabled content effects now capture an explicit, bounded
operation preview alongside the immutable content-post projection: publish includes its target
platform, schedule includes its requested time, unschedule includes the reviewed scheduled time,
and delete records the reviewed-to-deleted transition. The shared domain preview adapter now also
projects channel send/reply steps, campaign transitions, booking transitions, destructive actions,
and future-domain requests while omitting provider credentials and recipient secrets; campaign and
booking resources are loaded through organization-scoped Core reads. Channel replies persist the
preview on their durable delivery step. `agents/test/approval-preview.test.ts` and
`agents/test/core-client.test.ts` cover the bounded projections and fail-closed resource reads.
Real campaign/booking write handlers remain disabled until their provider boundaries are enabled.

## Slice 10 — Approvals, effects, and operational recovery

**Layers covered:** 5, 8, and 12

### Deliverables

- [x] Bind each approval to organization, installation, capability/version, normalized argument hash,
  resources, immutable preview revision, approver, expiry, and one permitted effect.
- [x] Implement authenticated web approval, denial, cancellation, expiration, execution-time
  reauthorization, polling/wait/webhook status, and structured `APPROVAL_REQUIRED` responses.
- [x] Implement domain previews for publishing, sending/replying, campaigns, bookings, destructive
  actions, and later domains before enabling their real effects. Evidence: content approval
  projections, the shared `agents/src/approval/domain-preview.ts` adapter, organization-scoped
  campaign/booking Core reads, and durable channel-delivery step previews; campaign/booking write
  handlers remain disabled until provider boundaries are enabled.
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

- [x] Add approval hash/version/resource/expiry/single-use, self-approval, changed-permission,
  cancellation, and concurrent-decision tests. Evidence: `agents/test/run.integration.test.ts`
  exercises exact approval hashes, capability versions, resource/preview/policy revisions,
  expiry, atomic consume-once behavior, changed approval fields, ambiguous effect recovery, and
  concurrent decisions; `agents/test/http.test.ts` covers self-approval, revoked grants,
  cancellation, approval idempotency, and authorization boundaries.
- [x] Add effect idempotency, crash-after-provider-call, timeout, duplicate callback, reconciliation,
  compensation, and kill-switch tests.
- [x] Run end-to-end approved and denied actions from KasiAi, hosted agent, MCP, REST, and a channel.
  Evidence: `agents/test/entrypoint-approval-matrix.test.ts` drives both decisions through the
  actual Fastify MCP, installation REST, KasiAi platform-message, and channel-ingress adapters,
  invokes the hosted acceptance boundary, then exercises the shared approval route and real
  `ToolRegistry` effect gate. Ten operations (approved and rejected for each source) produce ten
  approval decisions, five `markNotExecuted` denials, five effect-handler executions, and no
  denied effect crosses `beforeEffect`. Provider sandbox execution and authenticated external
  clients remain separate release gates.
- [x] Run all service tests, database/Temporal recovery tests, typechecks, and builds. Evidence:
  the isolated PostgreSQL + Temporal Agent matrix passes 61 files / 257 tests / 0 skips; Agent
  `pnpm build`, Core `cargo fmt --check`, `cargo check -p kasitek-core`, and `cargo test -p
  kasitek-core --lib` pass (132 tests, 3 explicitly ignored infrastructure gates); client lint
  passes with 0 errors and 9 warnings, client typecheck passes, and `pnpm build:client` completes
  successfully. The remaining Redis/seeded/provider/browser gates stay explicitly open elsewhere.

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

- [x] Define operator roles/permissions, data classifications, redaction rules, support-access
  grants, dual-control actions, emergency access, and prohibited operations. Evidence:
  `server/kasitek-core/src/services/admin_policy.rs` defines the classification, allow-list, and
  emergency-role policy; `services/admin_support_access.rs` enforces bounded grants and immutable
  grant/revoke audit events; operator commands retain dual-control and kill-switch enforcement.
- [x] Implement a protected core operator API and short-lived signed core-to-agents operator
  delegation; never allow the admin browser to query Agent storage or Temporal directly. Evidence:
  `server/kasitek-core/src/controllers/admin_operations.rs` authenticates the admin role before
  delegating through short-lived scoped tokens in `services/agent_platform.rs`; the admin UI uses
  only the `/api/operations` core proxy, and Agent operator routes reject non-platform principals.
- [x] Build rebuildable read models for agent health, runs/events, usage/cost, deliveries/webhooks,
  providers/workers, alerts, and projection lag. Evidence: migration
  `agents/migrations/038_operator_projections.sql` persists versioned safe projections; the Agent
  projection service rebuilds all eight keys with monotonic revisions, and its PostgreSQL-backed
  integration test verifies rebuild/read/notification acknowledgement behavior.
- [x] Implement global search and investigation across organization/workspace, user, agent,
  installation, conversation, run, approval, effect, delivery, provider message, and correlation IDs.
  Evidence: the protected Agent operator search covers each safe identifier projection, escapes
  wildcard input, and returns only kind/id/organization/state/resource/timestamp fields; the
  PostgreSQL integration test exercises organization, workspace, user, agent, installation,
  conversation, run, delivery, message, and audit results without payload leakage.
- [x] Build admin Operations pages for overview, organizations, agents/installations, runs/workflows,
  conversations/channels, approvals/effects, providers/connectors, queues/workers, usage/cost,
  alerts/incidents, audit/security, support access, and controls. Evidence: the protected
  Operations page now renders each area from the core proxy using redacted summary, run-health,
  delivery, provider/worker, usage, projection-lag, notification, support-grant, and audit data;
  no browser route queries Agent storage or Temporal directly.
- [x] Implement idempotent, version-checked, audited commands for retry, cancel, reconcile, assign,
  suspend/resume, credential revoke, safe webhook replay, scoped pause, export/deletion workflow
  requests, and hierarchical kill switches. Evidence: Agent migrations `039`–`043`, the Core
  webhook replay ledger, the protected Operations proxy, and the PostgreSQL operator lifecycle
  integration cover dual-control, idempotency, expected state/resource checks, redacted audit, and
  durable request/status projections.
- [x] Enforce expected organization, installation, conversation, run, agent, and lifecycle identity
  on the completed operator command families; stale or cross-organization approvals fail closed.
  Evidence: `agents/src/http/operator-commands.ts`, protected Operations controls, and the operator
  integration tests for stale status, stale organization, and cross-organization export rejection.
- [x] Implement feature flags and incident holds with explicit expiry, scope policy, and runtime
  consumers. Evidence: Agent migration `044_operator_feature_flags_holds.sql` persists scoped,
  expiring feature flags and organization/installation/run holds; dual-control operator commands
  validate scope, ownership, expiry, and expected state; Agent run creation, MCP/REST entrypoints,
  Temporal execution, external effects, and channel delivery enforce the current policy; the
  protected Operations page exposes redacted reads and release/set controls.
- [x] Require time-limited audited support access for customer content; never reveal secrets, raw
  tokens, hidden prompts, or unrestricted customer data. Evidence: core support grants are scoped
  to organization/conversation/customer/run, expire within 60 minutes, can be revoked, emit audit
  events, and are required by admin conversation list/read routes; projection fields are explicitly
  allow-listed and secret/content fields are prohibited.
- [x] Add operator notifications and runbooks for provider outage, queue backlog, stuck run,
  duplicate effect, webhook storm, model outage, credential compromise, and data access incidents.
  Evidence: alert projections generate deduplicated safe notifications for all eight local incident
  categories; the Operations UI labels each notification with its response runbook and exposes
  the redaction-aware runbook guidance for operators.

### Verification

- [x] Add role, resource-scope, redaction, support-grant, expiry, dual-control, command idempotency,
  delegation, and immutable audit tests. Core now has a complete seven-role grant/content/command/
  support/emergency matrix, an allowlist-versus-prohibited-field assertion, and exhaustive support
  grant scope/expiry boundary cases. Agent operator tests cover every dual-control command and
  secret-safe projections; the seeded retention integration proves append-only audit UPDATE/DELETE
  rejection.
- [x] Add integration tests for core-to-agents operator reads/commands and projection rebuild/lag.
  Evidence: `server/kasitek-core/src/services/agent_platform.rs` now exercises every operator
  read, command, projection, search, retention, and error path against a local HTTP boundary,
  asserting platform scope, operator claims, correlation propagation, query encoding, command
  bodies, and idempotency headers. `agents/test/operator-projections.integration.test.ts` verifies
  monotonic rebuild revisions, notification acknowledgement, and a 90-second stale projection
  appears in the lag projection. The full PostgreSQL + Temporal Agent matrix passes 255/255.
- [ ] Add end-to-end admin tests for viewer, support, operator, security, admin, and owner roles.
- [x] Test organization isolation, secret absence, stale/degraded dependencies, retry/replay,
  cancellation, reconciliation, suspension, and every kill-switch level. The full seeded Agent
  matrix covers cross-organization export/replay rejection, redacted audit/recovery projections,
  stale projection lag, terminal-run retry, delivery replay, cancellation, effect reconciliation,
  installation suspension/resume, organization/global/agent kill switches, and legal-hold recovery.
- [ ] Run core/Agent/admin tests, typechecks, lint/format, builds, and an internal incident drill.

**Complete when:** an authorized KasiTek operator can trace organization → installation → run →
model/tool → approval → effect → delivery and perform only safe, attributable, auditable recovery.

**Slice 12 foundation evidence (2026-08-14):** Admin sessions now reach a protected core-only
operator boundary. Core issues a short-lived operator-scoped internal token to safe Agent global
projections for summary, runs, health, reconciliation, audit, and identifier search; the Agent
surface rejects non-platform or non-operator principals. Core now has an explicit viewer/support/
operator/security/admin/superadmin/owner grant matrix and separates customer-content access from
mutating operator commands. The admin Operations page consumes only the core proxy and deliberately
exposes no customer content, prompts, secrets, or provider receipts. Migration
`agents/migrations/037_operator_commands.sql` now persists bounded operator commands with global
idempotency keys, immutable request/execution audit records, one-operator cancellation, and
two-operator reconciliation/kill-switch approval. The core proxy forwards idempotency keys, command
inspection uses a read-only delegation scope, and the reconciliation UI requires an explicit outcome
before requesting a second approval. Focused command tests and the PostgreSQL-backed lifecycle test
pass; the full Agent suite passes 54 files / 216 tests / 0 skips with local PostgreSQL and Temporal.
**Slice 12 implementation evidence (2026-08-14):** The admin chunk now includes durable support
grants and audit tables in both the client database schema and core SQL inventory, active-grant
enforcement on customer conversation reads, eight persisted Agent operator projections, expanded
operator search over the Agent investigation entities, deduplicated alert notifications, and an
admin Operations UI for projection rebuilds, support access, search, incident notifications, and
the full safe read-model/audit surface. Migration `agents/migrations/039_operator_lifecycle_commands.sql`
extends the audited command constraint for installation, credential, and schedule lifecycle actions;
dual-control integration tests cover each action and verify the resulting state transitions.
Runbooks cover the provider/model, queue/stuck-run, duplicate-effect, credential/data-access, and
delivery-storm response paths. Migration `agents/migrations/040_operator_recovery_commands.sql`
adds dual-control `retry_run` and safe `replay_delivery` commands; terminal-run retry dispatches a
new durable run with command-bound idempotency, while delivery replay locks the message, rejects
sent/superseded attempts, requires explicit confirmation for unknown outcomes, and supports an
expected-state guard so stale operator requests fail closed. The Operations UI now exposes
terminal-run retry and redacted failed-delivery replay controls. Verification passes the
full Agent suite (54 files / 216 tests / 0 skips with local PostgreSQL and Temporal), core library tests (110 passed / 3 infrastructure tests
ignored), Prisma validation/migrations, and the admin lint/typecheck/build. Migration
`agents/migrations/041_operator_memory_deletion.sql` adds a dual-control `delete_memory` command
over the existing organization/install-scoped memory deletion job; operator search exposes only the
memory identifier and lifecycle state, with the deletion action hidden from read-only roles. Full
cross-role E2E, external hosted checks, and the remaining broad version/resource verification matrix
remain open; the local assign, safe webhook replay, feature-flag, hold, and export command families
are implemented and covered by focused integration evidence.

**Core webhook replay evidence (2026-08-14):** Core now owns a separate durable
`AdminWebhookReplayCommand` ledger and `AdminWebhookReplayAuditEvent` table for public API webhook
deliveries. The protected Operations routes list only failed deliveries with redacted identifiers,
create idempotent replay requests, and require a distinct second operator. Approval locks the command
and delivery rows, checks the expected `FAILED` status and attempt count plus an active subscription,
then clears the prior error and queues the delivery as `PENDING`; stale, deleted, inactive, or already
changed deliveries fail closed. The core Operations UI exposes this recovery control without payloads,
URLs, secrets, or provider response data. Prisma migration
`20260814180000_add_admin_webhook_replay` and the core SQL inventory are applied locally; core unit
tests (112 passed / 3 infrastructure tests ignored), Prisma validation, and admin lint/typecheck pass.
The admin control surface now includes scoped, expiring feature flags and incident holds in addition
to assignment, export workflow, and resource/version guards; the evidence is recorded below.

The Agent admin command surface now also includes `assign_run`: migration
`agents/migrations/042_operator_run_assignments.sql` persists the current assignee and revision per
run, the command locks the run row, checks the expected lifecycle state, upserts the assignment, and
records only safe run/assignee/revision metadata. The Operations page exposes the dual-control
“Assign to me” action. Assignment integration and migration tests pass.

**Admin command guard and export evidence (2026-08-14):** Existing Agent operator mutations now
accept optional expected organization, installation, conversation, run, agent, and lifecycle values;
execution compares those values inside the target lookup/lock and fails closed with a conflict when
the resource moved or changed. The Operations controls pass the identities from the protected Core
projection, and the integration suite covers stale status and cross-organization rejection. Migration
`agents/migrations/043_operator_export_requests.sql` adds a durable, dual-control export-request queue
with organization/resource scope validation, redacted audit evidence, and a read-only Agent/Core
proxy. The Operations page can queue a run-scoped export request and shows its durable status without
claiming that an artifact has been generated.

**Feature-flag and incident-hold evidence (2026-08-14):** Migration `044` adds durable, expiring
global/organization/installation feature flags and organization/installation/run execution,
effects, and delivery holds. Commands are dual-controlled, idempotent, audited, and resource-bound;
the runtime checks flag precedence and active holds before run creation, MCP/REST access, Temporal
model/tool work, external effects, and channel delivery. The protected Operations page exposes
redacted flag/hold projections and set/create/release controls. Focused migration and command tests,
the PostgreSQL operator lifecycle integration (3/3), Agent typecheck/full suite, admin lint and
typecheck, and `cargo check -p kasitek-core` pass.

**Health and lifecycle evidence (2026-08-14):** The protected Agent operator projection now builds a
dependency matrix covering authentication, installation credentials, API policy gates, model
providers, Temporal, queues/workers, PostgreSQL, Redis replay posture, tools, provider effects,
webhooks/delivery, approvals, cost attribution, edge rate limits, and suspicious access. Degraded
checks emit deduplicated redacted operator notifications, and the admin Operations page renders the
matrix with safe counts and response detail. A companion `retention` projection reports allow-listed
audit/events/messages/runs/memory/attachment age and lifecycle counts, deletion jobs, export request
states, and active incident holds; it deliberately excludes content, secrets, and generated export
artifacts. Agent typecheck, full unit suite, PostgreSQL projection integration, admin typecheck,
lint, and production build pass. Temporal heartbeat, Redis cross-instance replay, backup/restore,
and legal-hold execution remain explicit external release gates rather than being represented as
ready by the local projection.

**Retention control evidence (2026-08-15):** Migration `045_retention_legal_holds.sql` adds
organization-scoped retention policy rows and installation/conversation/organization legal holds.
`RetentionRepository` provides bounded policy writes, safe redacted previews, hold-aware memory
expiry, and queued deletion jobs; `applyMemoryRetention` now reports the number of eligible records
skipped by active, unexpired legal holds instead of silently returning zero. The PostgreSQL retention
integration asserts both the hold-protected preview and the `{ expired: 0, skippedByHold: 1 }`
execution result. Migration `046_immutable_audit_records.sql` now enforces append-only audit rows at
the database trigger boundary; the same PostgreSQL integration rejects both UPDATE and DELETE
attempts. The operator command boundary requires dual approval and records audit metadata for policy
changes, retention application, and hold create/release. Agent and Core operator routes plus the
Operations page expose only policy/count/state projections and provide controls for policy updates,
retention application, and legal-hold release. Backup/restore execution and periodic external
access-review evidence remain release gates, so the broad Slice 13 retention checkbox stays open.

**Operator boundary regression evidence (2026-08-15):** Core support-access validation now has
explicit regression coverage for unknown resource types, bounded reasons, and the distinction between
organization-wide grants and narrow run/conversation/customer grants. Migration and integration tests
also prove that audit rows cannot be updated or deleted after insertion. `cargo test -p kasitek-core
--lib` passes 127 tests with three infrastructure-gated ignores; the full Agent PostgreSQL + Temporal
matrix passes 58 files / 249 tests / 0 skips. These tests strengthen the local Slice 12 boundary but
do not replace the still-open role/resource policy, core-to-Agent operator E2E, browser, provider, or
hosted verification gates.

**Local capability expansion evidence (2026-08-14):** Commits `720a47c`, `81d0284`, `3b26830`,
`1b2eee9`, `d422444`, and `0631818` extend the organization-scoped Agent/Core boundary with aggregate workspace
reporting, bounded contacts/templates/bookings/campaigns/inbox projections, approval-gated
idempotent contact updates, conversation starring, provider-backed mark-read, and approved
WhatsApp channel delivery. Each capability is registered once and projects into the generated
Agent/MCP/permission/audit documentation; Core routes require the delegated capability and
organization scope. The full local verification passes with `cd agents && pnpm test` (58 files,
213 passed, 36 expected integration skips), Agent typecheck, `cd server && cargo fmt` plus
`cargo test -p kasitek-core --lib` (125 passed, 3 infrastructure-gated ignores), and Core check.
Seeded database, Redis replay, provider sandbox, hosted, browser, and external-client gates remain
open and are not represented as complete by this local evidence.

## Slice 13 — Security, observability, expansion, and production release

**Layers covered:** 12, 13, and 14

### Deliverables

- [x] Emit immutable redacted audit events and separate operational traces, metrics, and diagnostic
  logs with stable correlation across edge, Agent Platform, Temporal, core, and providers.
- [x] Attribute tokens/cost, tools, effects, connectors, channels, storage, schedules, failures,
  latency, and concurrency to organization, installation, definition/version, and credential.
- [x] Implement health dashboards and alerts for auth, credentials, APIs, model providers, Temporal,
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
- [x] Relevant migrations apply from a clean database and from the supported previous schema.
  Evidence: `client/packages/database/prisma/migrations/20260301000000_initial_client_schema`
  captures the pre-incremental schema at `f964059^`; all 50 current Prisma migrations applied
  successfully to a newly-created disposable local PostgreSQL database on 2026-08-14. Existing
  databases require the documented one-time baseline resolve after schema review.
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
