# Agent system implementation progress: slices 2–7

This record is intentionally narrower than the blueprint completion checkboxes. A checkbox is only
marked when the complete deliverable and its verification exist.

## Implemented evidence

- Installation credential records use copy-once scrypt hashes, MCP scopes, token exchange, and
  rotation/revocation. MCP requests validate the ES256 installation token against the current
  credential and installation: `9f7203d`, `48b16bf`.
- Installation resource/connector grants and capability discovery are organization- and
  installation-scoped: `5745184`, `b3830c8`.
- Agent invocations can issue short-lived ES256 delegations and kasitek-core verifies issuer,
  audience, expiry, subject, organization, installation, capability, argument-hash, and
  idempotency claims. Replay prevention uses a Redis-backed atomic `SET NX` store rather than
  process memory; the external cross-replica/restart verification remains blocked until Redis is
  available (`BLOCKERS.md` B-008).
- Durable external-effect receipts and exact single-use approval records have migrations and
  repository transitions, including reconciliation-required outcomes. Approval decisions require
  `runs:approve`, and effects stay reserved until execution: `82ebdb0`, `63a90f7`, `e94e16a`,
  `ad7e0ec`, `7508423`, `7ecc36a`.
- The Agent Platform has a stateless MCP gateway process, installation-scoped MCP discovery/call
  transport, gateway authentication hardening, and durable MCP runs: `e90661c`, `75f051e`,
  `5d3787e`, `1c95d9c`.
- Installation calls now have an explicit non-Temporal fallback for read manifests that declare
  `execution: immediate`; it still creates a durable run, tool proposal, completion/failure
  evidence, and idempotency boundary. Durable/approval-required capabilities continue through
  Temporal.
- Provider-neutral connector manifests, canonical Telegram/Discord inbound envelopes, and delivery
  adapter boundaries are implemented and unit tested: `6e40567`, `b8e1c50`.
- Core action metadata and typed content adapters cover content listing, draft creation, and publish
  policy metadata without bypassing normalized request context: `440cf2f`, `e1d431a`.
- Hosted-agent product operations now cover durable run history/cancellation, installation resource
  and connector grants, built-in Telegram/Discord connector manifests, credentials, schedule
  triggers, knowledge URL ingestion, memory deletion/revalidation, channel registration/pairing,
  model policy configuration, pause/resume, and per-installation usage summaries. The core proxy,
  Agent API, and client detail experience are committed in `152192e`, `81807cb`, `5765e7e`,
  `55e33d6`, `52def06`, and `4e04a17`.
- The hosted-agent detail experience now includes a graph editor that writes the validated version
  `configuration.workflow` schema, supports node/edge and loop-bound editing, approval/wait/fan-out
  controls, and secret-safe JSON import/export. It uses the existing draft/publish/rollback
  lifecycle and is committed in `b2de22f`; durable graph execution is connected in `0812616`.
  State revisions, deterministic/model/tool nodes, configured approval proposals/resumption, and
  redacted tool/model evidence use the existing runtime boundary. External wait-node continuation
  now persists the paused node/state, exposes an authenticated signal route and run-detail resume
  action, and is covered by graph regression tests in `bcb7ba2`. The editor now starts an installed
  workflow test from a real platform message and links to its durable timeline; full
  Temporal/database proof remains unchecked. The run page now loads a scoped timeline proxy and
  renders redacted steps, tool calls, and effect receipts from the same run in `f345261`.
  The Rust core browser proxy now forwards the external-event resume action as well (`7b619b1`),
  closing the end-to-end path from the run UI to the durable Temporal signal.
- KasiAi runs now build grounded dynamic context from the authenticated actor and organization,
  granted capability names/modules, durable conversation, and bounded route/entity/page context
  marked as untrusted UI data. The shared builder and regression test are committed in `4e8df19`.
- KasiAi now keeps a compact redacted run-activity trail in chat for context preparation, model/tool
  activity, approval waits, failures, and completion, with a link to the durable timeline. The UI
  slice is committed in `ca5c200`; full approval-preview/result/retry interaction and authenticated
  browser proof remain open.
- External-agent setup now has a dedicated `/agents/connect` wizard for named copy-once credentials,
  independent MCP/REST scopes, installation capability/resource health, optional resource grants,
  and copyable MCP/REST client examples. Rotation/revocation and audit inspection remain linked to
  the existing detail/activity views. The slice is committed in `eaf6106`.
- Hosted-agent creation now includes the same validated workflow graph editor used by detail drafts,
  so a first version can be configured with instructions, model policy, limits, and graph before
  publishing/installing. Shared detail surfaces cover capabilities, channels, conversations,
  approvals, usage, credentials, and test chat; creation wiring is committed in `6afb085`.
- The grounded context builder states a response provenance contract: separate reviewed knowledge,
  tool-derived facts, untrusted user data, unavailable actions, and uncertain information. The
  contract is covered by the context regression test in `71f9945`; model-judged/adversarial release
  evaluations remain unchecked.
- Approval/effect/invocation remediation is now in a coherent committed backend slice:
  `a0cf679` adds the shared installation invocation boundary, immediate-read durability, approval
  compare-and-set/idempotency, effect receipt transitions, gateway transport hardening, migrations
  `033`–`035`, and a local E2E smoke harness. Delegation key rotation and the Redis-backed replay
  store are committed in `e2c9d24`; public capability discovery filtering and pagination are
  committed in `fdf211a`.
- Internal Agent API routes now enforce the same read/write scope contract as the Rust core proxy
  across agent lifecycle, installations, schedules, credentials, knowledge, memory, evaluations,
  conversations, and run creation. A HMAC regression matrix covers the previously unguarded routes
  (`56cc77a`, `a541304`).
- Installation credential rotation is now a real atomic replacement path: the old credential is
  revoked in the same transaction, the replacement secret is shown once, and both revoke/rotate
  actions emit audit records. The core proxy and Agent detail UI expose the flow (`22a25f0`).
- Run inspection now streams the durable event timeline through the existing authenticated SSE
  route, refreshes on terminal events, and presents a retry state when the stream is unavailable;
  the cursor remains stable for the lifetime of one stream session (`4466439`, `9d0635a`).
- Core now publishes a checked-in OpenAPI 3.1 document for the current public `/v1` health,
  capability, and content resource routes at `/v1/openapi.json`, with bearer-installation and
  product-session security schemes and a Rust validity/coverage regression (`server/kasitek-core/openapi/v1.json`).
  Broader principal, webhook, and parity conformance remains open.
- The external MCP integration contract is now separately documented with token exchange,
  Streamable HTTP lifecycle, scope behavior, idempotency, and durable operation inspection
  (`agents/docs/mcp-integration.md`, `c5c48a4`).

## Verification evidence

On 2026-08-13, Agent Platform migrations through `035` applied to the local Agent PostgreSQL
database. The latest default `pnpm --dir agents test` run passed 32 files / 140 tests with 10
environment-gated files (24 tests) skipped; with `RUN_AGENTS_DB_INTEGRATION_TESTS=true`, the
previously recorded database run passed 41 files /
156 tests (one explicitly skipped Temporal recovery integration) under Node 22.22.2, and
`pnpm --dir agents build` passed. Gateway tests now cover body/timeout/disconnect/upstream/kill-switch
behavior and two independent replicas. `cargo fmt --check`, `cargo check -p kasitek-core`, and the
core library suite passed 72 tests with three explicitly ignored seeded-database/Redis cases.
Client and admin lint/typecheck/build verification also passed under Node 22.22.2 (one client lint
warning and 34 admin lint warnings, zero errors). External Redis, Temporal, browser, provider, and
frontend interaction matrices remain release gates tracked in the canonical checklist and
`BLOCKERS.md`.

The local smoke also passed on isolated API/gateway ports with a temporary development signing key
and `TEMPORAL_ENABLED=false`, exercising REST discovery/idempotency and MCP gateway negotiation
through the explicit immediate-read path against PostgreSQL. This does not replace the blocked
Temporal worker-restart or hosted gateway proof.

## Current checkbox reconciliation

The primary blueprint currently has **130 checked and 94 unchecked items out of 224**. This is a
progress count only; an unchecked item remains release work or an evidence-backed blocker.

The external installation exchange now supports registered P-256 client keys. `a0521bb` adds
ES256 assertion verification with bounded timestamps and audience, atomic per-credential `jti`
replay consumption, key registration in the Agent API and dashboard, and the documented exchange
contract. Focused auth, HTTP, migration, full Agent Platform, client typecheck, lint, and build
verification passed; database/Temporal/hosted-browser gates remain separately tracked.

Capability consumers now use generated projections from the authoritative manifest registry.
`2952291` adds MCP and public discovery projections, permission/audit/documentation metadata for
the Agent UI, a deterministic checked-in capability catalog, a regeneration command, and parity
tests. Core-owned REST/OpenAPI contracts remain separate as required by the blueprint.

Core route registration is now split into product, internal, provider-webhook, website, and admin
modules. `c5c2cb7` preserves the exact 225 route path literals and adds representative mounted
route regression coverage.

The bookings pilot now has a distinct transport layer and a second typed consumer. Booking request
DTOs and the shared service-list response envelope live in `domains/bookings/transport.rs`; the
product handler and the internal `/api/internal/agents/v1/bookings/services` handler both call the
same booking query boundary. The Agent client and generated capability registry expose
`kasitek.core.booking_services_list`, with core route, transport, and client tests passing
(`15d3f77`).

The existing `/api/bookings/*` product handlers now have an explicit transport/domain separation
and a tested shared response envelope with the internal booking adapter (`15d3f77`).

Booking validation is now centralized in the domain policy (text normalization, duration bounds,
future scheduling, and status validation), and overlap detection explicitly includes organization
scope (`6697e98`). Pure policy tests pass; seeded PostgreSQL transaction/overlap integration remains
open under the environment-gated verification item.

The identity boundary now has explicit product-session, admin-session, public-installation, and
internal-delegation adapters that construct `RequestContext` before pilot domain operations; the
admin adapter also maps roles to narrow platform grants (`838d32e`).

The content adapter now also supports a safe draft-only update path. The internal core boundary
accepts `PATCH /api/internal/agents/v1/content/posts/{id}` under the normalized delegated context,
reuses the existing organization-scoped social update service, and the Agent registry/client expose
`kasitek.core.content_post_update` with generated documentation and transport tests (`f63cdc3`).

Public `/v1` content invocation now re-checks live installation capability availability, required
manifest grants, and the credential's REST API scope at execution time instead of relying on
discovery alone. Direct product sessions retain their existing action checks; installation calls
are denied after grant revocation or scope narrowing (`8dc98a4`).

The public REST content slice now also exposes `PATCH /v1/content/posts/{id}` for draft-only
updates, backed by the shared content adapter and a public `content.posts.draft.update` action.
OpenAPI, route, authorization, and action-catalog coverage are committed in `9b84334`.

The public boundary follow-up is complete in `62e2ec2`: `/v1` is registered only by
`api::public_v1`, while anonymous quote and waitlist handlers now live under explicit `website`
controller/service modules. Route tests assert the ownership split and representative legacy mounts.

The initial approval separation-of-duties rule is implemented: a run initiator cannot approve their
own pending action, with an HTTP regression in `22b2748`. The broader workspace approver/resource
role matrix remains blocked by `BLOCKERS.md` B-007. The run page now shows the argument hash and
preview revision and disables self-approval in the browser before submission (`2b29142`).

The shared Activity experience now exposes audited effect reconciliation controls and scoped kill
switches through the Rust core proxy (`4e63f82`, `c05e506`).

## Remaining work

The hosted gateway route/deployment smoke, public Rust `/v1` middleware and principal matrix,
complete content handler transport, provider sandbox runs, admin operator delegation/read models,
and full UI/production verification remain unchecked in the blueprint until implemented and run in
their target environments.
