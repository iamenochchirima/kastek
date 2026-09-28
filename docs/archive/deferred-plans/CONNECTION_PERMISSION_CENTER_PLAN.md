---
id: connection-permission-center
title: Shared Connection Permission Center
status: active
owner: platform-integrations
---

# Shared Connection Permission Center

## Outcome

Make provider authorization understandable and recoverable for every agent and gateway. A
workspace user should be able to see what a connection can do, grant missing access without
deleting the connection, and understand when a provider or connection type cannot offer a
capability.

The first production slice is Meta/Facebook/Instagram because published Instagram deletion is the
current user-facing failure. The implementation must establish the provider-neutral seam before
adding more providers.

The remaining implementation phase extends that seam to every connected provider. It covers
WhatsApp Embedded Signup, provider-specific permission adapters, and one access endpoint that the
client can use without knowing which OAuth or setup flow a provider needs.

The cross-agent execution follow-up is tracked in
[`AGENT_TOOL_ACTION_READINESS_PLAN.md`](../../plans/completed/AGENT_TOOL_ACTION_READINESS_PLAN.md). That plan extends
the connection access result into a universal preflight and terminal-remediation contract for
provider-backed tools and gateways.

## Current boundary

The existing `ExternalConnectionCapability` inventory describes KasiTek product capabilities such
as `SOCIAL_PUBLISH` and `AGENT_CHANNEL`; it is not a verified inventory of provider OAuth grants.
Some provider metadata contains raw scopes or permissions, but there is no consistent permission
model, request flow, or feature-level remediation contract. The connection detail sheet currently
offers a generic reconnect action.

The design therefore separates:

1. **Provider grant** — the scopes, Page tasks, account roles, or provider-specific authorization
   state returned by the provider.
2. **KasiTek capability** — the product action enabled by that grant, connection type, provider
   support, workspace entitlement, and health state.
3. **Feature requirement** — the capability required by a concrete action, such as deleting a
   published Instagram post.

Connection health and authorization state remain separate. A connection may be healthy for
publishing while missing content-management access for deletion.

## Product decisions

- Use product-facing access groups in the KasiTek UI. Do not expose raw OAuth scope names unless a
  provider's own consent screen displays them.
- Use `Grant access` or `Review access` for an existing connection. Do not tell users to disconnect
  unless the provider genuinely requires a new connection identity.
- Reauthorization must upsert the existing logical connection and preserve local posts, drafts,
  agent routes, and history.
- Show checkboxes only for capabilities that the provider adapter confirms are requestable. Some
  providers use fixed consent bundles, embedded signup, account roles, or app review instead of
  arbitrary per-scope selection.
- The agent may explain a missing capability and open a guided remediation path, but it must never
  grant provider permissions or silently authorize a destructive action.
- Provider adapters own raw scope names, token inspection, account-task interpretation, and OAuth
  URL construction. Core and Agent Platform use normalized capability keys and bounded reason codes.

## Shared domain model

### Permission state

Each connection capability has one of these states:

- `GRANTED` — verified by the provider or a trusted account/task response.
- `NOT_GRANTED` — verified as absent.
- `REQUESTABLE` — not currently granted and can be requested through a supported flow.
- `UNSUPPORTED` — not available for this provider/authentication mode.
- `UNKNOWN` — the provider does not expose enough information to verify it.
- `REQUIRES_PROVIDER_APPROVAL` — the app or business must be approved before it can be granted.

`UNKNOWN` must not be presented as `NOT_GRANTED`.

### Initial access groups

- `MESSAGING` — receive and reply to conversations.
- `PUBLISHING` — create, schedule, and publish content.
- `MEDIA` — upload, read, and manage media used by content.
- `ANALYTICS` — read provider performance and audience metrics.
- `COMMUNITY` — manage comments and supported interactions.
- `CONTENT_MANAGEMENT` — edit or delete published provider content.

The exact capability keys remain separate from these display groups. For example,
`SOCIAL_POST_DELETE` belongs to `CONTENT_MANAGEMENT`.

### Provider adapter interface

Create a small, deep integration seam with provider implementations behind it. The interface
should operate on product capabilities rather than raw scopes:

- `catalog(connection_context)` — supported access groups, descriptions, auth mode, and provider
  limitations.
- `inspect(connection)` — normalized current grant snapshot and verification source.
- `plan_request(connection, requested_capabilities)` — validate requestability and produce a
  provider-specific authorization plan.
- `begin_request(plan)` — create a short-lived, organization-bound authorization attempt and start
  the provider flow.
- `reconcile_callback(attempt, callback)` — exchange credentials, inspect the actual grant, upsert
  the existing connection, and return the normalized result.
- `classify_failure(error)` — return a bounded reason code, remediation, and whether the user can
  retry.

The module interface should be stable while provider implementations vary. This is the main seam
that lets future agents and gateways use the same permission center.

## User flows

### First connection

1. User chooses a provider and account/authentication mode.
2. KasiTek presents the supported access groups with concise descriptions and sensible defaults.
3. User can remove optional access where the provider supports that choice.
4. KasiTek sends the user to the provider's consent or setup flow.
5. The callback records the actual granted access, not merely what KasiTek requested.
6. The result shows connected account, granted access, unavailable access, and any provider-review
   requirements.

The provider's own consent UI remains authoritative. KasiTek's modal explains the product impact;
it cannot manufacture provider-level granularity that the provider does not support.

### Existing connection detail

Add an `Access` section to the connection detail sheet. It shows grouped access with status, a short
reason, and the action available for that state. Requestable items are multi-selectable. The action
is `Grant access` or `Review access`, never a generic reconnect.

The existing product `Capabilities` section remains useful, but it must not be renamed or treated as
the provider grant inventory. It should link to the more precise Access section.

### Feature-triggered remediation

When a feature is blocked by authorization:

1. Core returns a typed `authorization_required` result containing the provider, safe connection
   reference, required product capabilities, current state, requestability, and remediation mode.
2. Agent Platform renders a concise explanation and a safe connection-access action for supported
   channels.
3. The client opens the connection-specific modal with the required capabilities preselected.
4. The user grants access or sees the exact unsupported/provider-approval reason.
5. The client refreshes the permission snapshot and tells the user to retry. Destructive actions
   are never executed merely because reauthorization completed.

For the current Instagram deletion case, the message should identify content-management access,
explain that Meta/Facebook Login is required for that connection mode, and state that disconnecting
is not necessary.

## Provider rollout matrix

The matrix is part of the implementation and must be backed by provider fixtures and production app
configuration, not assumptions.

| Provider/auth mode | Inventory source | Incremental request | Initial scope |
| --- | --- | --- | --- |
| Meta/Facebook Login | token permissions, Page tasks, linked Instagram account | verify and enable only where app/provider supports it; otherwise reauthorize the same connection | first |
| Instagram Direct Login | returned Instagram permissions and account capability | provider-dependent | first, with explicit unsupported deletion state where applicable |
| WhatsApp Embedded Signup | WABA, phone number, token, and setup state | embedded/provider setup flow | second |
| Threads | OAuth grant and provider response | provider-dependent | follow-up adapter |
| TikTok | OAuth grant and provider response | provider-dependent | follow-up adapter |
| LinkedIn | OAuth grant, member/org roles, and approved products | provider-dependent | follow-up adapter |
| X | OAuth grant and token scope | provider-dependent | follow-up adapter |
| Bluesky | authorization/session capabilities | provider-specific | follow-up adapter |

If a provider does not expose a reliable permission inventory, show `Unknown` and verify the
capability at action time with a structured provider error. Do not claim access based on requested
scopes alone.

## Data and API work

- Add normalized permission snapshot data linked to the canonical `ExternalConnection`; do not make
  Agent Platform depend on provider-specific `metadata` fields.
- Add authorization-attempt data with organization, user, connection, requested capabilities,
  auth mode, expiry, outcome, and bounded failure code. Store no raw access token in this record.
- Keep provider-only credential and raw response handling inside Core's encrypted source records.
- Extend connection reads with a safe authorization summary or add a connection-access endpoint.
- Add an access-request endpoint that accepts product capability keys, validates them against the
  provider adapter and current connection, and starts a short-lived OAuth/setup flow.
- Bind OAuth state to user, organization, connection, requested capabilities, nonce, expiry, and
  PKCE where supported. Do not trust organization or connection identifiers from the callback.
- Preserve the existing logical connection identity on reauthorization and make callback upserts
  idempotent.
- Return a typed authorization-required error from publishing, messaging, analytics, media, and
  agent-channel operations when the provider response identifies missing access.
- Keep raw scopes out of Agent Platform responses, agent prompts, analytics payloads, and user
  messages.

## Agent harness integration

The Agent Platform contract should expose a provider-neutral authorization requirement containing:

- required capability keys;
- connection/provider display information;
- safe reason code;
- whether the request is supported;
- whether a user action is required;
- a client remediation reference or deep-link intent.

Agents should describe the blocked action and point the user to `Grant access`. They should not
invent permissions, ask users to paste tokens, or tell users to disconnect by default. Every agent
connected to every gateway consumes the same contract; gateway-specific rendering remains at the
gateway boundary.

## Security and privacy

- Only authorized workspace connection administrators may inspect or request access.
- Never expose access tokens, refresh tokens, authorization headers, raw token-debug payloads, or
  full provider webhook bodies.
- Store only allowlisted normalized permissions in the shared permission snapshot.
- Make authorization attempts single-use and short-lived; reject replayed or cross-workspace state.
- Preserve connection and local content identity across reauthorization.
- Treat provider-reported granted access as authoritative and reconcile revoked permissions on each
  supported inspection.
- Keep the original approval and idempotency rules for publishing/deletion. Reauthorization does
  not bypass an action approval.

## Implementation checklist

### Phase 0 — contracts and provider evidence

- [x] Inventory current raw scope/permission metadata and OAuth modes.
- [x] Define the capability-to-provider-permission registry for the Meta/Instagram first slice.
- [ ] Verify Meta app review, Advanced Access, Page tasks, Instagram account linkage, and deletion
      requirements in production configuration. The exact code-side permission set and external
      dashboard checklist are documented; Meta's approval itself remains an operator gate.
- [x] Define normalized authorization reason codes and the `connections_access` client remediation intent.
- [x] Add unit fixtures for granted, missing, unknown, declined-attempt, unsupported, and
      provider-review state derivation. Full provider HTTP fixtures remain a release gate.

### Phase 1 — Core permission center

- [x] Add normalized permission and authorization-attempt persistence.
- [x] Implement the provider permission seam and Meta/Instagram request mappings.
- [x] Implement inspection, request planning, callback reconciliation, and idempotent upsert.
- [x] Add permission summaries to connection reads and access requests to the existing OAuth routes.
- [x] Include normalized authorization requirements in published-post deletion results.
- [x] Map Meta Login Instagram published-content deletion to `instagram_manage_contents`; retain
      the Direct Instagram Login limitation until Meta exposes an equivalent permission.

### Phase 2 — shared client experience

- [x] Add first-connect access selection to the Meta/Facebook/Instagram provider connection flows.
- [x] Add the Access section and multi-select request action to connection details.
- [x] Replace ambiguous existing reconnect copy with `Grant access`, `Review access`, or a precise
      provider limitation.
- [x] Support a connection-specific access deep-link on the Connections page
      (`connectionId` + requested capability keys).
- [x] Wire feature-triggered authorization results in web, WhatsApp, Telegram, and other gateway
      clients to that deep-link/modal. Web agent transcripts render a shared access action; external
      delivery uses the same bounded contract and keeps each gateway's native formatter.
- [x] Use the existing Sheet/Dialog primitives, native form controls, labelled actions, and
      focus-visible remediation links with explicit loading/error handling.
- [ ] Verify keyboard navigation, focus handling, responsive layout, and loading/error states.

### Phase 3 — Agent Platform and gateways

- [x] Add the provider-neutral authorization summary to Agent API/runtime connection results.
- [x] Add authorization details to the published-content deletion tool result.
- [x] Render safe remediation in web, WhatsApp, Telegram, and other gateway adapters.
- [x] Preserve gateway-specific link/button behavior without duplicating permission logic.
- [x] Ensure every agent receives the same capability result and no raw provider scope.

### Phase 4 — provider expansion and release

- [x] Add WhatsApp Embedded Signup capability inspection and guided setup.
- [x] Add remaining provider adapters only after their support matrix is verified.
- [x] Add first-slice unit, runtime, gateway, and Core integration regression coverage.
- [ ] Run provider HTTP fixtures, browser UI verification, security review, and controlled production
      OAuth smoke tests.
- [ ] Enable behind a feature flag, monitor outcomes, and retire generic reconnect remediation after
      the rollout review.

### Phase 5 — shared access endpoint and provider completion

- [x] Add `GET /api/connections/{id}/access` for the normalized access snapshot.
- [x] Add `GET /api/connections/{id}/access/request` for provider-neutral access requests.
- [x] Route Meta, Instagram, Threads, TikTok, LinkedIn, X, Bluesky, and WhatsApp through the
      provider adapter seam without exposing provider scopes to clients or agents.
- [x] Persist and reconcile WhatsApp Embedded Signup permissions from the token and WABA setup.
- [x] Preserve existing provider-specific first-connect flows while making reauthorization use the
      same short-lived authorization-attempt record.
- [x] Add provider adapter contract tests for supported, unavailable, requestable, and
      provider-approval states. Full provider HTTP fixtures remain a release gate.

## Release record

Change: Shared provider-neutral connection access inspection and guided reauthorization, including
Meta Login Instagram published-content deletion access.

Owner: Platform integrations.

Risk: standard.

Affected services and user surfaces: Core connection API and Meta Instagram provider deletion
authorization, Connections UI, and agent-facing connection summaries.

Platform release version or release ID: not applicable until the repository release is cut; record
the deployed commit SHA and migration versions at release time.

API/schema/migration changes: No new schema or route changes in this follow-up. The existing
provider-neutral access route now maps Meta Login Instagram deletion to
`instagram_manage_contents`. The original permission-center migrations remain required:
`20260831150000_add_connection_permission_center`,
`20260831170000_add_whatsapp_provider_permissions`, and
`20260831180000_add_whatsapp_auth_method`.

Feature flag or rollout method: not applicable in code; use the existing Connections UI rollout and
stage provider access by environment.

Analytics events and success metrics: Existing connection lifecycle and health events remain the
source of truth. Monitor completed/declined/failed authorization attempts, permission inspection
failures, and provider deletion outcomes; no new undocumented event is introduced.

Logs, metrics, dashboards, and alerts: Structured OAuth/provider failure logs use bounded provider
and operation fields. No token or raw provider response is logged. Add provider authorization and
WhatsApp setup failure panels to the production connection runbook/dashboard before rollout.

User, API, internal, and operational documentation: Updated the public Social Connections guide,
Core configuration README, connection failure runbook, and this plan. The provider research note
records the first-party support matrix.

Validation evidence: The focused permission-center regression tests pass, including requestable
and granted Meta Login Instagram deletion states and the generated
`instagram_manage_contents` request scope. The full Core suite, provider HTTP fixtures, browser
checks, security review, and production OAuth/delete smoke test remain release gates.

Rollback or disable plan: stop exposing access-request actions, keep existing provider-specific
connect routes available, and roll back application code only after the additive migrations are
applied. Existing credentials and logical connection records remain intact.

Post-release review date: set by the release owner after the first production smoke tests.

## Acceptance criteria

- A user can inspect current access for an existing connection without exposing credentials.
- A missing Instagram deletion permission identifies the exact access and the correct Meta auth
  mode.
- Reauthorization updates the existing connection without requiring disconnect/reconnect deletion.
- Multi-select is available only for provider-supported requestable capabilities.
- Unsupported and provider-review states are explicit and actionable.
- A feature failure produces a structured authorization requirement, not only a generic provider
  error.
- The same contract works for every agent and gateway.
- Existing connection, publishing, approval, and audit behavior remains intact.

## Open implementation decisions

- Confirm the exact first-connect default groups for a new connection versus an agent-specific
  feature request.
- Confirm which Meta permissions are approved for the production app and which require App Review or
  Advanced Access.
- Confirm whether the first client release should expose raw provider limitations in a details
  drawer or only concise product-level explanations.
