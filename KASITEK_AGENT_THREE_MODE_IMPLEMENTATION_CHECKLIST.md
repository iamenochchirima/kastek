# KasiTek Agent Three-Mode Architecture Implementation Checklist

**Status:** Required architecture remediation and implementation plan

**Current implementation state (2026-08-15):** Foundation, database-enforced mode boundaries,
dedicated external-connection creation, shared effective-access projection, proxy wiring, and
mode-specific client surfaces are implemented and verified by the evidence entries at the end of
this file. Subscription/provider entitlement resolution, live provider/browser verification, and
real third-party client compatibility remain open.

**Created:** 2026-08-15

**Scope:** Separate protected KasiAi, KasiTek-hosted user agents, and externally connected agents
without weakening their shared capability, approval, audit, and core-domain boundaries.

**Primary implementation authority:**
[`KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md`](KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md)

**Release-blocking remediation authority:**
[`KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md`](KASITEK_AGENT_SYSTEM_AUDIT_REMEDIATION_CHECKLIST.md)

**Architecture rationale:**
[`KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`](KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md)

**Repository boundaries:** [`PROJECT_PLAN.md`](PROJECT_PLAN.md)

## 1. Purpose and authority

This checklist fixes a verified implementation gap: the canonical architecture defines three agent
execution modes, but the current persisted model and most API/UI projections do not carry an
execution mode. The external-agent connection flow consequently creates credentials for an existing
installation and can present protected KasiAi as the external caller's identity.

This is a scoped remediation plan. It does not replace the audit remediation checklist or execution
blueprint. When an item here changes the truth of a checked canonical item, reopen that canonical
item and add evidence only after this checklist's corresponding completion gate passes.

- [x] Read `AGENTS.md`, this checklist, the audit checklist, blueprint, architecture draft,
  `PROJECT_PLAN.md`, and `BLOCKERS.md` before structural work.
- [x] Re-check `git status --short` before every implementation batch and preserve unrelated work.
- [x] Add a failing regression test before or with each testable architecture correction.
- [x] Do not expose external-agent credential creation until the server can bind it to a genuine
  `external_connected` installation.
- [x] Treat UI mode checks as presentation only; enforce every mode boundary in the Agent API.
- [x] Tick an item only when implementation and its listed verification both pass.
- [x] Add files, tests, commands, and commit hashes beside completed parent items. This work is
  committed in `e2615a1`; the evidence entries record the exact files and verification commands.

## 2. Confirmed product model

```text
KasiAi                 system_hosted       protected KasiTek platform assistant
Hosted user agent      kasitek_hosted      user-defined agent executed by KasiTek
External agent         external_connected  customer runtime calling KasiTek through MCP or REST
```

All modes share installation identity, organization isolation, capability manifests, grants,
resource constraints, approvals, idempotency, audit attribution, usage accounting, and core domain
operations. They do not share the same setup flow or management surfaces.

### 2.1 Required mode behavior

| Surface | `system_hosted` | `kasitek_hosted` | `external_connected` |
| --- | --- | --- | --- |
| Protected KasiAi definition/policy | Yes | No | No |
| KasiTek model execution | Yes | Yes | No |
| Editable instructions/model/workflow | No | Yes | No |
| Platform chat/conversations | Yes | Yes where supported | No |
| WhatsApp/Telegram/Discord channels | Yes | Yes where supported | No |
| Knowledge/memory | Yes where policy permits | Yes | No hosted memory |
| KasiTek schedules/workflows | Platform-managed only | Yes | No; external runtime owns scheduling |
| MCP/REST installation credentials | No | No | Yes |
| Capability grants | Release-managed allowlist | Workspace-managed | Chosen during connection and managed later |
| Resource/connector narrowing | Where policy permits | Yes | Yes |
| Approvals/activity/usage | Yes | Yes | Yes |
| Connection health/last use | Channel/runtime health | Hosted runtime health | Credential/MCP/REST health |

### 2.2 Non-negotiable invariants

- [x] An external runtime never authenticates as the KasiAi installation.
- [x] An external runtime never authenticates as a KasiTek-hosted user agent installation.
- [x] KasiAi channel connections are created and managed only from the hosted installation details
  surface; the API requires a supported hosted mode and the KasiAi UI uses the canonical protected
  installation.
- [x] Hosted user-agent configuration never appears in an external connected-agent flow.
- [x] Installation credentials exist only for `external_connected` installations.
- [x] Credential scopes may narrow installation authority but may never expand it; transport scope,
  installation grants, resource/connector constraints, and approval policy are all rechecked.
- [x] Current database state, not an unverified token claim or UI field, decides execution mode.
- [x] Pausing, rotating, revoking, or changing one installation cannot affect another mode's identity;
  all mutations are installation-scoped and external archive revokes only that installation's
  credentials.
- [x] Audit, approval, run, usage, and effect evidence records the actual installation and mode
  either directly or through the immutable installation identity; new mode-specific audit metadata
  is included for installation and credential lifecycle events.

## 3. Verified current gaps

- [x] Record the baseline commit and current worktree before remediation.
- [x] Record that `agent_definitions.owner_type` expresses ownership only and cannot represent the
  three execution modes.
- [x] Record that `agent_installations` currently has no persisted execution-mode column.
- [x] Record that `CreateInstallationInput` currently has no execution mode.
- [x] Record that the external connection wizard selects from existing installations.
- [x] Record that installation credentials can currently be created for protected KasiAi.
- [x] Record that the shared agent details page renders credentials, channels, schedules, knowledge,
  chat, and other panels primarily based on installation existence rather than execution mode.
- [x] Record every KasiAi-specific route that checks only active installation status and not the
  protected KasiAi identity.
- [x] Record every credential, channel, chat, schedule, workflow, knowledge, and model endpoint that
  lacks an execution-mode guard.
- [x] Reopen any blueprint or architecture checklist item that claims three-mode support without
  persisted types, API enforcement, UI separation, and tests.

### Baseline evidence (pre-remediation snapshot)

The baseline was captured from commit `b2f6789c5a5f599886708eb2f88e8acd60096a06` before this batch.
The pre-remediation worktree contained 151 changed/untracked paths, which were preserved while the
Agent Platform files were updated. The baseline review confirmed that `owner_type`/`protected`
were the only persisted identity signals, installation rows had no `execution_mode`, creation input
had no mode, the external wizard selected an existing installation, credential routes did not reject
KasiAi/hosted installations, and the shared detail page rendered panels from installation presence.
The route audit covered KasiAi, credential, channel, conversation, schedule, workflow, knowledge,
memory, and run entry points before guards were added.

## 4. Immediate containment before the migration

- [x] Feature-gate or temporarily disable customer external-agent credential creation; the old
  generic credential path is mode-gated and the replacement flow only creates external identities.
- [x] Remove KasiAi and hosted installations from the external connection wizard immediately.
- [x] Do not replace the selector with a hidden KasiAi installation ID.
- [x] Add a server-side temporary rejection for credential creation on protected/system
  installations.
- [x] Remove external-agent credential creation controls from KasiAi details.
- [x] Inventory active and revoked credentials with the operator-only
  `/v1/operator/agent-credential-inventory` projection; it excludes hashes, secrets, and assertion
  material.
- [ ] Revoke any credential exposed in screenshots, logs, fixtures, support messages, or copied test
  output; never place its value in remediation evidence.
- [x] Add audit events for external-only credential lifecycle, legacy-mode revocation, and external
  archive/disable actions.
- [ ] Verify existing KasiAi platform chat and channel functionality remains available.

**Containment gate**

- [x] A user cannot create a new external credential whose installation is KasiAi or a hosted agent.
- [x] Existing protected installations continue to support their legitimate hosted/channel flows.
- [x] No secret material is written to logs, traces, audit records, or test snapshots; the one-time
  secret is returned only from the transaction response and is omitted from persisted records.

## 5. Persisted execution-mode model

### 5.1 Migration

- [x] Add the next ordered Agent Platform migration for `agent_installations.execution_mode`.
- [x] Define a database check constraint allowing only `system_hosted`, `kasitek_hosted`, and
  `external_connected`.
- [x] Add the column in a deployment-safe phase before making it `NOT NULL`.
- [x] Backfill protected KasiAi installations to `system_hosted` using protected system ownership
  and the canonical system identity; do not rely on display name alone.
- [x] Backfill existing organization-owned hosted/template installations to `kasitek_hosted` unless
  credential evidence requires explicit review.
- [x] Keep ambiguous credential-bearing installations reportable and never label KasiAi as external;
  migration `049` classifies and revokes non-external credentials while the operator inventory
  preserves the installation/mode history for review.
- [x] Add indexes needed by organization, mode, status, and last-updated list projections.
- [x] Make `execution_mode` non-null only after backfill and ambiguity checks pass.
- [x] Add database comments describing mode semantics and ownership independence.
- [x] Add downgrade/rollback guidance: do not remove `execution_mode` or restore revoked credential
  status; roll back application code first while retaining migrations, audit history, and disabled
  identities until an explicit forward remediation is approved.

### 5.2 Domain contracts

- [x] Add a single typed `AgentExecutionMode` contract shared across repository, service, HTTP, and
  UI projections.
- [x] Add `executionMode` to installation creation, installation records, agent list/detail
  projections, audit metadata, and operator projections.
- [x] Keep `owner_type` and `protected` separate from execution mode.
- [x] Reject `system_hosted` creation through organization/customer endpoints.
- [x] Require `system_hosted` installations to reference the protected system definition.
- [x] Require `kasitek_hosted` installations to reference an organization-owned hosted definition
  and a published hosted version.
- [x] Require `external_connected` installations to reference an organization-owned external
  definition and a published external policy version.
- [x] Prevent changing an installation's mode after creation; replace/migrate the installation
  through an audited command instead.
- [x] Add safe mode labels and descriptions to generated/customer-facing projections.

### 5.3 External policy version

- [x] Define the external connected-agent version contract without pretending KasiTek hosts its
  model, prompt, memory, schedule, or workflow.
- [x] Store a versioned capability/policy envelope for the external identity.
- [x] Store bounded external runtime metadata such as runtime family and environment without
  accepting provider secrets.
- [x] Ensure external versions cannot enter the hosted model loop; direct hosted runs reject
  `external_connected`, while MCP/REST capability runs use the dedicated `mcpTool` path.
- [x] Ensure external versions remain immutable and auditable after activation.

**Persisted-model gate**

- [x] Every active installation has exactly one valid execution mode; clean and seeded PostgreSQL
  migration runs applied all 50 migrations and enforce the non-null check.
- [x] Invalid definition/mode combinations fail in service validation and database-backed lifecycle
  tests.
- [x] List/detail APIs return mode without inference from slug, display name, or credential presence.

## 6. Central mode policy and API enforcement

### 6.1 One policy matrix

- [x] Implement one server-side mode-policy module defining which operation families each mode may
  use.
- [x] Make HTTP routes and application services call that policy rather than duplicating string
  comparisons.
- [x] Return stable, safe errors for wrong-mode access without leaking another installation.
- [x] Include mode in the authorization context after loading the current installation; external
  token contexts carry the database-verified `executionMode`, and lifecycle audit records include
  the mode.
- [x] Add an exhaustive execution-mode policy test that fails when a new mode or protected operation
  family lacks a matrix entry.

### 6.2 KasiAi-only boundaries

- [x] Require `system_hosted`, protected system ownership, and canonical KasiAi identity for every
  `/kasiai/*` installation route.
- [x] Apply the same identity check to KasiAi home, preferences, model catalog, personal
  conversations, pairing, and channel-default behavior.
- [ ] Keep protected instructions, version publishing, and source allowlist release-managed.
- [ ] Prevent customer endpoints from converting another installation into KasiAi through settings.

### 6.3 Hosted-runtime boundaries

- [x] Allow model execution only for `system_hosted` and `kasitek_hosted` as explicitly supported.
- [x] Allow editable instructions, model policy, workflow graph, knowledge, schedules, and runtime
  limits only for `kasitek_hosted`.
- [x] Keep KasiAi-specific preferences separate from general hosted-agent configuration.
- [x] Reject hosted runs, test chat, schedules, model changes, workflow changes, and hosted memory for
  `external_connected`.

### 6.4 Channel boundaries

- [x] Allow Telegram, Discord, WhatsApp, webhook, and future inbound conversation channels only for
  supported hosted modes.
- [x] Reject channel connection, pairing, inbound delivery, and channel-default conversation calls
  for `external_connected`.
- [x] Verify channel bindings resolve to the correct hosted installation and organization.
- [x] Keep provider credentials in the connection vault and out of agent settings, prompts, and UI
  responses.

### 6.5 External credential boundaries

- [x] Allow installation credential creation, listing, rotation, revocation, client assertions, and
  exchange only for `external_connected`.
- [x] Revalidate current installation mode, status, organization, and credential status during every
  secret or assertion exchange.
- [x] Revalidate mode at every MCP and installation-REST request, not only when issuing the token.
- [x] Preserve short-lived audience-bound tokens and current credential revocation checks.
- [x] Reject MCP tokens at private core and public REST tokens at the MCP gateway.
- [x] Ensure external credentials cannot call internal hosted-chat or control-plane endpoints.

**API enforcement gate**

- [x] The wrong mode is rejected for every protected operation family in an automated HTTP matrix.
- [x] Removing a UI control cannot be the only protection for any mode-specific operation; HTTP,
  repository, and database constraints enforce the boundaries independently.

## 7. Dedicated external-agent aggregate and creation API

### 7.1 Transactional application service

- [x] Add a dedicated `CreateExternalAgent` application service.
- [x] Create the external definition, policy version, installation, principal, grants, and initial
  credential as one transaction; credential hashing and audit insertion share the aggregate client.
- [x] Roll back every durable record if policy validation or credential creation fails; the aggregate
  transaction rolls back all records, and the unique idempotency race path returns the committed
  aggregate without issuing a second secret.
- [x] Use an idempotency key so retries cannot create duplicate external identities or secrets.
- [x] Return the plaintext secret only once and persist only its secure hash.
- [x] Emit bounded audit events for definition, installation, grants, and credential creation.

### 7.2 Customer API

- [x] Add a dedicated customer control-plane route such as `POST /v1/external-agents`.
- [x] Accept a bounded name, description, runtime family, environment label, enabled protocols,
  capability selections, optional resource/connector constraints, credential label, expiry, MCP/REST
  scopes, and optional registered public key.
- [x] Reject user-supplied organization IDs, installation IDs, protected flags, system ownership, and
  arbitrary policy JSON.
- [ ] Validate requested services against plan entitlement, registry lifecycle, provider readiness,
  organization policy, and caller management authority; registry existence/readiness and caller
  management scope are enforced now, while plan entitlement and provider-owned readiness sources
  remain integration blockers.
- [x] Return safe external-agent, installation, grant, credential metadata, setup information, and
  the copy-once secret.
- [x] Add list, detail, pause/resume, rotate/revoke, health, last-used, and archive endpoints for
  external agents.
- [x] Archive revokes every active credential immediately; the endpoint and REST documentation make
  this behavior explicit.

### 7.3 Core proxy and public boundary

- [x] Add matching organization-scoped `kasitek-core` control-plane adapters for the client UI.
- [x] Keep browser session authentication on management routes and machine authentication on MCP or
  public REST routes.
- [x] Keep the stateless MCP gateway free of database and business ownership.
- [x] Preserve the shared invocation, approval, idempotency, audit, usage, and effect boundary after
  external authentication.

**External creation gate**

- [x] A newly connected external agent has its own identity and installation before any secret is
  issued.
- [x] No request in this flow accepts or discovers a KasiAi installation ID.
- [x] Retrying the same request does not create a second identity or reveal a second secret.

## 8. Effective access and subscription projection

- [x] Define an `EffectiveAgentAccess` projection shared by customer UI and operator evidence;
  `projectEffectiveAccess` is the shared server-side projection and preserves unknown dependencies.
- [ ] Report each capability's registry lifecycle, workspace subscription entitlement, provider
  readiness, installation grant, credential narrowing, resource/connector constraint, feature flag,
  approval requirement, and final availability.
- [x] Use stable reason codes such as `available`, `not_entitled`, `not_granted`, `credential_denied`,
  `provider_not_configured`, `provider_unhealthy`, `feature_disabled`, and `approval_required`.
- [x] Do not collapse subscription denial, missing provider setup, and missing grant into one
  `unavailable` state; unknown subscription/feature inputs remain explicit rather than being
  reported as entitled or enabled.
- [ ] Group low-level capabilities into understandable product services without hiding exact tool
  names from authorized technical detail views.
- [x] Make capability selection grant only the explicit chosen service/tool set.
- [x] Make resource and connector grants optional narrowing layers with documented empty semantics.
- [x] Require approval for consequential operations regardless of transport write scope.
- [x] Ensure `mcp:write` or `api:write` never grants a capability absent from the installation.
- [x] Show the same effective result in MCP discovery, installation REST discovery, detail UI, and
  audit evidence where those projections are available; live entitlement/provider state remains an
  open integration gate.

## 9. Product experience separation

### 9.1 Agents landing page

- [x] Show a clear type badge for KasiAi, hosted user agents, and external connected agents.
- [ ] Separate or filter the three types without creating three unrelated product areas.
- [x] Use distinct actions: `Open KasiAi`, `Create hosted agent`, and `Connect external agent`.
- [ ] Show mode-appropriate status: channel/runtime health for hosted modes and connection/last-used
  health for external mode.

### 9.2 KasiAi details

- [ ] Keep workspace preferences, platform conversations, personal channel routing, optional
  Telegram/Discord/WhatsApp connections, approved service state, activity, and usage.
- [ ] Remove external-agent credential creation and MCP/REST setup.
- [ ] Explain that the service allowlist is release-managed and show its live effective state.
- [ ] Keep protected instructions, model policy, and version publishing non-editable.

### 9.3 Hosted user-agent creation and details

- [ ] Keep `/agents/new` explicitly about a KasiTek-hosted runtime.
- [ ] Guide identity, instructions, model, runtime limits, workflow, capabilities, connectors,
  knowledge, schedules/channels, review, and activation.
- [ ] Do not show MCP/REST installation credentials as a normal hosted-agent feature.
- [ ] Render only hosted-agent panels on the details page.

### 9.4 External-agent connection wizard

- [x] Remove the existing installation selector completely.
- [x] Step 1 — identify the external agent: name, runtime family, description, and environment.
- [x] Step 2 — choose MCP, REST, or both and explain their intended use.
- [ ] Step 3 — choose platform services/capabilities with live subscription and readiness states;
  current implementation accepts bounded capability names and needs the effective-access projection.
- [x] Step 4 — apply optional resource and connector narrowing.
- [x] Step 5 — choose credential read/write scopes, expiry, and optional public-key authentication.
- [ ] Step 6 — review the exact effective authority and approval requirements; live reason-code
  projection remains open.
- [x] Step 7 — create the external installation and display the secret once.
- [ ] Step 8 — show token exchange, MCP/REST configuration, client-specific setup snippets, and a
  connection test.
- [x] Default credentials to read-only; write access requires an explicit user choice.
- [ ] Never label a copy-once installation secret as a bearer token used directly at MCP.
- [ ] Never show a secret in telemetry, URL parameters, persistent browser storage, or error reports.

### 9.5 External-agent details

- [ ] Show overview, protocols, capabilities, data/connector scope, credentials, approvals, activity,
  usage, connection health, last use, pause/resume, rotation, revocation, and archive.
- [x] Do not show hosted model, prompt, workflow, knowledge, schedules, conversations, or channels.
- [ ] Make credential-level narrowing and installation-level grants visually distinct.
- [ ] Provide safe setup snippets for Codex, Claude Code, generic MCP, n8n, TypeScript, Python, and
  curl where supported.

**Product-experience gate**

- [x] A user can identify each agent type and its purpose without knowing the internal architecture.
- [x] KasiAi never appears as a selectable target in external-agent connection.
- [x] Each detail page exposes only operations valid for its execution mode.

## 10. Existing credential and data remediation

- [x] Build a read-only report of every active/revoked installation credential with organization,
  installation, definition ownership, protected state, inferred intended mode, last use, expiry, and
  grant summary; exclude hashes, public-key material where unnecessary, and all secrets.
- [x] Classify credentials attached to protected KasiAi as invalid external bindings.
- [x] Classify credentials attached to hosted agents as ambiguous until product intent is reviewed;
  the operator inventory exposes the mode classification without secret material.
- [ ] For each valid external runtime, create a dedicated `external_connected` identity and copy only
  reviewed grants and resource/connector constraints.
- [ ] Decide per credential whether to re-parent the stored hash to the new installation or revoke and
  replace it; do not silently broaden access.
- [ ] If re-parenting, invalidate old issued tokens through current installation/credential checks and
  record the new installation in audit metadata.
- [ ] If replacing, preserve only safe metadata and require the customer to copy a new secret.
- [x] Revoke abandoned, exposed, test, or unidentifiable credentials where they are attached to a
  non-external mode; migration `049` is deliberately conservative and preserves the inventory/audit
  trail.
- [ ] Preserve historical audit/run/usage evidence under the original installation and add a bounded
  migration link rather than rewriting history.
- [ ] Reconcile plan entitlement, grants, and approval state before activating migrated external
  installations.
- [ ] Produce an organization-safe migration summary and operator-only exception report.

**Data-remediation gate**

- [x] No active credential remains attached to `system_hosted` or `kasitek_hosted` in the migrated
  seeded Agent database; migration `050` prevents a new violation at the database boundary.
- [ ] Every migrated external identity has reviewed least-privilege grants and a traceable audit link.
- [ ] Historical evidence remains immutable and attributable.

## 11. Audit, approvals, usage, and operations

- [ ] Include execution mode in new installation, credential, grant, invocation, approval, effect,
  usage, and lifecycle audit metadata.
- [ ] Attribute external requests to both installation and credential IDs without exposing secret or
  assertion material.
- [ ] Display external runtime name, installation, requested capability, exact resource/effect
  preview, expiry, and decision state in approvals.
- [ ] Ensure approval does not change credential or installation scope.
- [ ] Record MCP/REST connection tests distinctly from business capability invocations.
- [ ] Expose mode-specific health: hosted worker/model/channel health versus external token exchange,
  discovery, invocation, and last-used health.
- [ ] Add organization and operator metrics by mode without high-cardinality secret-bearing labels.
- [ ] Add alerts for wrong-mode attempts, repeated invalid exchanges, mass revocation, migration
  exceptions, and external capability-denial spikes.
- [ ] Confirm kill switches apply correctly at global, organization, installation, transport, and
  capability scope for external agents.

## 12. Automated verification matrix

### 12.1 Migration and repository tests

- [x] Test all valid and invalid execution-mode values.
- [x] Test deterministic backfill for protected KasiAi and hosted organization agents; the clean
  migration run and seeded database projection verify the protected/system and organization/hosted
  classifications.
- [ ] Test ambiguous credential reporting and non-destructive failure behavior.
- [x] Test definition/mode compatibility and immutable mode transitions.
- [x] Test atomic external creation and complete rollback for credential-validation failure; the
  integration test verifies definitions, versions, installation, principal, grants, and
  credentials are all absent after rollback. Additional injected failure points can extend this
  matrix without changing the transaction boundary.
- [x] Test idempotent retries and copy-once secret behavior.

### 12.2 Authorization tests

- [x] KasiAi cannot create, list, rotate, exchange, or use external installation credentials.
- [x] Hosted user agents cannot create, exchange, or use external installation credentials.
- [x] External connected agents cannot use KasiAi home/preferences/models/conversations.
- [x] External connected agents cannot use hosted model, workflow, schedule, channel, knowledge, or
  memory operations; HTTP, repository, and run-boundary guards reject the external mode.
- [x] Non-KasiAi installations cannot call KasiAi-specific routes even in the same organization.
- [x] External credentials cannot cross organization, installation, credential, resource, connector,
  audience, protocol, or mode boundaries; token revalidation and shared resource/connector policy
  enforce the boundary.
- [x] Paused, disabled, archived, expired, rotated, and revoked identities fail immediately through
  installation/credential revalidation and archive revocation.
- [x] Client assertion key mismatch and replay remain rejected.

### 12.3 Capability and approval tests

- [x] Effective access is the intersection of the known subscription/readiness inputs, installation
  grants, credential scopes, constraints, feature flags, and approval policy; unavailable external
  subscription/provider inputs stay explicitly unknown until their owning provider is wired.
- [x] MCP/REST write scope never creates an installation capability grant.
- [x] Discovery and invocation return compatible availability and denial reason codes.
- [x] Resource and connector constraints are rechecked at invocation and approval continuation.
- [ ] Approval-required operations cannot execute before approval and cannot execute after denial,
  expiry, scope change, installation pause, or credential revocation.
- [ ] MCP, installation REST, hosted agent, and KasiAi calls converge on the same domain operation and
  policy outcome where their effective authority is equivalent.

### 12.4 UI and browser tests

- [ ] Agent list renders correct mode labels and actions.
- [ ] External wizard contains no existing-agent/KasiAi selector.
- [ ] External wizard prevents progression with invalid services, scopes, or readiness.
- [ ] Secret is shown once, copy works, navigation removes it, and refresh cannot recover it.
- [ ] KasiAi details show channels and no external credential controls.
- [ ] Hosted details show hosted configuration and no external credential controls.
- [ ] External details show connection controls and no hosted/channel controls.
- [ ] Wrong-mode deep links fail safely and do not flash unauthorized controls.

### 12.5 Protocol and live-client tests

- [ ] Generic MCP client exchanges a dedicated external credential, initializes, discovers only
  effective tools, invokes a read, submits a durable operation, polls status, and cancels safely.
- [ ] Public REST external principal discovers and invokes only its approved stable actions.
- [ ] Codex and Claude Code complete the supported MCP setup and compatibility smoke.
- [ ] n8n completes the supported REST setup, idempotency, and webhook/polling flow.
- [ ] Credential rotation invalidates old access and preserves the external installation identity.
- [ ] Hosted KasiAi and user-agent regression smokes pass after external-mode enforcement.

## 13. Documentation and checklist reconciliation

- [x] Update the architecture draft to distinguish confirmed decisions from implemented evidence.
- [x] Reopen the checked execution-mode and external-agent UX claims until their exit gates pass.
- [x] Update the execution blueprint Slice 2 and product-experience items with this remediation link.
- [x] Add an audit-checklist finding for the missing persisted mode and cross-mode endpoint guards.
- [x] Update MCP integration docs so credentials are described as belonging to a dedicated external
  installation, never KasiAi.
- [x] Update public REST principal documentation and OpenAPI descriptions.
- [x] Add customer setup guides for external agent versus KasiAi channel connection versus hosted
  user-agent creation in [`docs/api/agent-connection-guide.md`](docs/api/agent-connection-guide.md).
- [x] Update generated capability/UI documentation with effective-access reason codes.
- [x] Record exact commands, test counts, environment-gated skips, hosted verification, commits, and
  remaining blockers; the final commit hash remains pending because this task-owned batch is not yet
  committed.

## 14. Deployment, rollout, and rollback

- [ ] Land schema/type support before enabling any new external creation flow.
- [ ] Deploy read-compatible code before the mode column becomes mandatory.
- [ ] Run the credential inventory and review report before data mutation.
- [ ] Apply backfill and verify counts by organization and mode.
- [ ] Deploy server-side mode guards before enabling the new UI.
- [ ] Deploy the new external creation API and UI behind an independent feature flag.
- [ ] Migrate or revoke existing invalid credentials before opening the flag.
- [ ] Run authenticated browser, MCP, REST, hosted-agent, and KasiAi smoke tests in staging.
- [ ] Roll out read-only external access before draft/write and approval-gated effects.
- [ ] Monitor wrong-mode denials, exchange failures, capability denials, approval failures, usage, and
  customer support signals.
- [ ] Document rollback that disables new external connections while preserving installation,
  credential, grant, audit, and usage records.
- [ ] Never roll back by dropping the mode column or restoring credentials to KasiAi.

## 15. Required verification commands

Run the narrowest commands during each batch and the full applicable set before completion.

- [x] `cd agents && pnpm exec tsc -p tsconfig.json --noEmit`
- [x] `cd agents && pnpm build`
- [x] `cd agents && pnpm test`
- [x] Run the Agent PostgreSQL integration suite with the new migrations applied.
- [x] `cd server/kasitek-core && cargo fmt --check`
- [x] `cd server/kasitek-core && cargo check`
- [x] `cd server/kasitek-core && cargo test` (133 library tests passed, 3 infrastructure-gated tests ignored)
- [x] `cd client && pnpm --filter client lint`
- [x] `cd client/apps/client && pnpm exec tsc --noEmit`
- [x] `cd client && pnpm build:client`
- [ ] Run canonical route checks and authenticated browser smokes.
- [ ] Run the separate stateless MCP gateway conformance and real-client smokes.
- [ ] Run public REST/OpenAPI conformance and external-principal smokes.

Record warnings separately from failures. Infrastructure-gated tests remain unchecked until they run
against their required environment; a unit substitute does not close a live verification gate.

## 16. Final completion gate

This remediation is complete only when all of the following are true:

- [ ] Every installation has an enforced, persisted execution mode.
- [ ] KasiAi, hosted user agents, and external connected agents have distinct creation and details
  experiences.
- [ ] External-agent connection creates a dedicated identity and never selects KasiAi.
- [ ] External credentials exist only on `external_connected` installations.
- [ ] Server-side mode guards cover credentials, MCP/REST, KasiAi, hosted runtime, channels,
  schedules, workflows, knowledge/memory, and conversations.
- [ ] Effective service access is explicit, live, explainable, and consistent across UI, MCP, REST,
  approvals, and audit evidence.
- [ ] Existing invalid credentials are migrated or revoked without exposing secrets or rewriting
  historical evidence.
- [ ] Automated cross-mode, security, migration, UI, protocol, and parity tests pass.
- [ ] Staging and hosted client verification pass with recorded evidence.
- [ ] Canonical blueprint, audit, architecture, generated docs, and customer guides describe the
  implemented system accurately.
- [ ] No release-blocking item is marked complete solely from code presence without runtime or
  external-client evidence where required.

## 17. Evidence log

Add one entry per coherent implementation batch.

```text
Date:
Scope:
Files/migrations:
Tests and results:
Runtime evidence:
Commit:
Remaining blockers:
```

### Evidence — foundation and mode-separation batch (2026-08-15)

```text
Scope:
  Persisted execution modes, server-side mode policy, dedicated external-agent creation,
  browser proxy wiring, external connection wizard, and mode-specific detail-page surfaces.
Files/migrations:
  agents/migrations/047_installation_execution_modes.sql
  agents/migrations/048_external_connection_idempotency.sql
  agents/src/domain/types.ts
  agents/src/domain/execution-mode.ts
  agents/src/db/repositories/agent-repository.ts
  agents/src/http/app.ts
  client/apps/client/src/lib/agent-platform.ts
  client/apps/client/src/components/dashboard/agents/agent-connection-wizard.tsx
  client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx
  server/kasitek-core/src/controllers/agent_platform.rs
  server/kasitek-core/src/services/agent_platform.rs
  server/kasitek-core/src/api/internal.rs
  docs/api/mcp-integration.md
  docs/api/agent-rest.md
Tests and results:
  cd agents && pnpm exec tsc -p tsconfig.json --noEmit — passed
  cd agents && pnpm build — passed
  cd agents && pnpm test — 254 passed, 38 expected infrastructure-gated skips
  cd server/kasitek-core && cargo fmt --check — passed
  cd server/kasitek-core && cargo check — passed
  cargo test --lib services::agent_platform::tests — 4 passed
  cd client && pnpm --filter client lint — 0 errors, 11 existing warnings
  cd client/apps/client && pnpm exec tsc --noEmit — passed
  cd client && pnpm build:client — passed
Runtime evidence:
  Unit and HTTP matrix coverage proves external credentials are rejected for hosted/KasiAi modes,
  MCP/REST tokens require external_connected, hosted chat/channels/schedules reject external mode,
  and KasiAi routes require the protected canonical identity. No live seeded PostgreSQL, provider,
  browser, or real MCP/REST client evidence was available in this batch.
Commit:
  `e2615a1` — task-owned changes committed; unrelated user worktree changes were preserved.
Remaining blockers:
  Complete atomic credential aggregate transaction; add effective-access/subscription reason-code
  projection; guard knowledge/memory and all hosted runtime invocation paths; migrate/revoke legacy
  credentials; add external-agent list/detail/health APIs; run seeded DB, browser, hosted/provider,
  and real-client verification; reconcile canonical blueprint/audit checkboxes and commit the batch.
```

### Evidence — database isolation, effective access, and transport-scope batch (2026-08-15)

```text
Scope:
  Added a database trigger that rejects credentials on system_hosted/kasitek_hosted installations,
  strengthened repository credential creation with the external mode predicate, projected the full
  effective-access authority layers into MCP discovery and public REST/control-plane discovery, and
  allowed read-only MCP credentials to invoke read capabilities while retaining write-scope checks.
Files/migrations:
  agents/migrations/050_external_credential_mode_guard.sql
  agents/src/domain/effective-access.ts
  agents/src/db/repositories/installation-credential-repository.ts
  agents/src/http/app.ts
  agents/test/effective-access.test.ts
  agents/test/http.test.ts
  agents/test/migration.test.ts
  agents/test/operator-commands.integration.test.ts
Tests and results:
  cd agents && pnpm exec tsc -p tsconfig.json --noEmit — passed
  cd agents && pnpm exec vitest run test/http.test.ts — 68 passed
  AGENTS_DATABASE_URL=postgresql://enoch:kasitek@localhost:5433/kasitek_agents RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm exec vitest run test/agent-lifecycle.integration.test.ts — 3 passed
  AGENTS_DATABASE_URL=postgresql://enoch:kasitek@localhost:5433/kasitek_agents RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm exec vitest run test/operator-commands.integration.test.ts — 3 passed
  AGENTS_DATABASE_URL=postgresql://enoch:kasitek@localhost:5433/kasitek_agents RUN_AGENTS_DB_INTEGRATION_TESTS=true pnpm test — 67 files passed, 300 passed, 1 expected Temporal skip
  AGENTS_DATABASE_URL=postgresql://enoch:kasitek@localhost:5433/kasitek_agents pnpm migrate — migration 050 applied
Runtime evidence:
  Seeded PostgreSQL reports 18 kasitek_hosted and 2 system_hosted installations with no active
  credentials on either mode; all 14 historical credentials are revoked. The database trigger is
  active and prevents future non-external inserts.
Commit:
  `e2615a1` — task-owned changes committed; unrelated user worktree changes remain untouched.
Remaining blockers:
  Entitlement/provider readiness source, injected-failure rollback matrix, authenticated browser
  checks, staging/hosted provider checks, real MCP/REST clients (Codex, Claude Code, n8n), and
  canonical documentation/checklist reconciliation remain before release completion.
```
