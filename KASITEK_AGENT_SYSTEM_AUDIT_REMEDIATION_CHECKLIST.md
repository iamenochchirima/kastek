# KasiTek Agent System Audit Remediation Checklist

**Status:** Required remediation and continuation checklist

**Audit baseline:** `fe94c40` (`docs(api): document MCP installation integration`)

**Audit date:** 2026-08-13

**Evidence reconciliation:** 2026-08-13 — 88 of 240 checklist items have current implementation
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
- [ ] Suggested commit: `fix(agents): authenticate MCP installation tokens`.

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
- [ ] Require the approver to have access to the organization, installation, run, capability, and
  affected resource.
- [ ] Enforce current installation/capability grants again at decision time.
- [ ] Enforce the approved self-approval and separation-of-duties policy. If undefined, record the
  precise decision in `BLOCKERS.md` and keep real external effects disabled.
- [ ] Reject terminal, stale, expired, already decided, or non-awaiting approvals atomically.
- [x] Do not accept `approvedBy` from the request body; derive it from the authenticated principal.
- [x] Emit a redacted immutable audit event for approval, denial, expiry, and cancellation.
- [ ] Rate-limit repeated decisions and make the decision command idempotent.

### Required tests

- [x] A token with no approval scope receives 403 and no Temporal signal is sent.
- [ ] A correctly scoped but unrelated actor/resource receives 403.
- [ ] Cross-organization run ids are indistinguishable from not found.
- [x] Valid approve and deny decisions signal Temporal once and write audit evidence.
- [ ] Concurrent decisions result in exactly one accepted decision.
- [ ] Duplicate idempotent submission returns the original decision without a second signal.
- [ ] Self-approval behavior matches the approved policy.

### Completion gate

- [x] Re-run the zero-scope reproduction and receive 403 with `signalled=false`.

**Partial evidence:** `agents/src/http/app.ts`, `agents/test/http.test.ts`; `7508423`,
`e94e16a`. Resource/actor policy, self-approval policy, and decision idempotency remain open.
- [ ] Suggested commit: `fix(agents): authorize run approval decisions`.

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
- [ ] Expire pending approvals durably and surface expiration to the workflow and UI.
- [ ] Immediately before effect execution, reauthorize current organization, installation,
  capability, resource, connector/channel, and kill-switch state.
- [x] Atomically consume the approved record once and only once before the permitted effect begins.
- [ ] Ensure Temporal activity retry cannot consume approval twice or execute a second effect.
- [x] Cancel the approval when the run or installation is cancelled/disabled.
- [ ] Replace or clearly separate duplicated approval state in `tool_invocations` so the source of
  truth is unambiguous.
- [ ] Remove dead methods and misleading documentation only after the live path uses the repository.

### Required tests

- [x] Database test covers pending → approved → consumed.
- [x] Database tests cover pending → denied, expired, and cancelled.
- [ ] Wrong organization, installation, capability version, argument hash, resource snapshot,
  preview revision, policy revision, or effect key cannot consume approval.
- [x] Two concurrent consumers produce exactly one successful consumption.

**Partial evidence:** migration `032_durable_approval_lifecycle.sql`,
`agents/src/db/repositories/approval-repository.ts`, `agents/src/temporal/activities.ts`,
`agents/test/run.integration.test.ts`; `e94e16a`. Expiry scheduling, cancellation, full
execution-time reauthorization, and Temporal recovery proof remain open.
- [ ] Changed grants or disabled installation after approval prevents execution.
- [ ] Temporal replay/retry does not create or consume a second approval.

### Completion gate

- [ ] No production approval path can reach an external effect without a current, exact, atomically
  consumed durable approval when policy requires one.
- [ ] Suggested commit: `feat(agents): enforce durable single-use approvals`.

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
- [ ] Introduce an explicit pre-effect execution hook/boundary if `ToolRegistry.invoke()` currently
  hides the exact provider-call boundary.
- [ ] Require the durable approval consumption and effect transition to agree on organization, run,
  tool-call id, capability/version, arguments hash, and idempotency key.
- [x] Mark denied, expired, cancelled, or failed-before-provider effects as definitely not executed,
  with `reconciliation_required=false`.
- [x] Mark `unknown/reconciliation_required` only when execution may have reached the provider and the
  outcome cannot be determined.
- [x] Do not mutate effect state as an incidental side effect of a GET/health query. Move stale
  execution detection to a scheduled reconciliation command/job with audit evidence.
- [x] Ensure reconciliation commands are authenticated, scoped, version-checked, idempotent, and
  audited.
- [ ] Make receipt status and reconciliation API response semantics agree; remove an unused
  `reconciled` state or use it consistently.
- [x] Store provider receipts safely and redact credentials/provider secrets from errors and output.

**Partial evidence:** `agents/src/db/repositories/effect-receipt-repository.ts`,
`agents/src/temporal/activities.ts`, `agents/src/temporal/worker.ts`, `agents/test/run.integration.test.ts`;
`ad7e0ec`, `7ecc36a`, `3de686f`. The exact provider-call hook and full recovery matrix remain open.
- [ ] Prohibit blind retry after any ambiguous provider outcome.

### Required tests

- [ ] Waiting for approval longer than 120 seconds leaves the receipt reserved and does not create a
  reconciliation incident.
- [ ] Denial after a long wait closes the receipt as definitely not executed.
- [ ] Provider success records one succeeded receipt and provider receipt.
- [ ] Failure before provider invocation records failed/not-executed without reconciliation.
- [ ] Timeout or crash after provider invocation records unknown/reconciliation-required.
- [ ] Duplicate Temporal activity execution cannot invoke the provider twice.
- [ ] Health/read endpoints do not mutate receipt state.
- [ ] Authorized reconciliation resolves an unknown outcome once and emits audit evidence.

### Completion gate

- [ ] The full proposal → approval → execution → receipt state machine is integration-tested against
  PostgreSQL and Temporal recovery behavior.
- [ ] Suggested commit: `fix(agents): align effect receipts with provider execution`.

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

- [ ] Extract or reuse one protocol-neutral invocation service used by hosted agents and MCP.
- [x] Resolve the authenticated installation and effective grants inside that service.
- [x] Normalize and validate arguments once using the canonical capability manifest.
- [ ] Apply current entitlement, resource, connector/channel, risk, approval, kill-switch, quota,
  budget, and availability policy before invocation.
- [x] Create durable invocation/audit/usage evidence for every MCP call.
- [x] Route durable capabilities through Temporal and return a stable operation/run reference.
- [ ] Permit immediate read execution only when the manifest explicitly declares it, while still
  recording audit and usage evidence.
- [ ] Return structured `APPROVAL_REQUIRED` data with a stable approval/status reference instead of a
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
- [ ] MCP cancellation reaches the workflow without cancelling a completed effect.
- [ ] MCP and hosted-agent parity tests assert the same domain operation and policy outcome.
- [x] Cross-installation and cross-organization calls are rejected.

**Partial evidence:** `agents/src/http/app.ts`, `agents/src/temporal/activities.ts`,
`agents/test/http.test.ts`; `1c95d9c`. Protocol-neutral extraction, cancellation, parity, restart,
and external-client proof remain open.

**Additional transport evidence:** the installation REST transport now uses the same
`acceptDurableToolCall` boundary as MCP, carries an audience-specific API scope policy, and exposes
installation-scoped operation status/cancellation. This closes the REST transport slice but does not
close the remaining hosted-agent parity, restart, live approval, or external-client gates.
- [ ] Real Codex, Claude Code, and a generic MCP client are verified before checking the relevant
  primary-blueprint item.

### Completion gate

- [ ] No MCP capability bypasses the shared policy, invocation, audit, approval, or effect boundary.
- [ ] Suggested commit: `fix(agents): route MCP calls through capability runtime`.

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
- [ ] Put `/v1/capabilities` behind the dedicated public principal/authentication boundary required
  by the blueprint.
- [ ] If anonymous discovery is desired, record and approve that product/security decision before
  implementation rather than assuming it.
- [ ] Filter discovery by lifecycle, authenticated principal type, organization entitlements,
  scopes, grants, resource policy, runtime support, feature flags, and availability.
- [x] Never expose `Internal`, disabled, retired, unentitled, or incompatible actions.

**Partial evidence:** `server/kasitek-core/src/controllers/public_v1.rs`,
`server/kasitek-core/src/capabilities/catalog.rs`; `4b8cd4f`. Dedicated public-principal
authentication, DTOs, OpenAPI, metering, and broader policy filtering remain open.
- [ ] Return a stable public DTO rather than serializing the internal `ActionDefinition` directly.
- [ ] Add pagination/versioning where required by the public API contract.
- [ ] Generate or update core-owned OpenAPI 3.1 with authentication and response schemas.
- [ ] Add metering, rate-limit, audit, and metrics middleware before calling the endpoint complete.

### Required tests

- [ ] Anonymous, invalid, expired, and wrong-audience principals receive the documented response.
- [ ] Every approved public principal type is tested: workspace API key, service account, OAuth
  user/application grant, and agent installation.
- [ ] Internal and pilot actions are hidden unless their lifecycle and caller policy explicitly
  permit discovery.
- [ ] Cross-organization entitlements/grants cannot affect discovery.
- [ ] OpenAPI conformance covers status codes, authentication, and response schema.

### Completion gate

- [ ] Public discovery exposes only the caller's approved stable public actions through the dedicated
  `/v1` policy boundary.
- [ ] Suggested commit: `fix(core): protect public capability discovery`.

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
- [ ] Add signing-key rotation/JWKS behavior required by the primary blueprint.

### Required tests

- [x] First use succeeds and same-process replay fails.
- [ ] Replay against a second simulated instance fails.
- [ ] Replay after service restart but before JWT expiry fails.
- [ ] Reuse after replay-record expiry follows the documented expired-token behavior.
- [x] Missing or mismatched trace, argument, idempotency, capability, or installation claims fail.
- [x] Replay-store outage follows the documented fail-closed behavior.

**Partial evidence:** `server/kasitek-core/src/identity/internal_delegation.rs`,
`server/kasitek-core/src/services/realtime.rs`, Agent core-client tests; `ac738b0`, `14e2892`.
Multi-instance/restart integration and signing-key rotation remain open.

### Completion gate

- [ ] A signed delegation is single-use across all core replicas for its complete validity window.
- [ ] Suggested commit: `fix(core): enforce distributed delegation replay protection`.

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
- [ ] Add a global and scoped MCP kill switch with audited changes.
- [ ] Add structured redacted logs, correlation ids, latency/error metrics, and readiness that checks
  required upstream availability without taking ownership of business state.
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
`agents/test/gateway.test.ts`; `5d3787e`. Distributed limits, metrics/readiness, deployment,
protocol cancellation, and hosted smoke remain open.
- [ ] Rate, body, timeout, disconnect/cancellation, upstream failure, and kill-switch tests pass.
- [ ] Two gateway instances remain stateless and produce equivalent behavior.
- [ ] Protocol initialization/negotiation and notifications pass compatibility tests.
- [ ] Hosted smoke test reaches `agents.kasitek.co.za/mcp` through the gateway deployment.

### Completion gate

- [ ] The public gateway is a hardened stateless transport adapter and cannot bypass Agent Platform
  identity or policy.
- [ ] Suggested commit: `feat(agents): harden MCP gateway boundary`.

## 13. AR-009 — Evidence, progress, and blocker accuracy

- [x] Update `docs/internal/architecture/agent-system-slices-2-7-progress.md` so it does not call
  approval/effect/MCP paths implemented until their live integration and tests pass.
- [x] Update `BLOCKERS.md` with every unresolved product decision or unavailable verification
  environment discovered during remediation.
- [ ] Do not use `BLOCKERS.md` as a list of ordinary unfinished work; unfinished work remains an
  unchecked checklist item.
- [ ] Recount checked and unchecked primary-blueprint items and record the count in the handoff.
- [ ] Add evidence to primary-blueprint items only when their full deliverable and verification gate
  pass.
- [x] Ensure documentation describes actual authentication, approval, effect, MCP, and public API
  behavior rather than intended future behavior.
- [ ] Suggested commit: `docs(agents): reconcile audit remediation evidence`.

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
- [ ] `cd client && pnpm --filter client lint`
- [ ] `cd client/apps/client && pnpm exec tsc --noEmit`
- [ ] `cd client && pnpm --filter admin lint`
- [ ] `cd client/apps/admin && pnpm exec tsc --noEmit`
- [ ] `cd client && pnpm build:client`
- [ ] `cd client && pnpm build:admin`

### Required integration verification

- [x] Apply all Agent migrations to a clean isolated PostgreSQL database.
- [ ] Apply the new migrations from every supported previous schema baseline.
- [x] Run all Agent integration tests with zero unexpected skips.
- [ ] Run relevant core database integration tests with zero unexpected ignores.
- [ ] Run Temporal approval, retry, worker-restart, crash-after-provider-call, cancellation, and replay
  recovery tests.
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
- [ ] Record warnings separately from failures. The audit baseline had one client lint warning and
  34 admin lint warnings.
- [ ] Restore Prisma or other generated output only if it was clean before verification and the
  command changed it as an artifact.
- [ ] Record every skipped/ignored test with an explicit blocker; do not summarize a suite as fully
  passing while required integration tests are skipped.

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
