---
title: Growth agent access operations
owner: engineering
last_reviewed: 2026-11-02
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
the ownership decision. Managed defaults and publication both target revision `9` (adapter release `6`); retained
requests at revisions `2`–`8` keep their matching publication. Upgrade an existing workspace
explicitly with `pnpm --filter @kasitek/growth-core agents:setup upgrade-defaults <organization-id>`;
the setup worker must be running. Customized selections and existing task versions remain pinned.

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

Configure a dedicated `GROWTH_MCP_CONFIRMATION_SECRET` on Growth API. Production requires at least
32 bytes; do not reuse OAuth, session or another service's key. Rotation invalidates outstanding
sealed chat confirmations, so users must prepare fresh previews; it does not revoke OAuth grants.
The 0.3.0 production secret was staged separately; migration and deployed-artifact evidence belongs
in `docs/operations/platform-0.3.0-release.md`, not in an environment export committed to Git.

Analytics separately requires `services/analytics/migrations/20261101160000_growth_agent_access.sql`
to permit the existing `core-customer-analytics` producer's Growth namespace. Its registry version
is `20261101.1`. This is a separate product database migration; it preserves unrelated grants.
Apply it through the Analytics release process before enabling lifecycle ingestion.

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

Requested private content drafts, duplication, media upload and transfer preparation execute
directly with stable idempotency and durable receipts. Their ledger decision source is
`requested_draft`; Growth page approvals use `growth_ui`, and protocol form confirmations use
`mcp_form`; embedded MCP App decisions use `mcp_app`. Existing null values retain their historical meaning. Other effects keep exact review.

Public/destructive content actions first use `content.actions.preview` and its bound `_previewId`.
The `2026-07-28` MCP route prefers an embedded MCP App for clients declaring the supported MIME
type, with exact preview metadata and app-only controls. Its expiring HMAC token binds the current
credential, workspace, client, action, request and payload. It is delivered only in result `_meta`,
never model-visible text or structured content. The static resource bundles the official App SDK,
uses a strict CSP and renders user content as text. The card never approves on mount. Status reads
may reconcile existing receipts but cannot admit a new effect; nonce refresh does not extend the
review's original deadline. Ready owned media previews use the existing scoped signing operation.

The `20261102200000_content_mcp_app_confirmation` migration adds `mcp_app` to the decision-source
constraint. Apply its API SQL or Prisma mirror once through the existing ledger procedure before
rollout. Build/dev/test generate the ignored UI module via `mcp-app:build`; production runs the
already bundled artifact. The shared lockfile is an actual build input and remains watched by Node
backends; ordinary UI-source changes watch only the Growth roles.

Other capable modern clients use a required protocol form with an exact, untruncated preview.
Registered ChatGPT clients also require the OpenAI form extension. Missing or incomplete in-chat
confirmation returns `confirmation_unavailable` without a browser detour. The authenticated review
page remains an explicit manual/team operation. Preserve legacy read and direct-draft support;
legacy app controls additionally require declared per-request UI capabilities.

Controlled fixtures establish transport, authorization, replay and responsive rendering behavior.
Native acceptance separately verifies that this host loads the resource, displays the exact preview
and records a genuine user button click. Inspect bounded `app_ui_declared`/`app_ui_supported` logs;
never log raw capabilities, content, signed media links, tokens or hidden result metadata.

Every write retains the same stable idempotency path. Operation state is
separate from embedded draft-review state. Human review renders the persisted copy/variants, scheduled time, selected account identities,
media filenames and target identity where applicable, with the exact request under an expandable
disclosure. The preview participates in the immutable snapshot checked before execution.
The human review API uses the current signed-in user,
workspace and exact payload digest. The review page polls approved and executing actions until a terminal state or review expiry,
shows a saved-post link when available, and keeps raw results collapsed. Polling only reads state.
Approved external calls resume from the agent using their
original identity; signed embedded actions use verified product context. Direct UI editing keeps
its established explicit-human-action flow.

An executing or uncertain receipt must be reconciled before retry; do not mint a fresh request
identity to force another effect. A succeeded receipt returns the stored result. Revocation or
membership loss prevents further execution even if a review was previously approved. Queued
publication additionally retains delegated authority for worker-side checks. Review snapshots compare
account revisions under locks before admission. Queued work binds the selected account identity,
workspace, account owner and platform; token maintenance may rotate credentials without changing
that identity. Workers check connection status and delegated authorization separately before provider
calls. Existing domain status/retry rules remain authoritative for provider outcomes.

Observations are bounded to an 8 KiB envelope. Larger JSON uses digest-bound continuation chunks,
with a 2 MiB total ceiling. Media transfers stage bytes separately and bind transfer identity to
workspace, user and credential; staging alone cannot publish. Exact provider readiness, scheduled
worker restarts and reconciliation require their own provider acceptance checks.

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
real OAuth authorization/refresh, scoped tool listing, exact review, approved resume, independent
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
