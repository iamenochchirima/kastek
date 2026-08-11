# KasiAi and Agents Product Cutover Plan

**Status:** Ready for implementation  
**Scope:** Direct KasiTek product (`kasitek-core`, `client/apps/client`, and `agents`)  
**Cutover type:** One-way replacement of the legacy bot system  
**Last updated:** 2026-08-11

## 1. Outcome

This checklist covers the first complete product delivery on the shared Agent Platform:

- KasiAi is available as the protected default agent for every KasiTek organization.
- Users can open KasiAi from the application sidebar, resume their own conversation, send a
  message, receive a streamed response, and return to durable history later.
- The `/agents` product area reads and writes the new Agent Platform only.
- Users can create and operate a small set of template-based agents through the same runtime.
- The legacy `/api/bots`, old n8n bot provisioning, legacy bot UI, and legacy bot tables are
  removed. There is no compatibility adapter, fallback, dual write, or hidden old runtime.
- Custom workflow building remains outside this tranche. Template-created agents are ordinary
  versioned agents and do not introduce template-specific runtime branches.

This plan is the product-integration tranche of
[`KASITEK_AGENT_PLATFORM_IMPLEMENTATION_PLAN.md`](KASITEK_AGENT_PLATFORM_IMPLEMENTATION_PLAN.md).
The shared runtime, storage, Temporal worker, model gateway, memory, tools, and audit system remain
authoritative.

## 2. Fixed architecture decisions

- [x] KasiAi runs on the shared Agent Platform; it has no separate runtime.
- [x] Maintain one global, protected, system-owned KasiAi definition and version history.
- [x] Create one organization-scoped KasiAi installation per KasiTek organization.
- [x] Give each user a separate durable platform conversation under that organization installation.
- [x] Keep agent definitions, versions, installations, conversations, runs, memory, and audit data
  in the Agent Platform database.
- [x] Keep users, organizations, memberships, entitlements, connected accounts, and product data
  authoritative in `kasitek-core`.
- [x] Let the browser call authenticated KasiTek application endpoints; never expose the Agent
  Platform internal secret or trust browser-supplied organization/actor headers.
- [x] Use short-lived signed internal calls between `kasitek-core` and the Agent Platform.
- [x] Use the platform/sidebar channel adapter for KasiAi and the initial template agents.
- [x] Use PostgreSQL-backed SSE events for initial response streaming.
- [x] Perform a hard cutover from the legacy bot system with no fallback or dual-write period.
- [x] Preserve historical migration files, but remove all live legacy bot tables, code, routes,
  generated models, configuration, and UI references through new destructive migrations and code
  deletion.

## 3. Target request path

```text
Dashboard sidebar or Agents UI
             |
             v
   authenticated kasitek-core API
             |
     signed internal request
             v
      kasitek-agents API
       |             |
       v             v
 Agent PostgreSQL   Temporal Cloud
                         |
                         v
                 shared Agent worker
                    |          |
                    v          v
               Model gateway  Tool gateway
                                  |
                                  v
                             kasitek-core
```

The sidebar is one input channel. WhatsApp, Telegram, and later channels will resolve the same
installation/conversation/run contracts instead of creating another KasiAi implementation.

## 4. Current gaps this tranche must close

- [x] A system-owned definition can be installed into another organization while installation
  data remains organization-scoped. **Migration 017 and repository visibility rules implement and
  test this boundary.**
- [x] An idempotent KasiAi bootstrap/reconciliation command exists. **`pnpm run
  bootstrap:kasiai` creates or resolves the protected definition and identical initial published
  version.**
- [x] A default-organization installation resolver exists. **The repository and authenticated API
  ensure one installation per organization/definition/scope.**
- [x] The platform channel API exposes one atomic inbound-message operation. **Migration 018 and
  `PlatformChatRepository` store the inbound message, run, attempt, state, and received event in
  one transaction before workflow dispatch.**
- [x] A completed conversation run persists the assistant reply as a durable outbound message
  before changing the run to `completed`.
- [x] The SSE stream is connected to the KasiTek client.
- [x] `kasitek-core` proxies authenticated Agent Platform control-plane and chat calls.
- [ ] The Agent Platform internal signing secret and URL are not configured across both services.
- [x] The sidebar has a KasiAi chat surface.
- [x] `/agents`, `/agents/activity`, and `/agents/analytics` no longer read the legacy `/api/bots`
  system.
- [ ] The destructive database migration still needs to be applied in each deployed environment;
  live Rust routes, services, callbacks, and generated models have been removed.
- [x] A server-owned initial Agent Platform template catalog exists.

## 5. Phase A — Freeze and inventory the legacy bot system

The recorded dependency and row-count inventory is in
[`docs/LEGACY_BOT_PURGE_INVENTORY.md`](docs/LEGACY_BOT_PURGE_INVENTORY.md).

- [x] Enumerate every caller of `/api/bots`, bot callbacks, trusted bot events, and old n8n agent
  provisioning endpoints.
- [x] Enumerate every read/write of `BotConfiguration`, `BotDeployment`, and `BotEvent`.
- [x] Identify customer, workspace-summary, billing-meter, connection, dashboard, and activity
  queries that derive data from legacy bot tables.
- [x] Identify all old bot environment variables and callback secrets.
- [x] Record the exact legacy table row counts before the destructive migration.
- [x] Confirm no production data needs conversion into new Agent Platform definitions. This plan
  intentionally purges legacy bot records rather than importing them.
- [x] Add a repository check that fails if live source introduces a new `/api/bots` or legacy bot
  table/configuration reference (`scripts/check-no-legacy-bot-references.sh`).

**Exit gate**

- [x] Every legacy dependency has an assigned replacement or deletion task.
- [x] The destructive scope is explicit before any table is dropped.

## 6. Phase B — System-agent and installation model

### 6.1 Global system agent support

- [x] Add a migration and repository rules that allow an organization installation to reference
  an active published system-owned version while retaining organization isolation for all
  installation-owned data.
- [x] Prevent organizations from editing, versioning, retiring, archiving, or changing protected
  system definitions.
- [x] Allow organizations to view protected agents only through their own installations.
- [x] Ensure organization-created definitions remain visible only to their owner organization.
- [x] Add a unique constraint for one installation per definition, organization, scope type, and
  scope ID where the product requires idempotent installation.
- [x] Add isolation tests proving an organization cannot resolve another organization's
  installation, conversations, runs, messages, memory, or settings.

### 6.2 KasiAi bootstrap

- [x] Add an idempotent bootstrap/reconciliation command for the protected `kasiai` definition.
- [x] Create the first immutable KasiAi version with a pinned model policy, bounded context,
  bounded model calls, token/cost limits, and the fixed initial tool set.
- [x] Keep KasiAi's provider credential environment-backed and KasiTek-funded; never store it in
  the definition or Temporal workflow input.
- [x] Add production startup validation for the selected KasiAi model/provider credential.
- [ ] Seed or ingest the initial platform-guidance knowledge with explicit provenance and version.
- [x] Add a controlled release command that validates and publishes a new protected version while
  recording the prior version for rollback metadata (`pnpm release:kasiai`).
- [x] Do not automatically move active installations to a new version; `pnpm release:kasiai --rollout`
  performs an explicit audited rollout when requested.

### 6.3 Default organization installation

- [x] Add an idempotent `ensure KasiAi installation` service operation.
- [x] Create the installation on first authenticated use or organization provisioning, whichever
  occurs first.
- [x] Use one organization-scoped installation and create an AgentPrincipal with the minimum
  required audience and grants.
- [x] Expose only permitted organization settings such as preferred language, tone, response
  detail, and notification behaviour through a strict installation-settings contract.
- [x] Keep protected instructions, system policy, model routing, and grants unavailable to normal
  organization mutation endpoints.
- [x] Add pause/disable behaviour that preserves history and clearly disables new runs.

**Exit gate**

- [x] Repeated bootstrap and installation calls create exactly one KasiAi definition, one current
  published version, and one installation per organization.
- [x] KasiAi appears through the same installed-agent projection as other agents.

## 7. Phase C — Generic platform chat contract

The chat path must remain generic. KasiAi selects an installation; the message and run flow should
also work for template-created agents.

### 7.1 Conversation resolution

- [x] Add an idempotent platform conversation resolver using the authenticated organization,
  installation, and user identity.
- [x] Use a stable external conversation identity such as `platform:user:<user-id>` without
  exposing it as authority.
- [x] Create the authenticated user participant and agent participant once.
- [x] Return durable conversation metadata and ordered history with bounded pagination.
- [x] Support starting a new conversation without deleting prior history.
- [x] Preserve conversation isolation across users in the same organization.

### 7.2 Atomic inbound message and run start

- [x] Add one authenticated Agent Platform operation that validates the installation, persists an
  inbound canonical message, creates an idempotent run, and starts its Temporal workflow.
- [x] Accept a client-generated idempotency key and ensure retries return the same message/run.
- [x] Accept trusted page context separately from user text: current route, page/resource type,
  and permitted resource ID.
- [x] Re-authorize trusted page/resource context in `kasitek-core` before passing it to the Agent
  Platform; only bounded route/title context is accepted and resource identifiers are excluded.
- [x] Reject disabled installations, archived conversations, oversized content, unsupported
  message types, and invalid organization/user scope.
- [x] Acknowledge only after the inbound message and run are durably stored.

### 7.3 Durable assistant reply

- [x] Persist the final model response as one outbound conversation message before marking the run
  complete.
- [x] Make outbound persistence idempotent across Temporal activity retries.
- [x] Link the outbound message to its run; model-call records share the same run identifier for
  audit correlation.
- [x] Persist failure and cancellation events without fabricating an assistant response.
- [x] Rebuild the conversation summary only after the new outbound message is durable.
- [x] Return the final message through run inspection and conversation history.

### 7.4 Streaming and control

- [x] Define the sidebar-safe SSE event contract around durable run events and stable public
  payload fields; the assistant response itself is returned from durable conversation history.
- [x] Redact prompts, credentials, hidden policy, internal tool arguments, and unsafe tool output
  from browser events with an explicit payload allowlist.
- [x] Support stream reconnection using the durable event cursor.
- [x] Close the stream reliably on terminal status.
- [x] Wire cancellation to the existing Temporal cancellation signal.
- [x] Keep approval events in the contract even though the first KasiAi tool set is read-only.

**Exit gate**

- [x] One request creates exactly one inbound message, one run, and one outbound response.
- [x] Refreshing or reconnecting cannot duplicate the run or reply.
- [x] Conversation history is complete after API, worker, or browser restarts.

## 8. Phase D — Authenticated `kasitek-core` bridge

- [x] Add `AGENTS_API_URL`, internal audience, timeout, and signing-secret configuration to
  `kasitek-core` with production startup validation.
- [x] Reuse the current authenticated session and active organization resolution.
- [x] Sign short-lived internal claims containing organization, actor, audience, expiry, and scopes.
- [ ] Add a request correlation ID to the signed claims and propagate it through runs/events.
- [ ] Extend claims for agent/version/installation/run context where required by tool execution.
- [x] Add a typed Rust Agent Platform client with bounded timeouts and safe error mapping.
- [x] Add authenticated product endpoints for KasiAi installation, platform conversation/history,
  chat send, run status, cancellation, and SSE forwarding.
- [x] Never proxy arbitrary paths or accept organization IDs from the browser as authority.
- [x] Re-check `feature.agents.manage` for management routes while allowing the product-defined
  KasiAi access policy for sidebar chat; template installation and installation/lifecycle
  mutations require the capability in `kasitek-core`.
- [x] Add initial request/response contract tests between Rust and TypeScript for HMAC claim shape
  and sanitized chat payloads.
- [ ] Add correlation IDs to core logs, Agent Platform events, runs, and tool calls.

**Exit gate**

- [x] A signed-in user can use KasiAi without direct network access to the Agent Platform.
- [x] A forged organization or actor header cannot cross the core boundary; core derives both
  organization and actor from the authenticated session and signs them server-side.

## 9. Phase E — KasiAi sidebar chat

- [x] Add a clear KasiAi entry point to the desktop sidebar and mobile dashboard navigation.
- [x] Implement an accessible chat panel that works alongside any dashboard page.
- [x] Resolve the default installation and current user's conversation when the panel opens.
- [x] Load paginated durable history and preserve scroll position while prepending earlier messages.
- [x] Send messages with a client idempotency key.
- [x] Stream status and the final response from the durable SSE endpoint.
- [x] Support stop/cancel, retry after safe failures, reconnect after network loss, and explicit new
  conversation creation.
- [ ] Show useful states for unconfigured model credentials, disabled installation, exceeded
  budget, service unavailable, failed run, and expired approval.
- [x] Pass current page context only through the core-sanitized context field. Resource context
  remains intentionally unavailable until a core authorization boundary exists.
- [x] Render text safely; do not permit arbitrary model-generated HTML.
- [ ] Add keyboard navigation, focus management, screen-reader status updates, responsive layout,
  and reduced-motion behaviour.
- [x] Persist only conversation identifiers and harmless UI preferences in the browser; the
  initial sidebar keeps durable state server-side and does not store message content locally.
- [ ] Add component, interaction, and end-to-end tests for open, send, stream, refresh, reconnect,
  cancel, and history isolation.

**Exit gate**

- [x] A user can open KasiAi from any supported dashboard page and complete a durable conversation.
- [x] Two users in one organization see separate KasiAi histories.
- [x] The sidebar uses no legacy bot or direct provider API.

## 10. Phase F — New Agents product UI

### 10.1 Agents list and detail

- [x] Replace the current `/agents` data source with the authenticated Agent Platform bridge.
- [x] Display KasiAi as protected and system-owned with its installed status and sidebar entry.
- [x] Display installation status and current published version; permitted settings/health detail
  remains to be expanded.
  last run, and recent activity.
- [x] Display organization-created agents with template, status, installation state, and current
  published version; last-run/failure detail remains to be expanded.
  run, failure state, and current published version.
- [x] Add empty, loading, error, paused, disabled, and unavailable states backed by real data.
- [x] Add an agent detail page for overview, installation state, version history, and available
  lifecycle operations; template settings, conversations, activity, and memory/knowledge detail
  remain follow-up surfaces.
- [x] Prevent protected-agent mutation controls from appearing for KasiAi.
- [x] Expose only lifecycle controls backed by real Agent Platform operations; protected and
  unavailable mutations are not rendered.

### 10.2 Initial template catalog

- [x] Add an initial client template catalog with stable keys and explicit availability states. Only
  KasiAi is available until the ordinary-agent creation transaction exists.
- [x] Move the catalog to a versioned server-owned source with schemas and template policy.
- [x] Start with a small set that the current runtime can honestly support:
  - general website/support assistant;
  - FAQ and knowledge assistant;
  - lead-intake assistant;
  - booking-request intake assistant that collects and hands off details but does not claim to
    create bookings until the booking tool exists.
- [x] Define instructions, model policy, allowed tools, required connections, configurable fields,
  budgets, and channel compatibility for every template.
- [x] Validate all template configuration fields on the server; the versioned catalog currently
  exposes only the strict tone enum and rejects unknown fields.
- [x] Create ordinary organization-owned definition, draft version, published version,
  installation, grants, and default platform conversation from a template transactionally.
- [x] Record the source template key/version but permit later version history independent of the
  catalog.
- [ ] Do not add a custom workflow editor in this tranche.

### 10.3 Creation and lifecycle UI

- [x] Replace the old bot creation modal with a template selection flow; unavailable templates are
  visibly disabled rather than routed to legacy provisioning.
- [x] Implement template selection, minimal configuration, review, create, and success states.
- [x] Support pause/resume, publish, rollback, retire, and archive through real Agent Platform
  operations exposed through the authenticated core bridge.
- [x] Add safe deletion semantics: archive definitions and preserve historical runs; do not hard
  delete active agent history from normal user controls.
- [ ] Bind the platform channel by default so a newly created template agent can be tested in the
  product immediately.
- [x] Add a `Test agent` chat surface on the agent detail page using the same generic chat contract.
- [ ] Make user-provided model credentials optional; use KasiTek-funded credentials where plan and
  policy allow.

### 10.4 Activity and analytics

- [x] Replace `/agents/activity` legacy bot events with Agent Platform audit records and run status.
- [x] Replace `/agents/analytics` legacy counts with Agent Platform run, failure, token,
  tool, and estimated-cost aggregates.
- [x] Replace workspace agent counts and attention queries with Agent Platform summary data.
- [x] Remove old deployment terminology where it represents n8n provisioning rather than an Agent
  Platform installation.

**Exit gate**

- [x] KasiAi appears in the same Agents experience that will host template-created agents.
- [x] A template-created agent can be configured, installed with a published version, tested from
  its detail page, paused, resumed, and inspected end to end; draft-authoring remains outside this
  template tranche.
- [x] No Agents page calls `/api/bots` or reads legacy bot records.

## 11. Phase G — Initial KasiAi product configuration

- [x] Write the initial protected instructions around platform guidance, user intent, uncertainty,
  tool use, data boundaries, and escalation.
- [ ] Add versioned platform navigation and product-help knowledge.
- [x] Add the first read-only tool contracts required for useful guidance, including workspace
  connection/status inspection, through the authenticated `kasitek-core` boundary.
- [x] Grant only the fixed read-only tools required by the first release (`platform.current_time`
  and `kasitek.core.workspace_status` in KasiAi v2).
- [x] Keep content publishing, campaign sending, customer mutation, booking creation, credential
  changes, billing changes, and other external effects unavailable in the first release.
- [ ] Add evaluation scenarios for navigation guidance, unavailable features, organization
  isolation, prompt injection, tool denial, refusal of ungranted actions, and correct handoff.
- [ ] Add a release evaluation gate for every new KasiAi version.
- [ ] Add global and organization kill-switch tests.

**Exit gate**

- [ ] KasiAi answers platform questions using its versioned knowledge and completes permitted
  read-only calls through the generic Tool Gateway.
- [x] KasiAi cannot invoke ungranted platform actions; runtime grants are resolved per version and
  installation before tool execution.

## 12. Phase H — Complete legacy bot purge

This phase is deliberately one-way. It must not leave a compatibility layer or fallback.

### 12.1 Client removal

- [x] Delete old `/api/bots` calls, legacy bot types, bot creation/action UI, n8n deployment state,
  and callback-oriented copy.
- [x] Replace or delete all old bot loading skeletons, template metadata, activity mapping, and
  analytics mapping that no longer match the new UI.
- [x] Remove stale service-worker/preload assumptions tied to the old pages; no live Agent UI
  service-worker or preload dependency remains.
- [x] Verify the client source and generated database client contain no `/api/bots` string.

### 12.2 `kasitek-core` removal

- [x] Remove the `/api/bots` route scope and controller module.
- [x] Remove `services/bots.rs`.
- [x] Remove the old `services/agents` n8n provisioning client, templates, payloads, and callbacks
  once reference analysis confirms they are exclusively legacy.
- [x] Keep the new `agent_internal` tool boundary for read-only platform tools; it is independent
  of the deleted n8n provisioning code.
- [x] Remove old bot request/row structs from `db/models.rs`.
- [x] Remove customer history joins to legacy bot tables and source workspace agent metrics from the Agent Platform.
- [x] Remove old callback authentication and n8n agent-provisioning environment variables when no
  remaining non-agent feature uses them.
- [ ] Remove old bot-specific billing meter wiring while preserving the current Agents entitlement.

### 12.3 Database and generated client removal

- [x] Add a new explicit destructive Prisma/SQL migration that drops foreign keys, indexes, and
  `BotEvent`, `BotDeployment`, and `BotConfiguration` in dependency-safe order.
- [x] Remove the legacy models and relations from the Prisma schema.
- [x] Regenerate Prisma clients and remove generated legacy bot types.
- [x] Do not rewrite or delete historical migration files already applied to environments.
- [ ] Test the destructive migration from a production-like schema snapshot.
- [x] Verify no runtime query references a dropped table; the live-source scan is clean.

### 12.4 No-fallback enforcement

- [x] Make `/api/bots` return 404 because the route no longer exists, not a compatibility response.
- [x] Remove all feature flags that switch between old bots and the Agent Platform.
- [x] Remove all dual-write, import-on-read, or legacy lookup code.
- [x] Remove old n8n agent workflow identifiers and callback URLs from active configuration.
- [x] Add static checks for `/api/bots`, `BotConfiguration`, `BotDeployment`, and `BotEvent` in live
  source paths, with explicit exclusions only for historical migrations and this plan.

**Exit gate**

- [ ] Old routes, services, generated models, UI code, callbacks, and active configuration are
  absent; the destructive table migration still needs to be applied to deployed databases.
- [ ] The new Agents UI and KasiAi continue to pass end-to-end tests after the purge migration.

## 13. Phase I — Operations and admin visibility

- [ ] Add Agent Platform service health, Temporal worker health, task-queue activity, database
  health, and model-provider status to the internal admin surface.
- [ ] Add organization/agent/run lookup with redacted timelines.
- [ ] Add model usage, estimated cost, failure category, latency, queue age, active approvals, and
  kill-switch visibility.
- [ ] Add KasiAi installation/version rollout status by organization.
- [ ] Add controls for global and organization-scoped kill switches with audit records.
- [ ] Add alerts for workflow failure rate, stuck runs, no active workers, model authentication
  failure, budget exhaustion, and database/Temporal connectivity.
- [ ] Prevent admin inspection from exposing credentials, full hidden prompts, or unredacted
  customer content by default.

**Exit gate**

- [ ] An operator can determine whether a failed sidebar message was caused by client, core,
  Agent API, Temporal, worker, database, model, policy, or tool failure.

## 14. Verification matrix

### Agent Platform

- [ ] Unit tests for system-agent visibility and protected mutation rules.
- [x] Database tests for idempotent organization installation and per-user conversations.
- [x] Database tests for cross-organization and cross-user isolation.
- [x] Integration test for atomic inbound message/run creation and retry idempotency.
- [ ] Temporal test for durable outbound message persistence under activity retry.
- [ ] Temporal Cloud test for worker stop/restart during a KasiAi run.
- [ ] SSE cursor reconnect and terminal-close tests.
- [ ] Model-provider live smoke test using the configured KasiTek credential.

### `kasitek-core`

- [x] Signed internal-auth contract tests.
- [ ] Session, membership, entitlement, and active-organization authorization tests.
- [ ] Proxy timeout, Agent Platform unavailable, and invalid-response tests.
- [ ] SSE forwarding disconnect/reconnect tests.
- [ ] Core tool authorization and organization-scope tests.
- [x] Rust format and unit checks; database-backed integration checks remain environment-dependent.

### Client

- [ ] KasiAi sidebar component and accessibility tests.
- [ ] Sidebar send/stream/history/reconnect/cancel tests.
- [ ] Agents list/detail/template creation/lifecycle tests.
- [ ] Activity and analytics tests against new contracts.
- [ ] Responsive desktop/mobile checks.
- [x] Client type-check and production build; dedicated component/unit coverage remains follow-up.

### Cutover

- [ ] Migration test proves legacy tables are dropped cleanly.
- [x] Static scan proves no live legacy symbol or endpoint remains.
- [ ] End-to-end test creates an organization, ensures KasiAi, chats, refreshes history, creates a
  template agent, tests it, pauses it, and inspects activity.
- [ ] End-to-end test proves another organization and another user cannot read that data.
- [ ] End-to-end suite passes with the old bot routes and tables absent.

## 15. Implementation order and commit boundaries

Implement and commit in this order:

1. **System-agent foundation:** migration, global definition access rules, installation uniqueness,
   bootstrap, and isolation tests.
2. **Generic platform chat:** conversation resolution, atomic inbound operation, outbound message
   persistence, SSE contract, and Temporal tests.
3. **Core bridge:** configuration, signed client, authenticated proxy routes, authorization, and
   contract tests.
4. **KasiAi product seed:** protected version, model policy, knowledge, read-only tools, default
   installation, and evaluations.
5. **Sidebar UI:** chat panel, history, streaming, cancellation, error states, and client tests.
6. **Template control plane:** catalog, transactional create-from-template operation, lifecycle,
   and tests.
7. **Agents UI replacement:** list, detail, creation, activity, analytics, and test chat.
8. **Legacy code purge:** remove client and Rust routes/services/types/config after replacement
   flows pass.
9. **Legacy database purge:** apply and verify the destructive drop migration, regenerate clients,
   and enforce no-fallback static checks.
10. **Operations and final verification:** admin visibility, live Temporal/model test, complete
    build suite, and end-to-end cutover test.

Each commit must leave its owned services buildable. Do not combine the destructive database
migration with the first implementation of its replacement.

## 16. Definition of done

- [ ] KasiAi is automatically available to an eligible organization and uses the shared Agent
  Platform end to end.
- [ ] Sidebar messages are durable, idempotent, streamed, auditable, cancellable, and isolated.
- [ ] The final assistant response is stored in conversation history and survives restarts.
- [ ] The Agents UI manages new Agent Platform resources only.
- [ ] At least one basic template-created agent completes a real end-to-end run.
- [ ] KasiAi and organization agents use the same definitions, versions, installations,
  conversations, runs, tools, memory, model gateway, and workers.
- [ ] No browser receives internal service credentials or supplies authoritative organization
  identity.
- [ ] No `/api/bots` route, legacy bot runtime, n8n bot provisioning path, legacy bot table,
  compatibility layer, fallback, or dual write remains.
- [ ] Agent, core, client, migration, security, and end-to-end verification pass.
- [ ] The root Agent Platform checklist and current implementation evidence are updated to reflect
  the completed cutover.
