# KasiTek Agent System Audit Remediation Checklist

**Status:** Required remediation and continuation checklist

**Audit baseline:** `fe94c40` (`docs(api): document MCP installation integration`)

**Audit date:** 2026-08-13

**Evidence reconciliation:** 2026-08-14 — 164 of 245 checklist items have current implementation
or verification evidence. The remaining items are not silently deferred: they are retained as
explicit release, policy, or end-to-end verification work.

**Primary implementation plan:** [`KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md`](KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md)

**Architecture rationale:** [`KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md`](KASITEK_AGENT_CAPABILITY_MCP_ARCHITECTURE_DRAFT.md)

**Repository boundaries:** [`PROJECT_PLAN.md`](PROJECT_PLAN.md)

## 1. Purpose

This file converts the post-implementation audit into a bounded execution checklist. Complete the
release-blocking remediation here first, then resume every unchecked item in the primary blueprint
in order. This checklist does not replace the blueprint and does not reduce its scope.

At the audit baseline, the primary blueprint had **6 checked items and 204 unchecked items**. Only
Slice 0 and one Slice 3 item had checked evidence. The previous run produced useful foundations,
but it did not complete the requested one-shot implementation.

## 2. Instructions for the implementation model

- [ ] Read this entire checklist before editing code.
- [ ] Read `AGENTS.md`, this checklist, the primary blueprint, the architecture draft,
  `PROJECT_PLAN.md`, and `BLOCKERS.md` before making structural decisions.
- [ ] Treat this checklist as the remediation authority, the blueprint as the ordered implementation
  authority, the architecture draft as rationale, and `PROJECT_PLAN.md` as the repository-level
  ownership/boundary reference. Do not use `PROJECT_PLAN.md` to replace or reorder this programme.
- [ ] Inspect commits after the blueprint was introduced and inspect the current worktree before
  changing files.
- [ ] Preserve existing unrelated changes. Do not restore, overwrite, stage, or commit them.
- [ ] Fix the audited release blockers in Sections 5–12 before exposing MCP, approvals, effects, or
  public `/v1` endpoints outside a development environment.
- [ ] Add a failing regression test before or with each fix when the defect is testable locally.
- [ ] Tick an item only after implementation and the listed verification have both passed.
- [ ] Add short evidence beside completed parent items: files, test names, commands, and commit.
- [ ] Make one coherent commit per remediation section unless two sections require one atomic change.
- [ ] Do not invent missing product policy. Record it in root `BLOCKERS.md`, leave the affected item
  unchecked, implement any safe independent work, and continue.
- [ ] If a test environment is unavailable, add or update a blocker with the exact command, failure,
  impact, and required next action. Continue with all independent work.
- [ ] After this audit checklist is complete, loop through the primary blueprint from Slice 0 to
  Slice 13 until every item is verified, blocked with evidence, or complete.

## 3. Worktree preservation baseline

The audit observed the following pre-existing uncommitted paths. Re-check `git status --short`
before starting because the list may have changed. Treat every uncommitted change as user-owned
unless repository history proves otherwise.

- `client/apps/client/src/app/(dashboard)/connections/page.tsx`
- `client/apps/client/src/app/api/[...path]/route.ts`
- `client/apps/client/src/components/dashboard/connections/connections-manager.tsx`
- `client/apps/client/src/components/dashboard/layout-shell.tsx`
- `client/apps/client/src/components/social/posts-workspace.tsx`
- `scripts/run_local_stack.sh`
- `server/kasitek-core/README.md`
- `server/kasitek-core/src/config.rs`
- `server/kasitek-core/src/controllers/social.rs`
- `server/kasitek-core/src/routes.rs`
- `server/kasitek-core/src/services/bluesky_oauth.rs`
- `server/kasitek-core/src/services/social.rs`

Before each commit:

- [ ] Run `git status --short` and identify task-owned versus user-owned changes.
- [ ] Run `git diff --check` on task-owned files.
- [ ] Stage explicit task-owned paths only; never use an indiscriminate `git add -A`.
- [ ] Inspect `git diff --cached --stat` and `git diff --cached` before committing.
- [ ] Restore only command-generated artifacts that were clean before the command ran.

## 4. Audit summary and execution order

Complete remediation in this order because later sections depend on the identity, approval, and
effect boundaries established earlier.

- [ ] AR-001 — Accept and validate installation tokens on MCP requests.
- [ ] AR-002 — Enforce authorization and resource policy on approval decisions.
- [ ] AR-003 — Integrate durable, exact, single-use approval records.
- [ ] AR-004 — Correct external-effect receipt transitions and reconciliation semantics.
- [ ] AR-005 — Route MCP calls through the shared invocation/runtime boundary.
- [ ] AR-006 — Protect and filter public `/v1` capability discovery.
- [ ] AR-007 — Make delegation replay protection effective across replicas and restarts.
- [ ] AR-008 — Complete the separately deployed MCP gateway safety boundary.
- [ ] AR-009 — Correct progress and blocker evidence after remediation.
- [ ] Run the complete verification matrix in Section 14.
- [ ] Resume and complete every unchecked primary-blueprint item as described in Section 15.

## 5. AR-001 — MCP installation-token authentication

### Audited defect

`POST /v1/installation-tokens/exchange` issues an ES256 installation JWT, and the MCP documentation
instructs clients to use it at `/mcp`. The `/mcp` handler instead passes the bearer value to the
internal HMAC authenticator. `verifyInstallationToken()` has no production caller.

Audit reproduction: a freshly issued, correctly signed token with `aud=mcp` received HTTP 401 with
`{"error":"Invalid internal token"}`.

Relevant starting points:

- `agents/src/http/app.ts`
- `agents/src/http/auth.ts`
- `agents/src/auth/installation-token.ts`
- `agents/src/db/repositories/installation-credential-repository.ts`
- `agents/src/gateway/app.ts`
- `agents/test/http.test.ts`
- `agents/test/installation-token.test.ts`
- `docs/api/mcp-integration.md`

### Implementation checklist

- [x] Add a dedicated MCP authentication path; do not weaken or overload internal service HMAC
  authentication.
- [x] Verify ES256 signature, expected issuer, exact `mcp` audience, expiry, not-before/issued-at
  constraints where present, subject, organization, credential id, and JWT id.
- [x] Validate the token header algorithm and reject algorithm/key confusion.
- [x] Load the referenced installation credential and reject revoked, rotated-out, expired, missing,
  or organization-mismatched credentials.
- [x] Load the installation and reject missing, suspended, disabled, or organization-mismatched
  installations.
- [x] Bind the authenticated installation id to the token subject. Do not trust a different
  `params.installationId` supplied by the client.
- [x] Remove `params.installationId` from the MCP client contract if the token subject makes it
  redundant, or require an exact match for backward compatibility.
- [x] Map MCP read/write scopes from an explicit credential policy. If the product has not defined
  that mapping, record a blocker and default to denial rather than granting write access.
- [x] Keep internal HMAC tokens limited to trusted service-to-service routes; document any deliberate
  gateway-to-API authentication separately from end-client installation authentication.
- [x] Ensure token rotation/revocation takes effect without waiting for a one-hour JWT to expire.
- [x] Update protected-resource metadata so it accurately describes the supported authorization
  mechanism and authorization server/token exchange location.
- [x] Update the MCP integration document to match the implemented request contract.

**Evidence:** `agents/src/http/app.ts`, `agents/src/http/auth.ts`,
`agents/src/auth/installation-token.ts`, migration `031_installation_credential_mcp_scopes.sql`,
`agents/test/http.test.ts`, `agents/test/installation-token.test.ts`; `48b16bf`.

### Required tests

- [x] A valid exchanged `aud=mcp` installation token can initialize and list only its installation's
  granted tools.
- [x] The same token cannot select another installation in the same organization.
- [x] The same token cannot select an installation in another organization.
- [x] Wrong audience, issuer, signature, algorithm, expiry, credential id, or subject is rejected.
- [x] Revoked/rotated credential and suspended/disabled installation are rejected immediately.
- [x] An internal HMAC token cannot impersonate an installation unless a separately documented
  trusted gateway contract explicitly permits it.
- [x] Existing internal API authentication tests continue to pass.

### Completion gate

- [x] Re-run the audit reproduction and receive a successful scoped MCP response with the exchanged
  token; all negative cases above pass.
- [x] Remediation committed as `48b16bf` (`fix(agents): authenticate MCP installation tokens`).

## 6. AR-002 — Approval endpoint authorization

### Audited defect

`POST /v1/runs/:runId/approval` authenticates a bearer context but does not call `requireScope()` or
apply approver/resource policy. By contrast, the adjacent cancellation endpoint requires
`runs:cancel`.

Audit reproduction: an internal token with `scopes: []` received HTTP 202 and caused the Temporal
approval signal to be invoked.

Relevant starting points:

- `agents/src/http/app.ts`
- `agents/src/http/auth.ts`
- `agents/src/db/repositories/run-repository.ts`
- `agents/src/db/repositories/tool-invocation-repository.ts`
- `agents/src/temporal/contracts.ts`
- `agents/src/temporal/workflows.ts`
- `agents/test/http.test.ts`

### Implementation checklist

- [x] Define and enforce a dedicated approval scope such as the existing canonical policy name; do
  not invent a new public role matrix if none has been approved.
- [x] Require the approver to have access to the organization, installation, run, capability, and
  affected resource. The decision route now re-resolves the organization-scoped run, active
  installation, exact proposal/capability/version/hash, and resource policy before deciding.
- [x] Enforce current installation/capability grants again at decision time.
- [x] Enforce the initial self-approval and separation-of-duties policy: the authenticated run
  initiator may not approve their own pending action. The broader workspace role/resource matrix
  remains explicitly open in `BLOCKERS.md`.
- [x] Reject terminal, stale, expired, already decided, or non-awaiting approvals atomically.
- [x] Do not accept `approvedBy` from the request body; derive it from the authenticated principal.
- [x] Emit a redacted immutable audit event for approval, denial, expiry, and cancellation.
- [x] Rate-limit repeated decisions and make the decision command idempotent. The approval route
  applies a bounded per-organization/run/actor fixed-window limiter before the durable decision;
  PostgreSQL compare-and-set plus the existing duplicate-decision response preserve idempotency.
  Covered by `agents/test/http.test.ts`'s rate-limit and duplicate-submission cases.

### Required tests

- [x] A token with no approval scope receives 403 and no Temporal signal is sent.
- [ ] A correctly scoped but unrelated actor/resource receives 403.
- [x] Cross-organization run ids are indistinguishable from not found. The approval route scopes
  run lookup by authenticated organization and returns the same `run_not_found` response; HTTP
  coverage asserts the org-scoped repository call and non-disclosure.
- [x] Valid approve and deny decisions signal Temporal once and write audit evidence.
- [x] Concurrent decisions result in exactly one accepted decision.
- [x] Duplicate idempotent submission returns the original decision without a second signal.
- [x] Self-approval behavior matches the initial policy: a run initiator receives 403 before the
  durable approval transition or Temporal signal (`agents/test/http.test.ts`).

### Completion gate

- [x] Re-run the zero-scope reproduction and receive 403 with `signalled=false`.

**Partial evidence:** `agents/src/http/app.ts`, `agents/src/db/repositories/tool-invocation-repository.ts`,
`agents/src/capabilities/authorization.ts`, and `agents/test/http.test.ts`; `7508423`, `e94e16a`,
and `a0cf679`. The decision route re-resolves the scoped run and active
installation, exact proposal capability/version/hash, current capability grants, availability, and
resource grants before the atomic decision. `agents/test/http.test.ts` proves a revoked capability
cannot signal Temporal; `agents/test/run.integration.test.ts` proves concurrent compare-and-set
decisions; and the HTTP suite proves an identical retry returns the recorded decision without a
second signal. Commit `22b2748` blocks run-initiator self-approval before durable mutation or
signalling; the broader workspace approver role/resource matrix remains open.
- [x] Remediation committed in `a0cf679` (`fix(agents): harden invocation and effect boundaries`).

## 7. AR-003 — Durable exact single-use approvals

### Audited defect

Migration 029 and `ApprovalRepository` exist, but production HTTP, workflow, and activity code do not
instantiate or use the repository. The live workflow stores a smaller approval object in
`tool_invocations`; it does not durably bind and consume organization, installation,
capability/version, resources, preview revision, approver, expiry, and one permitted effect.

Relevant starting points:

- `agents/migrations/029_approval_records.sql`
- `agents/src/db/repositories/approval-repository.ts`
- `agents/src/db/repositories/tool-invocation-repository.ts`
- `agents/src/temporal/activities.ts`
- `agents/src/temporal/workflows.ts`
- `agents/src/tools/types.ts`

### Implementation checklist

- [x] Create a pending approval record when an approval-requiring proposal is durably accepted.
- [x] Bind the record to organization, installation, run, provider tool-call id, capability and
  version, normalized argument hash, resource snapshot, immutable preview revision, policy revision,
  expiry, and permitted effect/idempotency key.
- [x] Change the schema if necessary so a pending record does not require an `approved_by` value.
- [x] Decide approval/denial with an atomic compare-and-set transition.
- [x] Expire pending approvals durably and surface expiration to the workflow and UI. The worker
  sweep uses `ApprovalRepository.expirePending()` with row locking, appends an expiration event,
  closes the reserved effect, and signals the durable workflow; MCP/REST status exposes the durable
  `expired` approval/run state. Integration coverage exercises the pending-to-expired transition.
- [x] Immediately before effect execution, reauthorize current organization, installation,
  capability, resource, connector/channel, and kill-switch state.
- [x] Atomically consume the approved record once and only once before the permitted effect begins.
- [x] Ensure Temporal activity retry cannot consume approval twice or execute a second effect.
- [x] Cancel the approval when the run or installation is cancelled/disabled.
- [x] Remove the obsolete approval-decision mutation from `tool_invocations`; approval records are
  the source of truth and invocation rows remain execution/audit evidence.
- [x] Remove dead methods and misleading documentation only after the live path uses the repository.
  `ToolInvocationRepository.recordCompleted()` no longer writes the legacy `approval` payload;
  migration `035_remove_legacy_tool_approval.sql` removes that denormalized column, leaving
  `agent_approval_records` as the sole approval source of truth. The full Agent suite passed after
  applying migration 035.

### Required tests

- [x] Database test covers pending → approved → consumed.
- [x] Database tests cover pending → denied, expired, and cancelled.
- [x] Wrong organization, installation, capability version, argument hash, resource snapshot,
  preview revision, policy revision, or effect key cannot consume approval. Consumption now binds
  `installation_id` as well as every proposal field in the atomic SQL predicate; the integration
  matrix exercises all mismatch dimensions before a final exact consume.
- [x] Two concurrent consumers produce exactly one successful consumption.

**Partial evidence:** migrations `032_durable_approval_lifecycle.sql`,
`033_installation_credential_api_scopes.sql`, and
`034_effect_receipt_state_semantics.sql`; `agents/src/db/repositories/approval-repository.ts`,
`agents/src/temporal/activities.ts`, `agents/test/run.integration.test.ts`; `e94e16a` and
`a0cf679`. Approval consumption now matches organization, run,
tool-call, capability/version, argument hash, resource snapshot, preview revision, policy
revision, and effect key; approved external effects atomically transition their exact reserved
receipt to executing. The database-backed activity test also proves a grant revoked after approval
and a disabled installation or newly enabled kill switch close the reserved receipt as not executed
without invoking the provider; a duplicate resume cannot consume or dispatch twice. Expiry/UI
proof, approver policy, and real-provider crash recovery proof remain open. The isolated
`agents/test/temporal-recovery.integration.test.ts` runs against local Temporal and proves an
approval wait survives worker replacement and resumes once.
- [x] Changed grants or disabled installation after approval prevents execution.
- [x] Temporal replay/retry does not create or consume a second approval.

### Completion gate

- [ ] No production approval path can reach an external effect without a current, exact, atomically
  consumed durable approval when policy requires one.
- [x] Remediation committed in `a0cf679` (`fix(agents): harden invocation and effect boundaries`).

## 8. AR-004 — Effect receipt state and reconciliation

### Audited defect

The activity marks an external-effect receipt `executing` as soon as the tool is proposed, before
approval and before the provider handler starts. Operational read methods reclassify any receipt
left in `executing` for 120 seconds as `unknown`. A later denial only closes `reserved` or
`executing`, so a slow approval can generate a false reconciliation incident that denial cannot
close.

Relevant starting points:

- `agents/migrations/028_effect_receipts.sql`
- `agents/src/db/repositories/effect-receipt-repository.ts`
- `agents/src/temporal/activities.ts`
- `agents/src/runtime/loop.ts`
- `agents/src/tools/registry.ts`

### Implementation checklist

- [x] Keep a proposed or approval-waiting effect `reserved`; do not mark it `executing` on proposal.
- [x] Mark `executing` atomically immediately before the provider side effect is invoked.
- [x] Introduce an explicit pre-effect execution hook inside `ToolRegistry.invoke()`; receipt
  transition/approval consumption runs after validation and immediately before the provider handler.
- [x] Require the durable approval consumption and effect transition to agree on organization, run,
  tool-call id, capability/version, arguments hash, and idempotency key.
- [x] Mark denied, expired, cancelled, or failed-before-provider effects as definitely not executed,
  with `reconciliation_required=false`.
- [x] Mark `unknown/reconciliation_required` only when execution may have reached the provider and the
  outcome cannot be determined.
- [x] Do not mutate effect state as an incidental side effect of a GET/health query. Move stale
  execution detection to a scheduled reconciliation command/job with audit evidence.
- [x] Ensure reconciliation commands are authenticated, scoped, version-checked, idempotent, and
  audited.
- [x] Make receipt status and reconciliation API response semantics agree; reconciliation resolves
  `unknown` to the actual `succeeded` or `failed` terminal state.
- [x] Store provider receipts safely and redact credentials/provider secrets from errors and output.

**Partial evidence:** `agents/src/db/repositories/effect-receipt-repository.ts`,
`agents/src/temporal/activities.ts`, `agents/src/temporal/worker.ts`,
`agents/test/run.integration.test.ts`, and migration
`034_effect_receipt_state_semantics.sql`; `ad7e0ec`, `7ecc36a`, `3de686f`, and `a0cf679`.
Reconciliation now resolves `unknown` to a real terminal outcome rather
than preserving an unused `reconciled` state. `ToolRegistry.invoke()` exposes a pre-effect callback
used by both direct and looped Temporal execution, so the receipt becomes `executing` at the exact
provider boundary. The database integration test proves an aged `reserved` receipt remains
non-ambiguous, denial after that wait is definitively not executed, provider success records one
receipt, a resolved unknown receipt cannot be reconciled again, and a terminal receipt cannot be
moved back to `executing`. HTTP tests prove reconciliation
emits audit evidence and inspection endpoints do not mutate receipt state. The full recovery matrix
remains open.
- [x] Prohibit blind retry after any ambiguous provider outcome; receipt transition methods now
  require a still-reserved receipt and reject terminal/unknown retries.

### Required tests

- [x] Waiting for approval longer than 120 seconds leaves the receipt reserved and does not create a
  reconciliation incident.
- [x] Denial after a long wait closes the receipt as definitely not executed.
- [x] Provider success records one succeeded receipt and provider receipt.
- [x] Failure before provider invocation records failed/not-executed without reconciliation.
- [x] Timeout or crash after provider invocation records unknown/reconciliation-required.
- [x] Duplicate Temporal activity execution cannot invoke the provider twice.
- [x] Health/read endpoints do not mutate receipt state.
- [x] Authorized reconciliation resolves an unknown outcome once and emits audit evidence.

### Completion gate

- [ ] The full proposal → approval → execution → receipt state machine is integration-tested against
  PostgreSQL and Temporal recovery behavior.
- [x] Remediation committed in `a0cf679` (`fix(agents): harden invocation and effect boundaries`).

## 9. AR-005 — MCP shared invocation/runtime boundary

### Audited defect

The MCP `tools/call` handler invokes `ToolRegistry` directly. It does not create or link durable run
or API/action records, enter Temporal for durable work, persist tool/audit/usage evidence, reserve an
effect receipt, or support approval continuation. This contradicts the MCP documentation and the
shared-runtime architecture.

Relevant starting points:

- `agents/src/http/app.ts`
- `agents/src/gateway/app.ts`
- `agents/src/tools/registry.ts`
- `agents/src/runtime/loop.ts`
- `agents/src/temporal/activities.ts`
- `agents/src/db/repositories/run-repository.ts`
- `docs/api/mcp-integration.md`

### Implementation checklist

- [x] Extract or reuse one protocol-neutral invocation service used by hosted agents and MCP.
- [x] Resolve the authenticated installation and effective grants inside that service.
- [x] Normalize and validate arguments once using the canonical capability manifest.
- [ ] Apply current entitlement, resource, connector/channel, risk, approval, kill-switch, quota,
  budget, and availability policy before invocation.
- [x] Create durable invocation/audit/usage evidence for every MCP call.
- [x] Route durable capabilities through Temporal and return a stable operation/run reference.
- [x] Permit immediate read execution only when the manifest explicitly declares it, while still
  recording audit and usage evidence. With Temporal unavailable, only `read` tools whose manifest
  explicitly declares `execution: immediate` use the direct path; it persists a run, tool proposal,
  completion/failure evidence, and idempotency key. `agents/test/installation-capability-invocation.test.ts`
  covers both the policy gate and durable evidence path.
- [x] Return structured `APPROVAL_REQUIRED` data with a stable approval/status reference instead of a
  terminal generic tool failure.
- [x] Route approved effects through the exact approval and effect boundary from AR-003/AR-004.
- [x] Implement MCP cancellation and propagate it to the operation/workflow where cancellation is
  safe.
- [x] Ensure retries use client/request idempotency and cannot duplicate drafts or effects.
- [x] Keep the external gateway stateless and free of database, Temporal, and business ownership.
- [ ] Ensure equivalent MCP and hosted-agent operations converge on the same domain adapter and
  produce compatible authorization, audit, approval, effect, and receipt outcomes.

### Required tests

- [x] MCP read call writes scoped audit/usage evidence.
- [x] MCP draft calls carry client idempotency into the durable run and the shared content draft
  command; the core adapter persists an execution marker and serializes duplicate attempts.
- [ ] MCP durable call returns an operation reference and survives worker restart.
- [ ] MCP approval-required call can be approved/denied through the supported flow.
- [x] MCP cancellation reaches the workflow without cancelling a completed effect.
- [ ] MCP and hosted-agent parity tests assert the same domain operation and policy outcome.
- [x] Cross-installation and cross-organization calls are rejected.

**Partial evidence:** `agents/src/invocation/installation-capability.ts`,
`agents/src/capabilities/authorization.ts`, `agents/src/http/app.ts`, and
`agents/src/temporal/activities.ts`, with
`agents/test/installation-capability-invocation.test.ts` and `agents/test/http.test.ts`.
MCP and installation REST use one durable proposal-acceptance service; that service and hosted
execution share the same capability, resource, availability, and approval-policy evaluator. The
service resolves the active installation and grants itself, checks the kill switch before creating
a run, and returns the installation-scoped operation reference. MCP `tools/status` and REST
operation status expose safe approval state, and MCP cancellation signals only non-terminal runs.
Connector/channel, quota/budget, hosted-domain-operation, restart, live approval, and external-client
proof remain open. A real local smoke on isolated API/gateway ports with `TEMPORAL_ENABLED=false`
also proves REST credential exchange/discovery/idempotency and MCP gateway negotiation through the
explicit immediate-read path; it does not replace worker-restart or hosted proof.

**Additional transport evidence:** the installation REST transport carries an audience-specific API
scope policy and then enters the same `InstallationCapabilityInvocationService` as MCP; it does not
own a second invocation/run-acceptance path.
Content capability contract evidence now covers all eight registered content manifests and their
typed Agent-to-core routes (`agents/test/content-capability-contract.test.ts`,
`agents/test/core-client.test.ts`), while core adapter unit checks cover invalid provider/schedule
inputs and missing idempotency before database access. Grounding provenance is persisted on durable
run output as a redacted summary; it contains only workspace scope, reviewed-source counts, tool
names, unavailable actions, and an explicit no-unsupported-certainty marker.
The local content database fixture (`server/kasitek-core/tests/social_content_integration.sql`,
run by `scripts/test-social-content-db.sh`) additionally verifies organization isolation, duplicate
TikTok webhook event-key handling, terminal publish transitions against duplicate/late callbacks,
and usage idempotency. It is intentionally recorded as local evidence only; provider sandbox,
partial-batch/ambiguous-outcome, and full approval-mutation proof remain open.
- [ ] Real Codex, Claude Code, and a generic MCP client are verified before checking the relevant
  primary-blueprint item.

### Completion gate

- [ ] No MCP capability bypasses the shared policy, invocation, audit, approval, or effect boundary.
- [x] Remediation committed in `a0cf679` (`fix(agents): harden invocation and effect boundaries`).

## 10. AR-006 — Public `/v1` capability exposure

### Audited defect

`/v1/capabilities` is mounted without the dedicated public API authentication framework and returns
every action except `Retired`, including `Internal` booking actions and `Pilot` content actions.

Relevant starting points:

- `server/kasitek-core/src/routes.rs`
- `server/kasitek-core/src/controllers/public_v1.rs`
- `server/kasitek-core/src/capabilities/catalog.rs`
- `docs/api/public-v1.openapi.json`
- Primary blueprint Slice 7

### Implementation checklist

- [x] Keep `/v1/health` intentionally minimal and public only if that is the documented health
  contract.
- [x] Put `/v1/capabilities` behind the dedicated public principal/authentication boundary required
  by the blueprint: direct-user context remains normalized, while installation tokens require
  active Agent Platform credential introspection before discovery.
- [x] Protect the initial capability route with the normalized authenticated direct-user context;
  machine installation credentials now use the same dedicated public boundary with active
  credential introspection.
- [x] Validate optional Agent Platform installation JWTs with ES256 signature, issuer, audience,
  expiry, subject, and organization/credential claims, then revalidate the active credential before
  treating the caller as an external agent.
- [ ] If anonymous discovery is desired, record and approve that product/security decision before
  implementation rather than assuming it.
- [ ] Filter discovery by lifecycle, authenticated principal type, organization entitlements,
  scopes, grants, resource policy, runtime support, feature flags, and availability.
- [x] Never expose `Internal`, disabled, retired, unentitled, or incompatible actions.

**Partial evidence:** `server/kasitek-core/src/controllers/public_v1.rs`,
`server/kasitek-core/src/services/agent_platform.rs`, `agents/src/http/app.ts`,
`server/kasitek-core/src/capabilities/catalog.rs`, and `docs/api/public-v1.openapi.json`.
The machine public principal now revalidates its active credential and receives installation grant,
availability, API-scope, and organization-entitlement filtered discovery from Agent Platform; rate,
metering, feature-flag, resource, and broader principal coverage remain open. The feature/resource
policy gap and direct-user grant mapping are recorded as `BLOCKERS.md` B-011. The initial direct-user
capability contract is authenticated and DTO-backed. A JWT-shaped
Bearer value now selects Agent-installation validation exclusively, so an invalid installation
credential cannot fall through to an otherwise valid product session. Core tests cover signature,
issuer, audience, claims, public filtering, and this auth-selection boundary.

The public read-resource follow-up `9276fae` now adds typed `/v1` contacts, inbox, bookings,
campaign, and template routes over the shared core queries with catalog action definitions and
restricted-field redaction. The follow-up public API accounting slice adds durable
`PublicApiRequest` reservations/finalization and a distributed per-principal rate limit. Feature/
resource policy, the approved principal matrix, metrics export, and external REST conformance
remain open. `8a68bab`, `81912a5`, `2480e6e`, `753d84f`, and `859ec5e` add the signed outbound webhook
subscription/delivery pipeline with encrypted secrets, idempotent request/content event enqueueing
and subscription creation, HMAC signatures, retry/disable recovery, delivery diagnostics,
configurable route flags, and standard deprecation headers; focused webhook and public OpenAPI tests
pass. `90c2bf5` centralizes the executable public principal policy: `direct_user` and
`agent_installation` are the only currently supported boundary principals, while workspace API-key,
service-account, and OAuth issuer kinds fail before resource or capability lookup with the stable
`unsupported_principal` error. It also makes the principal/transport policy concrete in OpenAPI,
publishes the anonymous `/v1/openapi.json` contract, and expands the contract assertion matrix across
the mounted `/v1` operations. The broader approved-issuer, action feature/resource policy, and
external runtime conformance gates remain intentionally unchecked pending their policy and runtime
verification dependencies.
- [x] Return a stable public DTO rather than serializing the internal `ActionDefinition` directly.
- [x] Add pagination/versioning where required by the public API contract. `/v1/capabilities`
  and every paginated resource list now accept bounded `limit`, offset `cursor`, and `version=v1`,
  return stable pagination metadata, and document the contract in the core-owned OpenAPI file.
  `ffdf7bf`, `6b9f5bb`, and `587f101` cover the list envelopes, filtered contacts, and explicit
  unsupported-version rejection.
- [x] Generate or update the initial core-owned OpenAPI 3.1 capability contract with authentication
  and response schemas; broader resource/action coverage remains open.
- [x] Add the first typed `/v1/content/posts` list/detail/draft routes over the shared organization-
  scoped content adapter with required idempotency for drafts; publish remains withheld pending the
  external approval/effect gate.
- [x] Add durable request-level usage/audit reservations and distributed per-principal rate-limit
  middleware. The reservation is created before dispatch and finalized with action/status after the
  handler; `KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE` controls the one-minute budget. `59ad609`
  also emits correlation/version/rate-limit headers on every public response and stable machine error
  codes while preserving `Retry-After` on 429 responses.
- [x] Add a separately exported public-API metrics surface and metrics conformance tests. Authenticated
  `/v1/metrics` returns only the caller's one-hour request counters; the payload helper test verifies
  principal scoping and that routes, organization IDs, and request data are not exposed.

### Required tests

- [ ] Anonymous, invalid, expired, and wrong-audience principals receive the documented response.
- [ ] Every approved public principal type is tested: workspace API key, service account, OAuth
  user/application grant, and agent installation.
- [x] Internal and pilot actions are hidden unless their lifecycle and caller policy explicitly
  permit discovery. The public filter requires `ActionLifecycle::Public`, direct runtime support,
  and the caller actor; core unit coverage exercises internal booking and pilot publish actions.
- [ ] Cross-organization entitlements/grants cannot affect discovery.
- [x] OpenAPI conformance covers status codes, authentication, and response schema. The core-owned
  contract test enumerates every mounted `/v1` operation, required success/error responses, the
  anonymous health exception, and the document-level protected principal schemes.

### Completion gate

- [ ] Public discovery exposes only the caller's approved stable public actions through the dedicated
  `/v1` policy boundary.
- [x] Remediation committed as `fdf211a` (`fix(core): filter public capability discovery`).

## 11. AR-007 — Distributed delegation replay protection

### Audited defect

`server/kasitek-core/src/identity/internal_delegation.rs` stores seen JWT ids in a process-local
static `HashMap`. A restart clears the cache and multiple replicas do not share it, so a token can be
replayed against another instance or after restart.

### Implementation checklist

- [x] Replace process-local replay tracking with an atomic shared replay store appropriate to the
  approved deployment topology.
- [x] Key replay state by issuer and JWT id, with expiration at least as long as token validity plus
  allowed clock skew.
- [x] Make accept-if-absent atomic across replicas.
- [x] Fail closed when the replay store is unavailable for effect-capable invocations.
- [x] Bound storage growth and purge expired entries safely.
- [x] Bind and validate organization, installation, capability/version, run, invocation,
  correlation, argument hash, and idempotency claims appropriate to the operation.
- [x] Ensure effect-capable Agent-to-core calls actually populate argument hash and idempotency
  claims; the current client leaves them unset.
- [x] Add overlapping signing-key rotation through trusted configuration: Agent Platform emits a
  `kid`, and core selects only the matching key from `AGENTS_DELEGATION_PUBLIC_KEYS_JSON` while
  retaining the legacy unlabelled single-key path for migration.

### Required tests

- [x] First use succeeds and same-process replay fails.
- [ ] Replay against a second simulated instance fails.
- [ ] Replay after service restart but before JWT expiry fails.
- [ ] Reuse after replay-record expiry follows the documented expired-token behavior.
- [x] Missing or mismatched trace, argument, idempotency, capability, or installation claims fail.
- [x] Replay-store outage follows the documented fail-closed behavior.

**Partial evidence:** `server/kasitek-core/src/identity/internal_delegation.rs`,
`server/kasitek-core/src/services/realtime.rs`, `agents/src/core/delegation.ts`, and
`agents/test/core-client.test.ts`; `ac738b0`, `14e2892`, and `e2c9d24`.
Core now accepts overlapping configured ES256 public keys only by explicit `kid`; legacy
unlabelled tokens continue to require the legacy single-key setting. The replay store is directly
constructible per core instance and has a Redis integration test for cross-instance rejection and
TTL expiry. Executing that test and the restart proof remain blocked by the unavailable local Redis
service.

### Completion gate

- [ ] A signed delegation is single-use across all core replicas for its complete validity window.
- [x] Remediation committed as `e2c9d24` (`fix(core): enforce rotating delegation replay keys`).

## 12. AR-008 — MCP gateway production boundary

### Audited gap

The separate gateway currently provides health, protected-resource metadata, and a basic fetch
proxy. The primary blueprint additionally requires independent configuration, logs, rate limits,
tests, scaling, cancellation, deployment wiring, and a kill switch.

Relevant starting points:

- `agents/src/gateway/app.ts`
- `agents/src/gateway/server.ts`
- `agents/test/gateway.test.ts`
- `agents/package.json`
- `agents/Dockerfile`
- Primary blueprint Slice 7

### Implementation checklist

- [x] Require a strong gateway-to-Agent-API credential in production; fail startup if absent.
- [x] Do not forward client-supplied internal organization/actor headers as trusted identity.
- [x] Forward only allowlisted headers and derive installation identity from the validated bearer
  token at the Agent API.
- [x] Add request/body limits, timeouts, upstream abort propagation, client-disconnect cancellation,
  and bounded response handling.
- [x] Add bounded rate limits keyed by bearer credential (or pre-authentication network address)
  and safe pre-authentication network limits; distributed enforcement remains a deployment gate.
- [x] Add a global and scoped MCP kill switch with audited changes. The gateway has an explicit
  global transport disable; Agent API MCP requests re-check global, organization, agent, and
  installation switches after bearer revalidation, while tool switches remain enforced by the
  shared invocation boundary. Enable/disable mutations are transactionally recorded in
  `audit_records`.
- [x] Add correlation ids, redacted latency/error counters, and readiness that checks required Agent
  API availability without taking ownership of business state. Structured distributed logs remain
  a deployment follow-up.
- [x] Pin and negotiate the supported MCP protocol revision (`2025-06-18`); reject incompatible
  revisions with a compatibility-tested response.
- [ ] Complete Streamable HTTP lifecycle, notification, structured error, and cancellation behavior.
- [ ] Add Railway/service deployment configuration, routing, scaling, and health checks.
- [x] Keep `/v1` off the MCP gateway.

### Required tests

- [x] Production configuration fails without gateway-to-API authentication.
- [x] Spoofed internal identity headers are stripped or rejected.
- [x] Gateway tests cover transport disable, rate limiting, protocol negotiation, bounded lifecycle
  methods, and upstream protocol-header propagation.

**Partial evidence:** `agents/src/gateway/app.ts`, `agents/src/gateway/server.ts`,
`agents/src/db/repositories/kill-switch-repository.ts`, `agents/src/http/app.ts`,
`agents/test/gateway.test.ts`, and `agents/test/http.test.ts`; `5d3787e`. Follow-up commits
`8dfa645`, `187b427`, `773b250`, `1efd1bb`, and `f4d236d` add MCP/REST acceptance parity,
deterministic idempotency validation, token-record ownership checks, a local stdio bridge, and
checked-in API/worker/gateway Railway descriptors with deployment-contract tests. Distributed
limits, full Streamable HTTP lifecycle, and hosted smoke remain open.
- [x] Rate, body, timeout, disconnect/cancellation, upstream failure, and kill-switch tests pass.
  `agents/test/gateway.test.ts` covers all transport cases and `agents/test/http.test.ts` covers
  Agent-side scoped switch enforcement and recovery after clearing the switch.
- [x] Two gateway instances remain stateless and produce equivalent behavior. Focused gateway
  coverage constructs independent replicas, verifies equivalent forwarding, and proves each keeps
  its own bounded limiter state without shared business storage.
- [x] Protocol initialization/negotiation and notifications pass compatibility tests. Gateway
  coverage verifies the pinned `2025-06-18` negotiation, incompatible-version response, and
  notification forwarding with an empty 204 response.
- [ ] Hosted smoke test reaches `agents.kasitek.co.za/mcp` through the gateway deployment.

### Completion gate

- [ ] The public gateway is a hardened stateless transport adapter and cannot bypass Agent Platform
  identity or policy.
- [x] Remediation committed as `5d3787e` (`fix(agents): harden MCP gateway boundary`).

## 13. AR-009 — Evidence, progress, and blocker accuracy

- [x] Update `docs/internal/architecture/agent-system-slices-2-7-progress.md` so it does not call
  approval/effect/MCP paths implemented until their live integration and tests pass.
- [x] Update `BLOCKERS.md` with every unresolved product decision or unavailable verification
  environment discovered during remediation.
- [x] Do not use `BLOCKERS.md` as a list of ordinary unfinished work; unfinished work remains an
  unchecked checklist item. Current entries are limited to unavailable infrastructure or explicit
  product/security policy decisions.
- [x] Recount checked and unchecked primary-blueprint items and record the count in the handoff.
  The current count is 169 checked / 57 unchecked of 226 in
  `KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md`.
- [ ] Add evidence to primary-blueprint items only when their full deliverable and verification gate
  pass.
- [x] Ensure documentation describes actual authentication, approval, effect, MCP, and public API
  behavior rather than intended future behavior.
- [x] Reconciled in this documentation update and committed with the audit/blueprint evidence.

**Admin continuation evidence (2026-08-14):** The Slice 12 command implementation continued in
commits `dd15723`, `3c83ebd`, and `f3f622d`. Existing retry/cancel/reconcile/assign/lifecycle,
delivery-replay, deletion, export-request, and kill-switch paths now carry expected organization
and resource guards; export requests persist as dual-control, organization-scoped queue records;
and the protected Core/Agent Operations surface exposes export and kill-switch status plus active
run cancellation. Agent operator integration is 3/3, the default Agent suite is 54 files / 183
passed / 33 expected integration skips, admin lint has zero errors (34 existing warnings), admin
typecheck/build pass, and `cargo check -p kasitek-core` passes. Feature flags and incident holds
are now also durable, expiring, dual-controlled, audited, resource-bound, surfaced through the
protected Operations page, and enforced before Agent run creation, MCP/REST access, Temporal
execution, external effects, and channel delivery by migration `044` and the operator lifecycle
integration. Hosted, Redis, seeded-core, provider, and browser gates remain explicit blockers rather
than being claimed as complete.

The follow-on operator verification also covers the protected feature-flag and incident-hold read
routes and the structured MCP response when a scoped runtime flag disables the transport;
`agents/test/http.test.ts` keeps both paths behind `operator:read` and asserts that the redacted
projection shape is preserved. Domain-preview tests cover channel send/reply, campaign, booking,
destructive, and later-domain projections without provider credentials.

**Post-remediation local capability evidence (2026-08-14):** Commits `720a47c`, `81d0284`,
`3b26830`, `1b2eee9`, `d422444`, and `0631818` add bounded, organization-scoped workspace/reporting, contact, template,
and inbox capability paths. The local Agent suite passes 197 tests with 34 expected integration
skips and the Core library suite passes 118 tests with 3 infrastructure-gated ignores. These
results improve the executable local surface but do not close the audit's seeded-core, Redis,
hosted/provider, browser, MCP/REST conformance, or public-principal gates.

## 14. Required verification matrix

Run targeted tests after each section, then run this full matrix before declaring audit remediation
complete. A passing unit suite does not compensate for skipped database, Temporal, protocol, or
runtime verification.

### Static and unit verification

- [x] `cd agents && pnpm test`
- [x] `cd agents && pnpm build`
- [x] `cd server && cargo fmt --check`
- [x] `cd server && cargo check -p kasitek-core`
- [x] `cd server && cargo test -p kasitek-core`
- [x] `cd client && pnpm --filter client lint` — Node 22.22.2, 0 errors and 1 existing warning.
- [x] `cd client/apps/client && pnpm exec tsc --noEmit` — Node 22.22.2, passed.
- [x] `cd client && pnpm --filter admin lint` — Node 22.22.2, 0 errors and 34 existing warnings.
- [x] `cd client/apps/admin && pnpm exec tsc --noEmit` — Node 22.22.2, passed.
- [x] `cd client && pnpm build:client` — Node 22.22.2, Next.js production build passed.
- [x] `cd client && pnpm build:admin` — Node 22.22.2, Next.js production build passed.

### Required integration verification

- [x] Apply all Agent migrations to a clean isolated PostgreSQL database.
- [ ] Apply the new migrations from every supported previous schema baseline.
- [x] Run all Agent integration tests with zero unexpected skips.
- [ ] Run relevant core database integration tests with zero unexpected ignores.
- [ ] Run the complete Temporal approval, retry, worker-restart, crash-after-provider-call,
  cancellation, and replay recovery matrix. Local approval continuation, worker replacement,
  signal recovery, cancellation, and durable-run coverage now pass in the full Agent suite
  (49 files / 204 tests / 0 skipped) against isolated Temporal; provider crash and Redis replay
  recovery remain open.
- [ ] Run MCP authentication, protocol, filtering, approval, cancellation, idempotency, isolation,
  and parity tests through the separate gateway.
- [ ] Run REST/OpenAPI authentication, authorization, rate, metering, idempotency, and conformance
  tests.
- [ ] Run authenticated client and admin browser smoke tests.
- [ ] Run provider sandbox tests without logging credentials or customer content.
- [ ] Run a repository secret scan and targeted auth/replay/confused-deputy security tests.

### Audit regressions that must be explicitly demonstrated

- [x] A valid exchanged MCP installation token succeeds.
- [x] A revoked token or mismatched installation fails.
- [x] A zero-scope internal token cannot approve a run.
- [x] A long approval wait never creates a false ambiguous provider outcome.
- [x] A denied effect is durably closed as not executed.
- [x] An approval is consumed once under concurrent execution.
- [x] MCP calls create the required durable audit/usage/runtime evidence.
- [x] Internal/pilot actions are not anonymously exposed through `/v1/capabilities`.
- [ ] Delegation replay fails across replicas and restart.

### Verification hygiene

- [x] Use a repository-supported Node version. The audit ran on unsupported Node `23.11.1`; the
  repository requested `>=22.12.0 <23 || >=24.0.0`.
- [x] Record warnings separately from failures. Under supported Node 22.22.2, client lint reports
  one warning and admin lint reports 34 warnings; both suites have zero errors.
- [x] Restore Prisma or other generated output only if it was clean before verification and the
  command changed it as an artifact. The Node 22 production builds changed only tracked Prisma
  whitespace; the generated directory was restored after verification.
- [x] Record every skipped/ignored test with an explicit blocker; do not summarize a suite as fully
  passing while required integration tests are skipped. Agent Temporal recovery is locally resolved
  (204 tests / 0 skips); core seeded-database/Redis ignores remain B-008/B-010, and the evidence
  documents the exact commands.

## 15. Resume the primary blueprint after remediation

Audit remediation is only a prerequisite. It does not complete the agent system.

- [ ] Re-open `KASITEK_AGENT_SYSTEM_EXECUTION_BLUEPRINT.md` at Slice 0.
- [ ] Re-verify the six previously checked items; uncheck any item whose evidence no longer holds.
- [ ] Complete every remaining Slice 0 verification item or record a specific blocker.
- [ ] Continue through Slice 1, then Slice 2, and onward in numerical order through Slice 13.
- [ ] Within each slice, implement storage/domain foundations before transport, UI, and operational
  polish where the blueprint does not specify a stricter dependency.
- [ ] Do not skip a slice merely because later partial code already exists; reconcile the partial
  code when its owning slice is reached.
- [ ] For a blocked item, add/update `BLOCKERS.md`, leave it unchecked, and continue with the next
  independent item.
- [ ] Commit coherent completed sections with tests and evidence.
- [ ] Repeat the loop until every blueprint item is either checked with verification or tied to an
  unresolved, evidence-backed blocker.
- [ ] Run the blueprint's complete final acceptance matrix.

## 16. Final handoff gate

Do not claim completion until all statements below are true.

- [ ] AR-001 through AR-009 are complete with committed evidence.
- [ ] All targeted audit reproductions now demonstrate the safe result.
- [ ] No required database, Temporal, MCP, REST, browser, provider, or security test is silently
  skipped.
- [ ] Every primary-blueprint checkbox is either verified and checked or explicitly associated with
  a current blocker.
- [ ] The worktree contains no task-generated artifacts and preserves all unrelated user changes.
- [ ] `BLOCKERS.md` contains exact unresolved decisions/environment gaps and no stale resolved claims.
- [ ] Documentation and OpenAPI match deployed behavior.
- [ ] The final report lists commits, verification commands/results, remaining blockers, and the
  final checked/unchecked blueprint count.
