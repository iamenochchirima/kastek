---
title: Growth agent access operations
owner: engineering
last_reviewed: 2026-11-03
---

# Growth agent access operations

Growth implements OAuth MCP, canonical REST and direct internal execution over the same
operation catalogue. The platform hosting release deployed these endpoints; the local evidence
below does not establish a completed native ChatGPT connection. See
`docs/operations/platform-0.2.0-release.md` for deployment evidence. The public contracts
are [MCP integration](https://docs.kasitek.co.za/api/mcp-integration) and
[Agent REST](https://docs.kasitek.co.za/api/agent-rest).

The [coverage matrix](../architecture/growth-operations.md) records implemented operation families
and exclusions. [ADR 0001](https://github.com/Kasitek-Labs/kastek/blob/main/products/growth/docs/adr/0001-growth-owned-delegation-and-operation-parity.md) records
the ownership decision. Managed defaults and publication target revision `13` (adapter release `10`);
retained requests at revisions `2`–`12` keep their matching publication and adapter. Revision `13`
lets the Assistant delegate to all three specialists and lets Content/Campaigns delegate focused
evidence work to Research. Upgrade an existing workspace
explicitly with `pnpm --filter @kasitek/growth-core agents:setup upgrade-defaults <organization-id>`;
the setup worker must be running. Customized selections and existing task versions remain pinned. Revision `13` describes the
consolidated source; it does not establish which publication is serving in production.

## Configuration and migrations

Use the externally reachable Core `KASITEK_CORE_PUBLIC_URL` as issuer and MCP resource origin,
and `FRONTEND_URL` as the consent/review UI origin. Keep these values stable once clients connect.
Changing them invalidates resource-bound connections. The production web server can proxy
`/api`, `/v1`, `/mcp`, OAuth protocol endpoints and well-known discovery to the configured Core
origin when clients use the web origin. `/oauth/consent` remains a frontend SPA route. Keep the
configured public issuer/resource consistent with the origin clients actually use; a proxy does
not make differently issued resource tokens interchangeable. Existing Keycloak session configuration
remains required for consent; OAuth creates no separate login credentials.

`GROWTH_AGENT_ACCESS_ENABLED` and `GROWTH_AGENT_EFFECTS_ENABLED` must explicitly equal `true` in
production. Agent access gates MCP, canonical REST, typed canonical aliases and discovery.
External effects can be disabled while leaving reads and requested private drafts available. Local nonproduction environments allow
access/effects unless explicitly disabled. `GROWTH_MCP_ALLOWED_ORIGINS` is a comma-separated
allowlist of additional browser client origins. Exact Growth frontend origin is always allowed;
nonbrowser clients need not send Origin. Do not use wildcard origins for bearer access.

Apply the product's normal controlled database migration process with backup and a reviewed
artifact. The additive migrations are:

- `20261101130000_growth_oauth`: client registration, consent requests, authorization codes,
  independently revocable connections and refresh-token families;
- `20261101140000_growth_operation_reviews`: durable exact-input reviews and results;
- `20261101150000_growth_media_transfers`: scoped, expiring media transfer state;
- `20261102190000_content_agent_workflows`: nullable, constrained `decisionSource` audit column.

- `20261102200000_content_mcp_app_confirmation`: retained historical `mcp_app` source;
- `20261102210000_content_requested_actions`: adds `requested_action` for authorized content execution;
- `20261103110000_content_media_library`: additive media metadata, indexes and durable mutation receipts;
- `20261103111000_content_templates`: social templates, retained media references and mutation receipts.

Apply each migration once using the existing ledger procedure. The former
`GROWTH_MCP_CONFIRMATION_SECRET` is no longer consumed by the MCP route. Retain historical receipts
and additive schema during rollback. Deployment evidence belongs in
`docs/operations/platform-0.3.0-release.md`; never commit an environment export.

Analytics separately requires `services/analytics/migrations/20261101160000_growth_agent_access.sql`
to permit the existing `core-customer-analytics` producer's Growth namespace. Its registry version
is `20261101.1`. This is a separate product database migration; it preserves unrelated grants.
Apply it through the Analytics release process before enabling lifecycle ingestion.

The internal read-access protocol additionally requires the Growth Prisma migration
`20261103100000_growth_read_access_handles`. It widens the existing source-handle ID check
to admit separate receipt and access-scope namespaces while preserving existing handles.
Apply it before starting any worker that requests `access-v1` or `effect-status-v1`; the local restoration described
below does not establish that this newer migration has been applied.

The same private handle store records a saved-review status scope for reviewed effects. It verifies
the current actor, tenant, operation entitlement, exact review identity and saved state; it does not
grant access to the review's private input, preview or result. Embedded media-transfer preparation
also records its actor-owned transfer and expiry; failed, finalized or expired transfers cannot be
reused in model context. Direct REST transfer behavior is unchanged.

The Prisma migrations mirror API SQL. Do not run both copies against the same schema. Code changes do not automatically apply migrations. During local restoration, the three additive
Growth migrations were explicitly applied to the current local API database on port `5433`, without
destructive changes. This does not establish a production or separate Analytics migration. Check installed
schema and required enum/index definitions before enabling traffic. Expired consent/code/token
records are rejected at use; periodic record-retention cleanup is not established by this change.
Plan retention for review input/results and transfer files using the deployment's privacy policy.

## OAuth and authority

Discovery is at `/.well-known/oauth-protected-resource`, its `/mcp` alias, and
`/.well-known/oauth-authorization-server`. `/oauth/register` accepts bounded public-client
metadata; metadata-document URLs require public HTTPS with DNS/IP validation, pinned resolution,
request deadlines and no redirects. CIMD `token_endpoint_auth_methods_supported` is a validated
nonempty string list and must include `none`; its legacy singular authentication preference does
not override a mutually supported public method. Without a choices list, the singular method
must be `none` or omitted. Dynamic registration still requires the singular public method;
CIMD negotiation does not change registration or PKCE/token validation. Registration is limited
per IP and by total stored clients.
`/oauth/authorize` requires PKCE S256 and the exact MCP resource. Consent inspection binds its
opaque request to the existing signed-in user. The user selects an actual member workspace and
can narrow requested scopes. Consent and code use are single-use under database locks.

Access tokens last one hour and refresh tokens 30 days. Refresh rotates both, and replay revokes
the connection family. `/oauth/revoke` and workspace connection deletion revoke only that
connection. Account-wide logout and verified subject revocation revoke the user's delegated
connections; ordinary session logout and `sid`-only backchannel logout retain them. Tokens and
refresh secrets are stored as digests and must never enter logs or support exports.

Canonical reads include authorized business/customer data; do not assume an API alias removes
message content or phone numbers. Scopes never cross workspaces, and `api:write` never implies
`growth:publish`. Existing provider/account permissions still limit available actions. A working
MCP connection is not evidence of working provider publishing, comments, messages or analytics.

## Reviews, recovery and observations

All authorized content writes execute through the durable operation ledger without mandatory
Growth human approval. Private drafts/media record `requested_draft`; public/destructive content
execution records `requested_action`. Neither value means a human approval was observed. Historical
`growth_ui`, `mcp_form`, `mcp_app` and null provenance remains intact. Non-content reviews are unchanged.

`content.actions.preview` is an optional normal model-readable operation. It freezes exact input,
content/media/account revisions, destinations, timing and readiness. Preview-only calls return
`prepared` and never contact providers. A supplied `_previewId` is checked against current authority,
unchanged input and expiry before execution; execution without one validates the current snapshot.
The MCP adapters use ordinary tools with accurate write/destructive annotations. There is no
mandatory form, embedded approval card, app-only confirm control or browser approval detour.

Existing manual review pages still inspect their persisted requests. Their polling only reads
state. Internal content actions use the same canonical handlers, current authority and receipts
without a public MCP round trip. Ordinary calls do not fabricate approved events. Verify direct
MCP content execution, optional preview, duplicate/unknown outcomes and revoked/stale denials rather
than requiring a custom card render or button click.

An executing or uncertain receipt must be reconciled before retry; do not mint a fresh request
identity to force another effect. A succeeded receipt returns the stored result. Revocation or
membership loss prevents further execution even if a review was previously approved. Queued
publication additionally retains delegated authority for worker-side checks. Review snapshots compare
account revisions under locks before admission. Queued work binds the selected account identity,
workspace, account owner and platform; token maintenance may rotate credentials without changing
that identity. Workers check connection status and delegated authorization separately before provider
calls. Existing domain status/retry rules remain authoritative for provider outcomes.

Reviewed actions that depend on an existing post, publishing account, contact and list membership,
conversation, or external connection also pin independent database revisions for those resources. These revisions
advance for every database writer, independently of the millisecond `updatedAt` audit timestamp.
The owning operation checks the pinned revision under its row lock or atomic claim; a concurrent
change requires a new review. The revision is private and is stored as an exact decimal string in
the review snapshot or its account digest. The older draft-review path also includes the publishing
account revision in its digest. A previously proposed or approved review without the new revision
contract requires a new review. Succeeded, executing and uncertain actions retain their existing
receipt and status-only reconciliation path; a missing old revision never authorizes another external
send. Existing product clients that supply only `expectedUpdatedAt` still use their timestamp
precondition; this change does not turn those clients into revision-based compare-and-swap writes.
An exhausted 64-bit revision rejects the update instead of wrapping.

Observations are bounded to an 8 KiB envelope. Larger JSON uses digest-bound continuation chunks,
with a 2 MiB total ceiling. Media transfers stage bytes separately and bind transfer identity to
workspace, user and credential; staging alone cannot publish. Exact provider readiness, scheduled
worker restarts and reconciliation require their own provider acceptance checks.

For canonical Growth reads, a shared worker may request the internal `access-v1` observation
protocol. Growth captures the authorized resource identities before result chunking, then returns
an opaque private receipt and a reusable authorization scope. Both remain outside the model-visible
result. Receipt identity binds the original task and operation; a retry with changed arguments,
result or source identities is rejected. The reusable scope binds the actor, conversation, pinned
operation and resource identities, so repeated reads of the same scope do not create a new policy
dependency each time. Growth stores these references in `GrowthAgentSourceHandle` without copying
the returned content.

A read scope may contain at most 131,072 distinct resource and relationship references; the
existing 2 MiB source-result ceiling also applies. A result above either bound is unavailable.
Reference retention beyond the existing organization and user cascading deletes has not yet been
established.

An evidence check verifies the actor's current membership and operation entitlement, the original
binding and conversation, and each captured resource or relationship. Reporting checks resolve the
current product scope and issue the same actor-scoped grant without running the report again. Exact
review ownership and entitlement are checked without repeating any reviewed effect. This protocol
confirms current access to an observed result; it does not claim the business content is unchanged,
create source citations or guarantee provider unlearning. Read results whose identities cannot be
established are unavailable. A media preview reference expires with its signed URL. Newly requested
signed URLs stay inside Growth; agent tool results contain the asset metadata and preview readiness. Existing
retained agent receipts are projected again before model history is read. The ordinary Growth media
preview endpoint retains its existing behavior. Inbox summaries
retain the identity of the message that supplied their preview; messages with unattributable quoted
text or withdrawn message content fail closed.

`access-v1` is optional on the signed internal invocation. Older workers receive the previous
response shape. New workers must treat a missing or invalid negotiated reference as unavailable and
must preserve the reference and information audience before exposing the result to a model. Exact
write-review, commit and reconciliation responses are not covered by this read protocol; their
separate current-authority and receipt checks remain in force.

Draft created/updated webhook events originate in canonical dispatch, so successful receipt
replay does not enqueue them again on a typed alias. Enqueue failure is logged without turning
a completed draft save into a fresh retryable effect. This does not introduce an atomic domain
outbox guarantee for those events.

## Observation and verification

`PublicApiRequest` and registered `public_api_requests` usage record canonical invocation and
legacy typed HTTP audit. A typed alias reuses its existing reservation, avoiding duplicate
rate charging. Structured OAuth logs contain bounded event/outcome metadata; MCP logs include
operation, duration and bounded errors. Tokens, authorization headers and full customer content
must be absent. The registered `growth.agent.access@1` event records kind, action, operation and outcome.
Operation proposed/approved/rejected/succeeded/uncertain/failed transitions enqueue it atomically
with review state. OAuth granted/revoked events are recovered from immutable connection timestamps
by the existing analytics publisher loop. The durable outbox retries ingestion failures; configure
the existing ingestion token and worker. Queued publication/scheduling success means admitted,
not published. Payloads contain no arguments, tokens, customer copy or personal data.

Existing Collector/exporter configuration is reused; this change does not
establish new hosted dashboards, alert retention or operational paging.

Local evidence uses a dedicated `growth_agent_access_test` PostgreSQL database and disposable
schemas. OAuth tests cover PKCE, consent/workspace isolation, racing code redemption, rotation,
refresh replay, expiry, revocation, membership loss and verified identity logout boundaries.
`growth-oauth.test.ts`, `growth-oauth-revocation.test.ts`, `identity.test.ts` and
`growth-operations.test.ts` passed 10 tests with no skips at the recorded checkpoint.
`public-api.test.ts` and `public-read-ports.test.ts` passed five tests with no skips, including
canonical typed personal-data parity, preserved contact filters, denied writes, rate audits and
signed webhook delivery. These are local engineering checks; they do not prove a hosted client
connection or live provider effect. The official MCP SDK 1.32.2 local HTTP suite additionally verifies all 44 input/output schemas,
actual OAuth exchange, signed internal reads, typed draft review/resume/replay, binary media and
delegated publication fixtures. The focused `playwright.oauth.config.ts` production-browser suite
passed eight tests: consent, MCP connection/revoke and exact action review across 390/768/1440px,
light/dark themes, reduced motion, keyboard focus, explicit API-key read/publish scope selection, pending controls and retained input after
errors; unavailable, expired and rejected states are covered. It uses controlled API fixtures,
independently from the real database/SDK suites. Success screenshots are captured in the ignored
`.playwright/oauth-results/` directory. Current web production build and focused ESLint passed.
Route/lexical-body/principal checks passed 17 tests with no skips and record 371 API routes.

Regenerate/check OpenAPI from `api/` with `pnpm exec tsx scripts/refresh-openapi.ts --write` or
omit `--write` to detect drift. It derives canonical schemas from the runtime catalogue and writes
both API and public documents. Route census uses `pnpm contracts:check`/`contracts:refresh`.
Final full-suite and cross-product runtime evidence belongs in the implementation handoff.

## Rollout and rollback

Start with disabled flags, apply the additive schema in a controlled environment, configure
issuer/frontend/origins, and enable access for an owned test workspace. Exercise discovery,
real OAuth authorization/refresh, scoped tool listing, optional exact previews, direct authorized content execution, independent
revocation and actual internal/REST/MCP result comparison. Verify user/workspace separation and
capture the deployed release/config identity. Enable effects separately only after reviewing
provider fixtures and required provider approval.

Disable `GROWTH_AGENT_EFFECTS_ENABLED` first for unsafe effects; disable
`GROWTH_AGENT_ACCESS_ENABLED` for an access or consent incident. Revoke affected OAuth connections
and Developer keys as appropriate. Disable flags do not undo external effects already executed.
Stop new lifecycle event production/publishing if rolling back analytics; retain its durable outbox and event receipts.
Rollback the API/web artifacts together while retaining additive tables and receipts. Do not
remove review or token history while queued work or reconciliation needs it. Re-enable only
after rechecking approved pending work and delegated worker authority. A deployment owner must
complete hosted smoke checks and set the post-release review date.
