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

On 2026-08-14, Agent Platform migrations through `035` applied to the local Agent PostgreSQL
database. With an isolated local Temporal dev server, the complete suite passed 49 files / 198
tests / 0 skips under Node 22.22.2, and `pnpm --dir agents build` passed. Hosted-agent boundary
integration now covers organization-scoped lifecycle, grants, schedules, and workflow validation.
Gateway tests now cover
body/timeout/disconnect/upstream/kill-switch behavior and two independent replicas. `cargo
fmt --check`, `cargo check -p kasitek-core`, and the core library suite passed 105 tests with three
explicitly ignored seeded-database/Redis cases.
Client and admin lint/typecheck/build verification also passed under Node 22.22.2 (one client lint
warning and 34 admin lint warnings, zero errors). External Redis, Temporal, browser, provider, and
frontend interaction matrices remain release gates tracked in the canonical checklist and
`BLOCKERS.md`.

The local smoke also passed on isolated API/gateway ports with a temporary development signing key
and `TEMPORAL_ENABLED=false`, exercising REST discovery/idempotency and MCP gateway negotiation
through the explicit immediate-read path against PostgreSQL. This does not replace the blocked
Temporal worker-restart or hosted gateway proof.

## Current checkbox reconciliation

The primary blueprint currently has **139 checked and 85 unchecked items out of 224**. This is a
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

The repeatable domain migration template and post-bookings dependency order are now recorded in
`docs/internal/architecture/domain-migration-template.md`; future slices must satisfy its shared
operation, isolation, adapter, verification, and evidence gates.

The current slice evidence is recorded as follows:

- The typed public read-resource follow-up `9276fae` extends core-owned `/v1` with organization-
  scoped contacts, inbox conversations/messages, bookings, campaign summaries, and template
  inventory. Each route enters through the normalized public context and catalog action policy,
  reuses the existing core query/service boundary, and removes restricted provider/customer fields
  before serialization. The public action catalog now has explicit read definitions and the core
  and docs OpenAPI contracts, route inventory, billing capability registry, and redaction regression
  coverage are updated. The follow-up public API accounting slice adds a migrated
  `PublicApiRequest` table, pre-dispatch reservation, post-response action/status finalization, and
  a database-backed per-principal one-minute rate limit
  (`KASITEK_PUBLIC_API_RATE_LIMIT_PER_MINUTE`) in the shared `/v1` middleware. Each reservation
  also writes the registered `public_api_requests` workspace meter with an idempotency key.
  Feature/resource policy, broader principal types, metrics export, webhooks, and external
  conformance remain open under AR-006/B-011 and Slice 7.

- The booking transport parity follow-up `41778a7` moves product request normalization, timestamp,
  status, duration, and optional-field validation into the shared bookings transport/domain policy.
  Product and delegated booking list handlers now use the same typed service/booking response
  envelopes, preventing drift in wire shape while retaining their distinct authentication paths.
  The focused booking suite passes 11 tests and the full core library suite passes 90 tests with
  three explicitly ignored infrastructure-gated cases; seeded transactional overlap and
  organization-isolation coverage remains open under `BLOCKERS.md` B-010.

- Booking transport/internal capability and product response parity: `15d3f77`, `21317c0`,
  `7f4d89c`; verified with `cargo fmt --check`, `cargo check -p kasitek-core`, `cargo test -p
  kasitek-core --lib`, focused Agent client/capability tests, and Agent build.
- Booking policy normalization and organization-scoped overlap: `6697e98`, `c95eda1`; the same
  Rust checks pass, with seeded PostgreSQL transaction tests still environment-gated.
- Content draft update through internal Agent and public REST adapters: `f63cdc3`, `7a82ce1`,
  `9b84334`, `b4fc0e8`; Agent full suite/build and core Rust suite pass.
- Public installation grant/scope reauthorization and normalized admin context: `8dc98a4`,
  `99f6005`, `838d32e`; core Rust suite passes, while external infrastructure gates remain in
  `BLOCKERS.md`.

Negative identity coverage now explicitly rejects wrong-realm principals from the direct runtime
and rejects agent-installation principals from workspace-admin booking mutations before any
membership lookup (`7d93685`). Existing Agent Platform suites cover revoked credentials, revoked
grants, suspended installations, and cross-organization operation access. The remaining core
database-backed membership and untrusted-header cases stay open until the seeded integration
environment is available.

Social provider capability metadata, OAuth, webhook, and publishing boundaries now have separate
service ownership. `1f2bc42` moves channel capability metadata into `social_channels`; `c16727f`
moves PKCE/state generation and provider authorize URL builders into `social_oauth`; `ddf8474` moves
TikTok signature verification, envelope validation, and durable event recording into
`social_webhooks`; and `8b1fc14` moves X, LinkedIn, Threads, TikTok, Facebook, and Instagram
publishing adapters plus token rotation helpers into `social_publishing`; and `09f5e68` moves the
post query, variant/job creation, validation, idempotent create/update, and delete lifecycle into
`social_posts`. The existing controller-facing `social::` exports remain stable, and the core
library suite passes 85 tests with three explicitly ignored infrastructure-gated cases. Shared
publish-job execution/reconciliation remains in `social`, while provider-specific adapter and post
lifecycle decomposition is now explicit.

The channel lifecycle follow-up `0747b4f` moves organization-scoped channel list/get/create/update/
delete operations into `social_channels`, preserving the existing `social::` exports and capability
metadata merge. Provider-specific connection upserts and identity refresh remain in `social` until
their provider adapter boundaries are extracted.

The provider-connection follow-ups `44e64ee` and `5e2d6d8` move the shared encrypted connection
upsert, external account lookup, and all provider connection adapters (Threads, TikTok, Bluesky, X,
LinkedIn, Meta, and Instagram) into `social_provider_connections`. Provider-specific identity
normalization and permission metadata now stay with those adapters rather than the shared social
service.

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

The typed content follow-up adds approval-aware Agent operations for unscheduling and deleting
unpublished posts (`content_post_unschedule`, `content_post_delete`). Unscheduling atomically moves
`SCHEDULED` posts back to `DRAFT`, releases queued jobs, and records an idempotency marker; delete
rejects published records and stays organization-scoped. Internal routes, core client/manifest
surfaces, generated capability documentation, route inventory, Rust checks/tests, and Agent tests
are verified in `0bc1e7e`.

The next WhatsApp decomposition slice now gives templates an explicit service boundary in
`whatsapp_templates`: Graph template synchronization, template authoring, local projection, and
organization-scoped listing live there while the existing `whatsapp::` exports remain stable for
controllers and callers (`07069a4`). Connection lifecycle, contacts, campaigns, inbox transport,
webhooks, calls, and delivery workers remain separate follow-up work; the broad WhatsApp blueprint
item is intentionally still open.

WhatsApp connection ownership is now explicit in `whatsapp_connections`: Meta OAuth/WABA and phone
resolution, encrypted manual/embedded connection setup, token refresh, webhook subscription, health
diagnostics, and organization-scoped reads live behind that boundary. Existing controller-facing
`whatsapp::` exports and the shared SQL projection remain stable (`7be54cf`). Contacts, campaigns,
inbox transport, provider webhooks, calls, and delivery workers are still open decomposition work.

WhatsApp contacts and list management now have their own `whatsapp_contacts` service boundary for
organization-scoped listing/statistics, CSV export, edits, consent-checked imports, and list rename/
delete operations. Shared phone/list normalization helpers remain reusable by campaign and inbox
paths, while controller-facing `whatsapp::` exports stay stable (`9ffd858`). Campaign workers,
inbox transport, provider webhooks, calls, and delivery workers remain open.

WhatsApp campaign ownership is now explicit in `whatsapp_campaigns`: campaign creation and
recipient snapshots, lifecycle transitions, summaries, retry/repair/delete operations, provider
template sends, recipient claims/recovery, usage metering, and queue reconciliation live there. The
existing `whatsapp::` exports and delivery call sites remain stable (`f42a00e`). Inbox transport,
provider webhooks, calls, and the remaining cross-provider delivery-worker decomposition are still
open.

The Meta WhatsApp webhook boundary is now explicit in `whatsapp_webhooks`: delivery status mapping,
campaign status reconciliation, inbound text/media ingestion, KasiAi pairing, unsubscribe safety,
push notifications, and provider call dispatch live there. The existing `process_webhook_payload`
route export remains stable and the core suite passes (`ec4842c`). Inbox transport, calls, and the
remaining cross-provider delivery-worker decomposition remain open.

WhatsApp inbox transport is now explicit in `whatsapp_inbox`: Agent reply delivery, queued outbound
message/media workers, organization-scoped conversation reads, start/send/update/delete flows,
read/reaction actions, and attachment download all live behind this service boundary. Existing
controller-facing exports remain stable and the core suite passes (`ca89e40`). The standalone calls
adapter remains in `whatsapp_calls`; the broad checklist item still needs its final cross-provider
delivery-worker and target-environment E2E evidence.

The next capability-domain slice exposes the existing organization-scoped contacts and inbox query
services through the delegated Agent/Core boundary. `2316624` adds filtered contact listing,
conversation listing, and conversation message reads under `contacts.read`/`inbox.read`, with
resource selection and redaction metadata in the authoritative Agent manifest registry. Core owns
the SQL and organization checks; Agent Platform only receives typed projections and never connects
to the core database. Rust format/check/library tests pass (85 passed, 3 infrastructure-gated
ignored), Agent tests pass (33 files, 147 passed, 24 environment-gated skipped), and the Agent
TypeScript build passes. This is a read-side foundation for the broader contacts/inbox capability
expansion; writes, provider effects, and full browser/provider E2E remain open.

The follow-on bookings read slice `6fc9c00` exposes the existing shared booking query through
`kasitek.core.bookings_list` alongside the service-list capability. The internal adapter reuses
`domains::bookings::queries` and keeps organization scope in the normalized delegated context;
no booking mutation or agent-side identity impersonation is introduced. The same Rust and Agent
verification gates pass, and generated capability documentation is refreshed.

The campaign read follow-up `73fec2b` exposes organization-scoped WhatsApp campaign inventory and
single-campaign summaries through `kasitek.core.campaigns_list` and
`kasitek.core.campaign_summary`. It reuses the existing campaign service queries, keeps recipient
and template-sensitive fields classified in the manifest, and leaves send/pause/resume/retry
mutations behind their existing product and approval paths. Rust format/check/library tests pass
(85 passed, 3 infrastructure-gated ignored); Agent tests pass (33 files, 149 passed, 24
environment-gated skipped); and the Agent TypeScript build passes.

The template read follow-up `7039b13` exposes the existing organization-scoped WhatsApp template
catalog through `kasitek.core.templates_list`, with an optional approved/pending/rejected/disabled
status filter. Provider synchronization and template creation remain separate product-admin
operations; the Agent capability is read-only and carries template-body/button redaction metadata.
The generated capability catalog and client/core transport tests were updated; the same Rust and
Agent verification gates pass.

The Agents detail capability panel now groups tools by domain, shows permission/risk/approval and
availability state, supports explicit refresh/retry, and prevents misleading grants when a
dependency is unconfigured or unhealthy (`e1d5485`). Client TypeScript, targeted ESLint, and the
full Next production build pass; authenticated browser interaction remains a separate release
gate.

The contacts list mobile layout now uses separate keyboard-accessible list-open and actions
controls instead of nesting a dropdown inside a button (`2bcc990`). This prevents action clicks
from accidentally navigating the list and removes invalid nested interactive markup. Client
TypeScript, targeted lint, and the production build pass.

The WhatsApp model follow-up moves the completed connection, template, campaign, contact/list, and
inbox transport DTOs/rows into `db::whatsapp_models`; `db::models` re-exports them during migration
so existing adapters retain source compatibility (`7daf4da`). Call-specific models and the broader
global model cleanup remain open under the next decomposition checklist item.

Call-specific persistence rows and request DTOs now live in `db::call_models`, with the existing
`db::models` imports preserved through re-exports for the voice/WhatsApp call adapters (`afb64dc`).
The remaining global model cleanup is now limited to shared conversation/message and other
cross-domain DTOs that still need an owning boundary.

Shared inbox conversation/message rows and the conversation update DTO now live in
`db::inbox_models`; `db::models` continues to provide compatibility re-exports for social, WhatsApp,
and inbox adapters (`7baa1ae`). Remaining global model work is limited to other cross-domain or
legacy product DTOs; no runtime contract changed in this slice.

Social channel/post/publishing rows and request DTOs now live in `db::social_models`, with the
global model file retaining compatibility re-exports while the decomposed social services migrate
their imports (`b8dec88`). The remaining cleanup is limited to shared auth, billing, notification,
and legacy product DTOs; this slice also leaves all route and wire contracts unchanged.

Notification inbox rows and browser push subscription/action DTOs now live in
`db::notification_models`, with compatibility re-exports retained for notification controllers and
push services (`cf94066`). Remaining global model work is now auth, billing, website, and other
legacy product DTO ownership.

Website quote/waitlist/business-profile DTOs and AI/social ideation requests now have owning modules
(`db::website_models`, `db::ai_models`) while `db::models` preserves compatibility re-exports
(`dd5338c`). The global model file now contains the remaining auth/admin session records and a small
legacy surface; the model-cleanup checklist item still needs those final ownership decisions and
obsolete-function removal review.

The final auth/admin session rows and authentication/profile request/response DTOs now live in
`db::auth_models`; `db::models.rs` is now a compatibility-only re-export surface across all migrated
domains (`f7a7a99`). The model cleanup item is now closed against the blueprint; active controller
exports were retained because callers and parity tests still depend on them.

The structural migration verification gate is now recorded as complete: every coherent backend
slice in this run was followed by `cargo fmt --check`, `cargo check -p kasitek-core`, and
`cargo test -p kasitek-core --lib`; the current result is 85 passed and 3 explicitly ignored
infrastructure cases.

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
