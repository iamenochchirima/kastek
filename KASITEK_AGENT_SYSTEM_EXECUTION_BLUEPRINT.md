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

All three use the same installation identity, capability policy, run records, approvals, audit,
and core business boundary. KasiAi does not receive a private shortcut into `kasitek-core`.

Hosted agents may call both KasiTek capabilities and separately granted external connectors.
External agents call KasiTek through the public REST API or MCP server using installation
credentials; they do not need a logged-in human session.

### Service boundary

```text
Browser / channel / hosted agent / external MCP or REST client
                              |
                              v
                    Agent Platform service
        identity · policy · runtime · memory · audit · approvals
                              |
                              v
                     Capability Gateway
                              |
                 short-lived signed delegation
                              |
                              v
                        kasitek-core
         final authorization · business state · provider effects
```

Temporal owns durable execution, retries, waiting, schedules, and recovery. PostgreSQL owns durable
agent records. Redis may support realtime delivery and caching but is not a source of truth.

### The 14 agreed architecture layers

| Layer | Settled direction |
| --- | --- |
| 1. Product and installation | Versioned definitions installed into a workspace; each installation has a non-human principal and one of the three execution modes. |
| 2. Identity and credentials | Multiple named copy-once secrets, hashed at rest, exchanged for one-hour audience-bound tokens; immediate suspend/revoke checks; public-key assertions before broad production. |
| 3. Permissions and resources | Effective authority is the intersection of grants, credential restrictions, workspace/resource scope, availability, approval, and limits. Controlled testing uses an explicit broad-access profile with hard exclusions. |
| 4. Capability catalog | One versioned JSON-Schema manifest registry generates internal tools, MCP, REST/OpenAPI, UI metadata, documentation, audit descriptions, and future SDK types. |
| 5. Action safety | Reads and drafts may run directly; real external effects require exact, single-use approvals initially. Mutations require idempotency, receipts, reconciliation, and execution-time authorization. |
| 6. Core boundary | Core owns product data, business authorization, transactional effects, and provider idempotency. Agent Platform uses short-lived asymmetric per-invocation delegation. |
| 7. MCP and REST | MCP is hosted at `agents.kasitek.co.za/mcp`; public REST uses `api.kasitek.co.za/v1/*`. Both adapt the same capability handlers. |
| 8. Runtime durability | One AgentRun model across all entry points; Temporal handles durable work, retries, approvals, schedules, cancellation, and recovery with bounded concurrency. |
| 9. Conversations and channels | Personal conversations are user-owned; business conversations are customer/thread-owned. Channel adapters are thin and never silently merge unrelated chats. |
| 10. Context and memory | Reviewed product knowledge, bounded recent history plus summaries, scoped memory namespaces, provenance, consent, deletion, and strict trusted/untrusted boundaries. |
| 11. Product experience | One Agents area for KasiAi, hosted agents, external connections, templates, activity, approvals, usage, credentials, channels, and settings. |
| 12. Observability and governance | Immutable audit, separate traces/logs/metrics, usage attribution, alerts, redaction, support access, exports, and hierarchical kill switches. |
| 13. Security | Isolation, replay defense, confused-deputy prevention, prompt/tool injection controls, secret minimization, webhook/SSRF defenses, rate limits, scans, and incident response. |
| 14. Rollout | Separate environments, seeded testing, feature flags, release gates, rollback drills, real-client compatibility tests, and progressive read → draft → sandbox effect → real effect enablement. |

### Initial delivery choices

- Content/social is the first complete capability domain.
- Contacts/inbox, bookings, campaigns, automations/agent administration, and reporting follow using
  the same contracts.
- Controlled test workspaces behave as fully entitled while usage is still measured from day one.
- Real external effects always use approval during initial testing.
- Hosted agent creation starts with guided forms and templates. The visual workflow builder is a
  later phase on the same durable graph model.
- OpenRouter is the initial default model route; provider-neutral OpenAI, Anthropic, and Gemini
  adapters remain part of the shared model gateway.
- KasiTek internal administration is implemented in `client/apps/admin` through a protected core
  operator API; the browser never accesses Agent Platform storage or Temporal directly.

## 3. Working rules

- Work through the slices in order unless a task is explicitly independent.
- Do not create a second implementation for MCP, REST, KasiAi, or a channel. Extend the shared
  contracts and runtime.
- Do not mark a checkbox complete based only on code presence. Run the required verification.
- Every database change needs a migration, rollback/recovery consideration, and migration test.
- Every public or internal API change needs typed contracts and authorization tests.
- Every external effect needs idempotency, durable status, audit, and ambiguous-outcome recovery.
- Preserve unrelated worktree changes and make coherent commits after verified slices.
- Record genuine deferrals explicitly; do not silently omit a required end-to-end layer.

## 4. Implementation order and checklist

## Slice 0 — Reconcile the existing implementation

**Layers covered:** all layers as baseline inventory

### Deliverables

- [ ] Map existing migrations, models, APIs, Temporal workflows, tool registry, model gateway,
  conversations, memory, channels, KasiAi UI, Agents UI, and admin endpoints to this blueprint.
- [ ] Record implemented, partial, missing, and obsolete paths without treating old placeholders as
  completed architecture.
- [ ] Confirm legacy `/api/bots` and old provisioning paths remain absent and no fallback or
  dual-write path is active.
- [ ] Confirm local development starts the core, client, Agent API, Temporal worker, databases, and
  required realtime services with documented health checks.
- [ ] Create or update ADRs for any settled architecture decision not represented in code/docs.
- [ ] Establish a short evidence format for completed slices: migration/API/test/command/commit.

### Verification

- [ ] Run the existing Agent Platform unit and database suites.
- [ ] Run Agent Platform typecheck/build, `kasitek-core` formatting/check/tests, and client/admin
  lint/typecheck/build baselines.
- [ ] Run local authenticated KasiAi and Agents health smoke tests and record genuine failures.

**Complete when:** the team has a verified baseline, every remaining item maps to this blueprint,
and agents can implement without relying on a superseded checklist.

## Slice 1 — Shared contracts, installations, and identity

**Layers covered:** 1, 2, 3, and 4

### Deliverables

- [ ] Define shared types for execution modes, definition/version/installation lifecycle,
  `AgentPrincipal`, actor attribution, resource selectors, grants, limits, and availability.
- [ ] Implement migrations and repositories for principals, named credentials, installation grants,
  resource constraints, connector grants, limits, and usage attribution.
- [ ] Implement installation create/read/update/archive and suspend/resume/revoke APIs with strict
  organization ownership and protected KasiAi rules.
- [ ] Implement copy-once installation secrets stored only as hashes, credential listing metadata,
  rotation, revocation, expiry, and last-use tracking.
- [ ] Implement token exchange for short-lived audience-bound access tokens and enforce current
  credential, installation, organization, scope, and resource status on every request.
- [ ] Implement `development_full_access` for controlled test workspaces with immutable exclusions
  for secrets, billing mutation, organization privilege, workspace deletion, and policy bypass.
- [ ] Expose installation lifecycle, credential metadata, grants, usage, and health to customer and
  operator read models without exposing secret material.
- [ ] Add public-key client assertion support before production external-agent release.

### Verification

- [ ] Add migration/repository tests for installation ownership, lifecycle, credentials, grants,
  resource constraints, and usage records.
- [ ] Add auth tests for token exchange, expiry, narrowing, replay, rotation, revocation, suspended
  installations, wrong audience, and cross-organization access.
- [ ] Run Agent Platform tests, database integration tests, typecheck, and build.
- [ ] Smoke-test a named test credential obtaining a token and losing access immediately after
  revocation.

**Complete when:** each agent installation has an independent non-human identity and can be safely
authenticated, scoped, audited, suspended, and revoked without a human browser session.

## Slice 2 — Capability registry and core authorization boundary

**Layers covered:** 3, 4, and 6

### Deliverables

- [ ] Make one versioned `CapabilityManifest` registry authoritative for schemas, scopes, resources,
  risk, approval policy, idempotency, availability, errors, receipts, and redaction metadata.
- [ ] Define common invocation, result, error, pagination, batch-result, and effect-receipt envelopes.
- [ ] Generate or validate internal tool definitions, MCP tools, REST/OpenAPI operations, UI
  permission metadata, audit descriptions, and documentation from the same manifests.
- [ ] Implement central policy evaluation using installation grants, credential restrictions,
  resource scope, availability, approval, and limits with structured denial reasons.
- [ ] Implement filtered capability discovery for the authenticated installation.
- [ ] Replace static internal core authentication with one-to-two-minute ES256 per-invocation
  delegation, JWKS publication/rotation, audience checks, and replay protection.
- [ ] Add typed internal core handlers that independently validate organization, agent principal,
  capability/version, resources, user/approval authority, and business preconditions.
- [ ] Ensure core owns business mutations, transactional outbox/action records, provider
  idempotency, effect receipts, and signed lifecycle events back to Agent Platform.

### Verification

- [ ] Add manifest schema/version/compatibility and generated-surface parity tests.
- [ ] Add policy matrix tests covering allowed, narrowed, denied, unavailable, approval-required,
  rate-limited, and cross-resource invocations.
- [ ] Add delegation signature, issuer, audience, expiry, replay, rotation, and confused-deputy tests.
- [ ] Contract-test each initial core handler against its manifest and error/receipt schema.
- [ ] Run TypeScript and Rust unit/integration suites, typecheck, formatting, and builds.

**Complete when:** every entry point reaches product operations through the same manifest, policy,
delegation, and typed core handler with no direct database or special-agent bypass.

## Slice 3 — Durable runtime, model gateway, and run lifecycle

**Layers covered:** 5 and 8

### Deliverables

- [ ] Use one AgentRun, attempt, ordered-event, tool-call, model-call, approval, and effect model for
  browser, channels, hosted agents, MCP, REST, schedules, and webhooks.
- [ ] Route model work, multi-step workflows, waits, approvals, schedules, provider effects,
  polling, and recovery through Temporal with stable idempotency-derived workflow IDs.
- [ ] Enforce per-conversation, installation, provider, recipient, and effect concurrency rules.
- [ ] Implement bounded retries, timeouts, cancellation, terminal state, needs-attention state,
  dead-letter/recovery behavior, and safe stream-disconnect polling.
- [ ] Keep OpenRouter, OpenAI, Anthropic, and Gemini behind a provider-neutral model gateway with
  model discovery, credentials isolated to activities, fallback policy, usage, latency, and cost.
- [ ] Keep attachments/media in object storage through ownership-checked references, hashes, MIME
  validation, scanning state, expiry, and retention.
- [ ] Persist safe run activity before broadcasting it to realtime clients.

### Verification

- [ ] Add workflow tests for idempotent start, duplicate send, concurrent send, retries, timeout,
  cancellation, worker restart, approval wait, and effect recovery.
- [ ] Add model gateway contract tests for each configured provider, fallback, errors, metering, and
  secret redaction.
- [ ] Test stream interruption followed by polling/reconciliation without false network errors or
  duplicate messages.
- [ ] Run Agent Platform tests, Temporal tests, typecheck/build, and at least one configured live
  provider smoke test.

**Complete when:** a run survives process/connection failures without losing state, duplicating
effects, leaking credentials, or leaving the UI unable to determine its true status.

## Slice 4 — First complete capability domain: content and social

**Layers covered:** 4, 5, 6, 8, and 12

### Deliverables

- [ ] Implement manifests and typed core handlers for connection discovery/health, content listing,
  content detail, drafts, updates, publish status, scheduling, unscheduling, publishing, and delete
  or archive behavior supported by the product.
- [ ] Apply organization, connected-account, platform, ownership, capability, and resource checks to
  every handler.
- [ ] Implement draft operations as immediate safe writes and real publish/schedule effects through
  immutable preview, approval, idempotent core action/outbox, provider receipt, and reconciliation.
- [ ] Return platform capability differences and partial batch results explicitly rather than
  claiming unsupported behavior.
- [ ] Record run, tool, approval, effect, provider, delivery, usage, and audit events with shared IDs.
- [ ] Expose the same content capabilities to KasiAi tools, hosted agents, MCP, and REST without
  duplicating handlers.
- [ ] Add customer activity and operator investigation views for content actions and failures.

### Verification

- [ ] Add contract tests for every content manifest and core handler.
- [ ] Add authorization/isolation tests across organizations, installations, connected accounts,
  platforms, and content ownership.
- [ ] Add idempotency, duplicate provider callback, delayed/out-of-order callback, partial batch,
  ambiguous outcome, reconciliation, and approval mutation tests.
- [ ] Run database migrations, TypeScript/Rust suites, typechecks, lint/format, builds, and provider
  sandbox smoke tests for each configured social platform.

**Complete when:** one approved content action can travel end to end from any supported agent entry
point to the provider and back to a durable, auditable result with no duplicate effect.

## Slice 5 — Grounded KasiAi

**Layers covered:** 9, 10, and 11

### Deliverables

- [ ] Replace generic product claims with reviewed, versioned KasiTek knowledge and remove all
  unsupported projects/resources/repositories guidance.
- [ ] Build minimal dynamic context from the authenticated user, organization, enabled modules,
  route/entity, current conversation, and currently available capabilities.
- [ ] Grant KasiAi real read, draft, and approved action capabilities only through the shared
  Capability Gateway.
- [ ] Make answers distinguish tool-derived facts, reviewed product knowledge, unavailable actions,
  and uncertain information; never claim a tool or data source that was not used.
- [ ] Preserve independent user-owned conversations, explicit browser conversation IDs, durable
  history, summaries, model selection, chat naming, new-chat behavior, and channel defaults.
- [ ] Show tool activity, approval previews, results, errors, retries, and final run status clearly in
  the KasiAi workspace without exposing hidden reasoning.
- [ ] Provide relevant starter suggestions and page help derived from real available capabilities.
- [ ] Expose KasiAi health, rollout version, failure class, and usage in the operator console.

### Verification

- [ ] Add deterministic and adversarial evaluations for grounded answers, unsupported claims,
  correct tool choice, authorization denials, injection attempts, and safe failure language.
- [ ] Add conversation isolation, new-chat, deep-link, refresh, concurrent-send, idempotency,
  channel-default, archive/delete, and model-preference tests.
- [ ] Add client component/accessibility and sidebar send/history/reconnect/cancel tests.
- [ ] Run Agent Platform/core/client tests, typechecks, lint/format, production builds, and an
  authenticated browser smoke test using real workspace data.

**Complete when:** KasiAi accurately describes and operates the implemented KasiTek product using
real capabilities, preserves independent chats, and never invents platform features or results.

## Slice 6 — External agents through MCP and REST

**Layers covered:** 2, 3, 4, and 7

### Deliverables

- [ ] Implement remote MCP Streamable HTTP initialization, negotiation, `tools/list`, `tools/call`,
  structured results/errors, cancellation, and filtered discovery over the Capability Gateway.
- [ ] Publish versioned public REST under `api.kasitek.co.za/v1/*` with typed domain endpoints and an
  advanced generic invocation route backed by the same handlers.
- [ ] Publish OpenAPI 3.1 and agent-readable integration documentation generated from or validated
  against the capability registry.
- [ ] Use the installation token exchange for both MCP and REST and publish compatible protected
  resource/auth discovery metadata.
- [ ] Implement signed outbound webhooks with subscription scope, delivery records, exponential
  retry, replay protection, disable/re-enable policy, and diagnostics.
- [ ] Add an external-agent connection wizard with named credentials, copy-once setup, grants,
  resource scope, health diagnostics, rotation/revocation, examples, and audit activity.
- [ ] Add a local stdio bridge only for clients that cannot connect to hosted Streamable HTTP.

### Verification

- [ ] Add MCP protocol, authentication, discovery filtering, cancellation, error, and parity tests.
- [ ] Add REST/OpenAPI conformance, auth, pagination, idempotency, webhook signature/retry, and parity
  tests proving MCP and REST invoke the same manifest versions and handlers.
- [ ] Verify real Codex, Claude Code, and one generic MCP client.
- [ ] Verify n8n and one plain TypeScript or Python REST client.
- [ ] Run typechecks, lint, builds, security checks, and externally hosted smoke tests.

**Complete when:** an external runtime can connect unattended, discover only its grants, invoke real
KasiTek capabilities through MCP or REST, receive durable results, and be revoked immediately.

## Slice 7 — KasiTek-hosted user agents and external connectors

**Layers covered:** 1, 8, 10, and 11

### Deliverables

- [ ] Implement general hosted agent definitions with instructions, model policy, capability grants,
  connector grants, knowledge/memory, channels, schedules, workflow graph, limits, and handoff.
- [ ] Implement guided creation for a small set of real templates; templates create ordinary
  versioned definitions and do not introduce template-specific runtime paths.
- [ ] Implement draft/publish/rollback/retire versioning and safe installation updates.
- [ ] Implement provider-neutral external connector manifests, vault references, ownership,
  OAuth/API-key lifecycle, tool schemas, output redaction, retry, rate limits, and audit receipts.
- [ ] Keep external connector credentials out of prompts, workflow history, traces, MCP output, and
  Agent Platform records except opaque references and safe metadata.
- [ ] Add schedules, triggers, workflow execution, channel binding, test runs, and deterministic
  human handoff using the shared runtime.
- [ ] Build hosted agent detail/configuration UI covering overview, versions, capabilities,
  connections, knowledge/memory, channels, runs, approvals, usage, and settings.
- [ ] Preserve the later visual workflow builder as an editor over the same graph/version/runtime,
  with validation, test runs, publishing, rollback, and secret-safe import/export.

### Verification

- [ ] Add definition/version/installation lifecycle, template creation, connector ownership,
  credential isolation, schedule, workflow, and handoff tests.
- [ ] Add tests proving hosted agents cannot escape declared capabilities, resources, connectors,
  budgets, concurrency, or approval policy.
- [ ] Run a complete template scenario from creation through test, publish, channel/connector use,
  approval, effect, activity, and rollback.
- [ ] Run Agent Platform/core/client suites, typechecks, lint/format, and production builds.

**Complete when:** a user can create, test, publish, observe, pause, update, and roll back a hosted
agent that safely combines KasiTek capabilities with approved external services.

## Slice 8 — Conversations, channels, knowledge, and memory

**Layers covered:** 9 and 10

### Deliverables

- [ ] Enforce personal user-owned and business customer/thread-owned conversation identity with
  organization, installation, participant, external identity, channel, and thread isolation.
- [ ] Keep browser new chats explicit and prevent fallback to an external channel-default chat.
- [ ] Standardize inbound/outbound channel envelopes, dedupe, ordering, consent/opt-out, delivery
  status, provider IDs, attachments, retries, handoff, and reply-before-delivery persistence.
- [ ] Complete thin WhatsApp, Telegram, and Discord adapters; add email later using the same boundary.
- [ ] Make authorized external-channel conversations observable in the product without merging
  separate agents, users, customers, or threads.
- [ ] Implement bounded recent history, scoped summaries, on-demand older history, reviewed
  knowledge ingestion, source attribution, and trusted/untrusted content boundaries.
- [ ] Implement selective memory with conversation/user-private/organization-shared/agent-private
  namespaces, provenance, confidence, consent, edit/delete, expiry, export, and retention.
- [ ] Add attachment scanning, prompt-injection boundaries, provider privacy settings, and minimal
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

**Complete when:** every supported channel reaches the same durable agent runtime while identity,
conversation history, delivery, knowledge, and memory remain correctly scoped and recoverable.

## Slice 9 — Approvals, effects, and operational recovery

**Layers covered:** 5, 8, and 12

### Deliverables

- [ ] Bind each approval to organization, installation, capability/version, normalized argument hash,
  resources, immutable preview revision, approver, expiry, and one permitted effect.
- [ ] Implement authenticated web approval, denial, cancellation, expiration, execution-time
  reauthorization, polling/wait/webhook status, and structured `APPROVAL_REQUIRED` responses.
- [ ] Implement domain previews for publishing, sending/replying, campaigns, bookings, destructive
  actions, and later domains before enabling their real effects.
- [ ] Persist effect state and provider receipts; classify ambiguous outcomes as
  `reconciliation_required` and prohibit blind retry.
- [ ] Implement safe retry, cancellation, compensation where supported, scheduled-action revision,
  and kill-switch cancellation.
- [ ] Present approvals, receipts, reconciliation, and recovery consistently in customer and
  operator interfaces.

### Verification

- [ ] Add approval hash/version/resource/expiry/single-use, self-approval, changed-permission,
  cancellation, and concurrent-decision tests.
- [ ] Add effect idempotency, crash-after-provider-call, timeout, duplicate callback, reconciliation,
  compensation, and kill-switch tests.
- [ ] Run end-to-end approved and denied actions from KasiAi, hosted agent, MCP, REST, and a channel.
- [ ] Run all service tests, database/Temporal recovery tests, typechecks, and builds.

**Complete when:** no real external effect can execute outside its exact current authorization and
every success, denial, failure, or ambiguous outcome has a durable operator-visible resolution path.

## Slice 10 — Shared Agents product experience

**Layers covered:** 11

### Deliverables

- [ ] Build one `/agents` overview for KasiAi, hosted agents, external connections, templates,
  approvals, activity, usage, and health.
- [ ] Build creation/connection flows with visible capabilities, resources, connectors, models,
  channels, limits, testing access, and approval behavior.
- [ ] Build common detail views for overview, configuration, versions, capabilities, connections,
  knowledge/memory, channels, conversations, runs, approvals, usage, credentials, and settings.
- [ ] Build credential create/copy-once/rotate/revoke and installation suspend/resume/archive UX.
- [ ] Show safe run/tool/model/effect timelines, errors, recovery actions, usage, cost estimates, and
  current service readiness without exposing chain-of-thought or secrets.
- [ ] Enforce personal KasiAi privacy, appropriate business-agent staff access, and workspace-owned
  administration throughout the UI.
- [ ] Implement loading, empty, stale, degraded, retry, permission-denied, and accessibility states.

### Verification

- [ ] Add component, accessibility, permission, form validation, lifecycle, credential, approval,
  activity, usage, and degraded-state tests.
- [ ] Add end-to-end flows for KasiAi, template hosted agent, external agent connection, credential
  rotation/revocation, approval, suspension, and rollback.
- [ ] Run client lint/typecheck/build and cross-browser authenticated smoke tests.

**Complete when:** users can understand, create, connect, operate, inspect, and safely stop every
agent type from one consistent product area.

## Slice 11 — KasiTek admin operations console

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

## Slice 12 — Security, observability, expansion, and production release

**Layers covered:** 12, 13, and 14

### Deliverables

- [ ] Emit immutable redacted audit events and separate operational traces, metrics, and diagnostic
  logs with stable correlation across edge, Agent Platform, Temporal, core, and providers.
- [ ] Attribute tokens/cost, tools, effects, connectors, channels, storage, schedules, failures,
  latency, and concurrency to organization, installation, definition/version, and credential.
- [ ] Implement health dashboards and alerts for auth, credentials, APIs, model providers, Temporal,
  queues/workers, databases, Redis, tools, provider effects, webhooks, delivery, approvals, cost,
  rate limits, and suspicious access.
- [ ] Enforce the global → organization → definition → installation → capability → connector/channel
  kill-switch hierarchy and test rollback before destructive recovery.
- [ ] Implement retention, redaction, deletion, export, backup/restore, legal-hold readiness, and
  periodic access review for audits, traces, logs, webhook payloads, conversations, and memory.
- [ ] Apply credential/replay/confused-deputy, injection, data minimization, attachment, SSRF,
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
type validation. Database, Temporal, browser, and provider tests remain separate required gates
because the basic commands above cannot prove those integrations.

- [ ] Agent Platform unit tests pass.
- [ ] Agent Platform database/integration tests pass against an isolated test database.
- [ ] Agent Platform TypeScript typecheck and production build pass.
- [ ] `kasitek-core` formatting, compile checks, unit tests, and relevant database integration tests
  pass.
- [ ] Direct client lint, typecheck, component tests, and production build pass.
- [ ] Admin client lint, typecheck, component tests, and production build pass.
- [ ] Relevant migrations apply from a clean database and from the supported previous schema.
- [ ] Relevant Temporal workflow/recovery tests pass.
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
