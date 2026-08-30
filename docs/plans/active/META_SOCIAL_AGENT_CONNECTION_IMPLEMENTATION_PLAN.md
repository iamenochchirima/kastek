# Facebook and Instagram Agent Connections

**Status:** Implementation complete for the text-first release; production Meta acceptance pending

**Owner:** Product and Engineering

**Last updated:** 2026-08-30

## Objective

Allow a customer-service AI agent to be deliberately assigned to connected Facebook Pages and
Instagram Professional accounts from the agent detail screen. The assignment must be visible,
reversible, permission-aware, and functional: inbound Messenger or Instagram Direct messages must
reach the selected agent, and the agent's text replies must be delivered through the correct Meta
asset and recorded in the existing Inbox and Agent Platform histories.

The agent integrations screen must distinguish these states:

- the account is connected to the workspace;
- the account is ready to serve an agent;
- the account is assigned to this agent;
- the account is assigned elsewhere or has a routing conflict;
- the account needs Meta permissions, webhook, token, or app-review recovery.

`Manage` must not be a disguised redirect. Facebook Pages and Instagram accounts need real
agent-level actions with the same clarity already available for WhatsApp.

## Implementation record

The text-first implementation is now in place across Core, Agent Platform, and the client:

- Core validates that Facebook/Instagram agent routes point to a connected, organization-owned
  `ExternalConnection`; Meta credentials remain encrypted and Core-owned.
- Meta webhook text events are persisted in Inbox and forwarded to the assigned hosted
  customer-service installation. Agent Platform deduplicates provider events and preserves the
  existing human-handoff guard.
- Agent text replies use the existing Core Meta sender, persist delivery state in Inbox, publish
  realtime updates, and retain the Agent Platform idempotency key.
- Agent details show Facebook Page and Instagram account status, `Use`, `Assigned`, `Manage`, and
  `Remove` actions, with a responsive readiness/access dialog and reconnect path.
- No database migration was required; existing route uniqueness and connection status fields are
  sufficient for this release.

The remaining unchecked items are deliberate production acceptance or follow-up work: exact live
Meta permission/app-review evidence, dedicated Meta test-account acceptance, durable forwarding
retry/dead-letter handling, and richer media/interactive capabilities.

## Scope

### Included

- Facebook Page/Messenger assignment to customer-service agents.
- Instagram Professional account assignment to customer-service agents.
- Agent-detail `Use`, `Assigned`, `Remove`, and `Manage` states for Facebook and Instagram.
- A modal that explains readiness, required Meta actions, assignment consequences, and recovery.
- Core-to-Agent-Platform inbound message forwarding for Messenger and Instagram Messaging.
- Agent-to-Core outbound text delivery for Messenger and Instagram Messaging.
- Delivery/read status propagation, deduplication, retries, and provider error handling.
- Existing Meta OAuth connection paths, including Facebook Login and direct Instagram Login where
  they are already supported by the repository.
- Organization and installation authorization, assignment conflicts, audit, analytics, logs, and
  operational diagnostics.
- Tests using fixtures and a real dedicated Meta test Page/Instagram Professional account.

### Excluded from the first release

- Personal Facebook profiles or consumer Instagram accounts. Instagram must be a Professional
  account supported by the selected Meta API path.
- Facebook comments, Instagram comments, publishing, campaigns, or social analytics as agent
  conversations. Those remain separate product capabilities.
- Media, stickers, reactions, story replies, quick replies, buttons, persistent menus, or other
  provider-specific rich messages in the agent runtime. The first release should support text
  reliably and expose richer features only after the capability contract and fixtures are ready.
- Arbitrary Meta asset discovery outside the existing authenticated Connections flow.
- Raw Meta tokens, provider payloads, or customer message bodies in Agent Platform storage.
- Replacing the existing Inbox. Agent Platform routing must build on the existing Core Inbox and
  Meta channel records.

## Context and constraints

### Repository findings

The current implementation was inspected before writing this plan:

- `SocialChannelConnection` already stores Facebook Pages and Instagram accounts with encrypted
  access tokens, external asset IDs, display metadata, linked Page IDs, authentication method, and
  capability metadata in `server/kasitek-core/src/services/social_provider_connections.rs`.
- Meta Page and Instagram webhook subscription helpers already exist in
  `server/kasitek-core/src/services/social.rs`. The current fields include Page messages,
  echoes, postbacks, deliveries, reads, and Instagram messages, postbacks, seen, and reactions.
- `server/kasitek-core/src/services/inbox.rs` already resolves Meta webhooks to an organization
  connection, creates normalized Facebook/Instagram conversations, persists messages, handles
  text replies, marks messages read, and sends text through the appropriate Graph host.
- The Meta webhook path currently stops at the Core Inbox. Unlike the WhatsApp webhook path, it
  does not call `AgentPlatformClient::ingest_channel_message` for Facebook or Instagram.
- The Agent Platform channel table and API are generic enough to store a channel type and key, but
  the runtime's provider delivery and inbound-specific handling currently support WhatsApp,
  Telegram, Discord, and Website—not Facebook or Instagram.
- `client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx` only invokes
  `createAgentChannelConnection()` for WhatsApp. Facebook and Instagram rows render a `Manage`
  link to `/connections`.
- `server/kasitek-core/src/services/connections.rs` currently advertises `AGENT_CHANNEL` and
  `agents` consumers for Facebook and Instagram even though the runtime bridge is not implemented.
  The capability must become truthful during this work.
- The shared worktree currently contains unrelated uncommitted changes from another task. This
  plan must not absorb, revert, or reformat those changes.

### Product boundary

There are two distinct relationships:

1. **Workspace connection:** Meta account connected to the organization and usable by Inbox,
   publishing, or analytics.
2. **Agent route:** that workspace connection assigned to one customer-service agent installation
   so inbound customer messages can invoke the agent and replies can be delivered.

Connecting a Page or Instagram account to the workspace must not automatically assign it to every
agent. Assignment is an explicit action from the agent screen.

### Meta platform constraints

The implementation must verify the current Meta app configuration and requested access levels
against the production app before rollout. The following are the baseline requirements documented
by Meta's current API collections:

- Messenger Send API uses a Page access token and the Page `/{page-id}/messages` endpoint. The
  app needs `pages_messaging`; the token must come from a person with the required Page messaging
  task. Replies are subject to Meta's messaging window and policy rules.
- Messenger conversations and webhooks also require Page management/engagement permissions and
  Page webhook subscription. Advanced Access is needed for conversations with people outside the
  app/Page/business role set.
- Instagram Messaging through the Facebook Login path requires a Page access token for the Page
  linked to the Instagram Professional account, `instagram_basic`, `instagram_manage_messages`,
  and `pages_manage_metadata`; Meta documents that the app must be owned by a verified business.
- Instagram Messaging through Instagram Login uses the Instagram Professional account and its
  Instagram access token, with `instagram_business_basic` and
  `instagram_business_manage_messages`. Its Graph host and webhook setup differ from the
  Facebook Login path.
- Development/test access still requires the tester or account to have the relevant Meta app and
  asset roles. Production customer access requires the appropriate advanced access, business
  verification, and app-review configuration.
- Both providers can only start normal customer conversations when the customer has initiated
  contact or the applicable Meta policy window/approved message rule allows the outbound message.

Primary Meta references:

- [Meta Messenger Platform API collection](https://www.postman.com/meta/messenger-platform-api/documentation/iyp204x/messenger-platform-api)
- [Meta Messenger webhook collection](https://www.postman.com/meta/messenger-platform-api/folder/22794852-b5d97624-14d8-4e67-a2e4-529add49ca58)
- [Meta Instagram API collection](https://www.postman.com/meta/instagram/documentation/6yqw8pt/instagram-api)
- [Meta Tech Provider sample](https://github.com/fbsamples/business-messaging-sample-tech-provider-app)

These references are planning inputs. Before release, record the exact API version, permission
review result, test asset IDs, and app configuration revision used by KasiTek.

## Target user experience

### Agent integrations list

The current `Connected accounts` card should show the actual account-level state for every
Facebook Page and Instagram account returned by the workspace connection API.

Use provider-specific names in the row:

- `Facebook Page` rather than only `Messenger` for the asset being assigned.
- `Instagram Professional account` rather than only `Instagram`.

Each row should show:

- account name and handle/page identifier;
- workspace connection health: `Connected`, `Needs attention`, or `Disconnected`;
- agent route state: `Use`, `Assigned`, `Assigned to another agent`, or `Unavailable`;
- a short bounded reason when unavailable;
- the primary action appropriate to that state.

The provider header count should not imply that every workspace account is already assigned to the
current agent. Show separate counts where useful: `3 connected · 1 assigned`.

### `Use` modal for a ready account

Clicking `Use` opens a real application dialog, not a redirect. It should contain:

- the selected Page or Instagram account identity;
- workspace connection status and last health check;
- the agent that will receive new conversations;
- a concise routing consequence: new inbound messages from this asset will be sent to this agent;
- text capability summary for the first release;
- Meta window/policy limitation summary for replies;
- the assignment action and Cancel action.

The assignment button must remain disabled while the request is in flight and must show success or
failure inline/toast. Refresh the authoritative connection and agent route state after success.

### `Use` modal for an account needing setup

If the workspace connection is present but not ready, the same modal should show a checklist with
the exact failing prerequisite:

- Meta access token missing, expired, or rejected;
- Page messaging task missing;
- required permission missing;
- Page webhook not subscribed;
- Instagram account not Professional or not linked to a Facebook Page for the selected API path;
- app/business review or advanced access required;
- unsupported account or provider path;
- provider health check failed.

The modal may include `Reconnect Meta`, `Retry health check`, or `Open Connections` as contextual
actions. It must not claim that an agent is connected until the route is persisted and verified.

### Assigned state

When assigned to the current agent, show:

- `Assigned` status;
- `Manage` to open the route details modal;
- `Remove` to stop routing this asset to this agent, with an application confirmation dialog.

The Manage modal should show account identity, route status, last inbound event, last agent reply,
provider health, current capability limitations, and the remove action. Removing the route must not
delete or revoke the workspace's Meta connection.

### Assignment conflict

The first release must define and enforce one routing owner per workspace asset for customer-facing
agents. If the asset is assigned to another agent:

- show `Assigned to another agent` and identify the agent only if the current user is authorized
  to see it;
- do not silently move the route;
- offer `Request reassignment` only if a product decision and permission exist, otherwise show
  `Manage on that agent` or an authorized administrator action;
- make reassignment atomic and auditable if enabled.

The same Page or Instagram account may be used for multiple product surfaces, but inbound agent
routing must have one unambiguous destination unless explicit fan-out is designed and tested.

### Personal agents

Personal agents must not receive customer-facing Facebook or Instagram routes. The modal should
show a concise disabled state explaining that customer channels require a customer-service agent.
The server must enforce this regardless of the client state.

## Target architecture

### Canonical identity and routing key

Use the existing Core `ExternalConnection.id` as the Agent Platform `channelKey`, matching the
current WhatsApp bridge. Keep the underlying `SocialChannelConnection.id`, external Page ID, and
Instagram account ID in Core-owned metadata.

Recommended Agent Platform channel records:

```json
{
  "channelType": "facebook",
  "channelKey": "external-connection-id",
  "metadata": {
    "coreConnectionId": "external-connection-id",
    "provider": "meta",
    "assetType": "facebook_page",
    "pageId": "meta-page-id"
  }
}
```

```json
{
  "channelType": "instagram",
  "channelKey": "external-connection-id",
  "metadata": {
    "coreConnectionId": "external-connection-id",
    "provider": "meta",
    "assetType": "instagram_professional_account",
    "instagramAccountId": "meta-instagram-id",
    "pageId": "linked-page-id",
    "authMethod": "facebook_login"
  }
}
```

The Agent Platform must not receive access tokens. Core remains the only service that resolves
organization-scoped credentials and calls Meta.

### Assignment contract

Extend the channel assignment contract so the server accepts a workspace connection reference,
not an arbitrary client-supplied routing key. Core must validate:

- the connection belongs to the active organization;
- the provider is Facebook or Instagram;
- the external connection is connected and healthy enough for the selected capability;
- the installation belongs to the organization and is a customer-service hosted agent;
- the caller has agent/channel management permission;
- no conflicting active route exists, unless the explicit reassignment action is used.

The existing Agent Platform channel API can remain the persistence boundary, but Core must perform
the provider-aware validation and pass only a sanitized connection descriptor. If a new Core proxy
endpoint is needed, use one consistent assignment endpoint rather than letting the browser write
raw `channelKey` values directly.

### Channel types and capability registry

Add `facebook` and `instagram` to the supported Agent Platform channel contract. Make the capability
registry authoritative for:

- receives text;
- sends text/replies;
- receives attachments;
- sends attachments;
- reactions;
- read receipts;
- policy-window state;
- handoff and human response support;
- provider health and reauthorization requirements.

The first release should advertise only verified text receive/send capabilities. Do not leave the
current `AGENT_CHANNEL` capability claiming full Facebook/Instagram support while the runtime is
still unsupported. Either make it conditional on the route health/capability state or update the
registry as part of the implementation.

## Backend and integration checklist

### Phase 0 — contracts, permissions, and test assets

- [ ] Record the exact Meta app ID, Graph API version, app mode, business verification state, and
      configured Facebook Login/Instagram Login products.
- [ ] Audit the production app's requested permissions and access levels against the Meta
      requirements above.
- [ ] Confirm the dedicated test Facebook Page, Page access token path, linked Instagram
      Professional account, test users, and roles.
- [ ] Confirm the live webhook callback, verify token, app subscription, Page subscription, and
      Instagram account subscription configuration.
- [ ] Document whether Instagram will launch through the existing Facebook Login path, the direct
      Instagram Login path, or both. Do not silently merge their token/Graph-host semantics.
- [ ] Define the product policy for one asset assigned to multiple customer-service agents.
- [ ] Define the minimum healthy state that permits assignment: token valid, provider asset found,
      webhook subscribed, and text send/readiness check passed or explicitly marked pending.
- [ ] Define the policy-window and app-review error codes that are safe to show to workspace users.

### Phase 1 — data and assignment boundary

- [x] Audit `ExternalConnection`, `SocialChannelConnection`, Agent Platform `channel_connections`,
      and `channel_bindings` schema constraints and indexes.
- [x] Add an additive migration only if the existing records cannot represent provider asset type,
      route status, readiness reason, assignment revision, or last verified state.
- [x] Store `workspaceConnectionId`/`coreConnectionId`, provider asset IDs, and route metadata in a
      typed contract. Do not store Meta access tokens in Agent Platform.
- [x] Add a deterministic organization/provider/connection route lookup.
- [x] Enforce one active route owner per workspace asset according to the approved product policy.
- [ ] Add optimistic concurrency or a transactionally checked assignment revision.
- [x] Make assignment idempotent: repeated `Use` requests return the existing route instead of
      creating duplicates.
- [x] Make removal idempotent and preserve the workspace Meta connection.
- [ ] Add audit records for assigned, reassigned, removed, blocked, and recovery actions.
- [x] Add organization-isolation and installation-ownership validation; the Agent Platform route
      contract test covers the customer-service installation boundary.

### Phase 2 — readiness and status API

- [ ] Extend the workspace connection response or add an agent-specific readiness response that
      joins each Facebook/Instagram workspace account with the current agent route.
- [ ] Return explicit route status fields rather than making the client infer them:
      `connectionStatus`, `routeStatus`, `readiness`, `reasonCode`, `reasonMessage`,
      `assignedAgentId` where authorized, `lastCheckedAt`, `lastInboundAt`, `lastOutboundAt`, and
      `capabilities`.
- [ ] Implement a server-side readiness check that validates the connection token and fetches only
      safe asset metadata from Meta.
- [ ] Verify Page messaging permissions/tasks and webhook subscription state.
- [ ] Verify Instagram Professional account type, linked Page when using Facebook Login, required
      permissions, and account webhook state.
- [ ] Classify recoverable states (`needs_reauth`, `webhook_missing`, `permission_missing`,
      `provider_unavailable`, `policy_restriction`) with bounded codes.
- [x] Prevent the UI from showing `Assigned` if the assignment write succeeded but the route cannot
      be found on the subsequent authoritative read.
- [ ] Add readiness audit/log events without logging tokens, full payloads, or message content.

### Phase 3 — Meta inbound adapter to Agent Platform

- [x] Refactor the existing Meta webhook processing so normalization and Agent Platform forwarding
      share the same resolved channel and durable Core conversation.
- [x] After validating the Meta signature and persisting the normalized inbound message, forward a
      canonical Agent Platform envelope for customer messages:

      - `channelType`: `facebook` or `instagram`;
      - `channelKey`: Core `ExternalConnection.id`;
      - `provider`: bounded provider identifier;
      - stable `providerEventId` and `providerMessageId`;
      - Core conversation ID as the delivery lookup identifier;
      - provider-scoped customer identity;
      - normalized text content and safe display name;
      - message type and attachment metadata only when the capability is enabled.

- [x] Do not forward Meta echoes as new customer prompts. Persist them for Inbox history and use
      them to reconcile outbound Agent messages.
- [x] Deduplicate by provider event/message ID before forwarding. A webhook retry must not create a
      second Agent Platform message or second model run.
- [x] Preserve the existing Inbox transaction and realtime behavior when Agent Platform is down.
      Agent forwarding failure must be observable and retryable without causing Meta webhook
      redelivery storms.
- [ ] Add a bounded outbox or retry record for Core-to-Agent forwarding if the current synchronous
      call cannot guarantee eventual delivery.
- [ ] Add agent ingress metrics for received, ignored, deduplicated, accepted, failed, and delayed
      Meta events by provider and asset.
- [x] Forward only events supported by the first release. Keep reactions, read receipts, and
      unsupported media in the Inbox adapter until the Agent Platform contract supports them.

### Phase 4 — Agent Platform runtime routing

- [x] Extend channel validation and the channel catalog to accept `facebook` and `instagram`.
- [x] Keep channel connection creation restricted to Core-validated workspace connections; reject
      arbitrary Facebook/Instagram keys or cross-organization keys.
- [x] Resolve inbound routes by organization, installation, channel type, and Core connection key.
- [x] Ensure only active customer-service installations receive customer Meta messages.
- [ ] Add Facebook/Instagram to the normal model context and response channel metadata.
- [x] Preserve the existing handoff, human ownership, approval, and conversation lifecycle behavior
      for these channels.
- [x] Ensure a paused/human-owned conversation blocks automatic agent replies exactly as WhatsApp
      does.
- [ ] Add channel-specific routing diagnostics for no route, multiple routes, inactive agent,
      unsupported asset, and provider health failure.
- [x] Do not make the runtime depend on Meta credentials or call Meta directly.

### Phase 5 — Agent outbound text delivery

- [x] Extend the Core internal agent delivery boundary to accept `facebook` and `instagram`.
- [x] Refactor the existing Meta Inbox text sender so agent delivery can reuse its safe
      organization-scoped conversation lookup, token decryption, target asset resolution,
      idempotency, persistence, and realtime publication.
- [x] For Facebook Messenger, send through the Page access token to the Page `/{page-id}/messages`
      endpoint with the customer Page-scoped ID.
- [x] For Instagram using Facebook Login, send through the linked Page/Meta Graph path with the
      Instagram-scoped customer ID and Page access token.
- [x] For Instagram using Instagram Login, send through the Instagram Graph path using the
      Instagram account target and Instagram-scoped customer ID.
- [x] Keep the token and provider endpoint selection entirely server-side from connection metadata.
- [x] Persist the outgoing message before or as part of the delivery state machine, preserving the
      local Agent transcript and Core Inbox history.
- [x] Use the Agent delivery idempotency key to prevent duplicate provider sends after retries.
- [ ] Return bounded provider errors for policy windows, missing permissions, invalid recipient,
      expired token, rate limits, and provider outages.
- [x] Do not expose an attachment or interactive-button control until each exact capability is
      implemented and tested for both providers.
- [ ] Add delivery status reconciliation for Meta echoes, delivery, and read events where the
      provider supplies them.

### Phase 6 — webhook subscriptions and recovery

- [ ] Make Page webhook subscription idempotent and record the subscription revision/state per
      Page connection.
- [ ] Make Instagram webhook subscription idempotent for each supported authentication path.
- [x] Add a targeted `Repair connection`/`Reconnect Meta` path from the modal.
- [ ] Show last successful inbound event, last successful outbound send, last webhook check, and
      provider request ID where safe for authorized support users.
- [ ] Add retry/backoff and dead-letter inspection for Core-to-Agent forwarding and provider sends.
- [ ] Ensure webhook verification and signature failures remain safe, bounded, and auditable.
- [ ] Add alerts for sustained webhook failures, agent-ingest failures, provider send failures,
      route conflicts, and event-to-agent latency.

## Frontend checklist

### Agent detail implementation

- [x] Replace the Facebook and Instagram `Manage` redirects in
      `client/apps/client/src/components/dashboard/agents/agent-detail-page-client.tsx` with
      provider-aware route state and actions.
- [ ] Extend the client types to include route status, readiness reason, assignment metadata,
      capabilities, and last activity timestamps.
- [x] Add `Use` for an available account.
- [x] Add `Assigned` plus `Manage` and `Remove` for the current agent.
- [x] Add conflict handling with the server's atomic route-ownership response.
- [x] Add `Needs attention` and an `Open connections` recovery action.
- [ ] Keep WhatsApp behavior intact while extracting shared agent-channel row primitives where
      that reduces duplication.
- [x] Use the existing application Dialog/Sheet and confirmation primitives. Do not use native
      `alert`, `confirm`, or `prompt`.
- [x] Show loading skeletons and disabled action states during list and mutation requests.
- [x] Preserve the agent detail page at desktop, tablet, and mobile widths. The modal must scroll
      correctly on small screens and retain accessible focus/escape behavior.
- [x] Add keyboard and screen-reader labels for account state, provider, and assignment actions.
- [ ] Keep copy concise: `Use`, `Assigned`, `Remove`, `Reconnect Meta`, `Retry check`, and short
      reason messages.

### Connections page alignment

- [ ] Keep workspace Connections responsible for connecting/reconnecting Meta assets.
- [ ] Show whether each Facebook Page or Instagram account is assigned to an agent without
      confusing workspace connection status with agent route status.
- [ ] Link from the agent modal to Connections only when the missing action genuinely requires
      workspace-level Meta authorization.
- [ ] After returning from Meta authorization, restore the originating agent context when safe or
      give a clear return path to the agent detail screen.

## Analytics, audit, and observability

### Analytics events

Use the existing versioned Analytics contract and registry. Do not invent undocumented event names.
Add or extend a contract for:

- `agent.channel.assignment` — assigned, removed, reassigned, blocked;
- `agent.channel.readiness` — checked, ready, degraded, needs reauth;
- `agent.channel.ingress` — received, accepted, deduplicated, ignored, failed;
- `agent.channel.delivery` — queued, sent, delivered, read, failed;
- `agent.channel.routing` — routed, no route, conflict, inactive agent, provider unavailable.

Each event must include organization, installation, agent, provider, Core connection ID, provider
asset type, bounded reason code, correlation ID, release ID, and event time. Do not include tokens,
raw payloads, customer message text, or unnecessary customer identifiers.

### Structured logs and metrics

- [ ] Log assignment lifecycle, readiness checks, Meta calls, webhook processing, Agent ingress,
      routing decisions, and delivery outcomes.
- [ ] Include service, environment, release, organization, installation, connection, provider,
      operation, outcome, bounded error code, and correlation/request ID.
- [ ] Redact tokens, authorization headers, raw message bodies, customer profile data, and full
      provider payloads.
- [ ] Measure connection readiness success, route assignment success, inbound-to-agent latency,
      agent response delivery latency, provider rejection rate, duplicate rate, and webhook lag.
- [ ] Add or update the Inbox/Agent operational dashboards and runbook for provider and routing
      failures.

## Security and privacy checklist

- [ ] Enforce organization scoping on every workspace connection, route, conversation, delivery,
      status, audit, and diagnostic query.
- [ ] Validate that the caller can administer the active organization and customer-service agent.
- [ ] Keep Meta credentials encrypted and Core-owned.
- [ ] Never accept a provider access token or arbitrary provider URL from Agent Platform or the
      browser.
- [ ] Prevent one organization's Page/Instagram account from being routed to another organization
      or installation.
- [ ] Ensure provider-scoped customer IDs are only visible to authorized workspace users and are
      not used as cross-organization global identities.
- [ ] Keep raw signed webhook payload retention and access rules consistent with the existing Inbox
      policy.
- [ ] Add tests for revoked users, inactive agents, removed connections, stale route revisions,
      duplicate requests, and cross-organization identifiers.

## Verification checklist

### Unit and contract tests

- [ ] Test route status derivation for connected, assigned, unavailable, degraded, and conflicting
      states.
- [ ] Test idempotent assignment, removal, and conflict/reassignment behavior.
- [ ] Test Facebook and Instagram provider target resolution for both Meta authentication paths.
- [ ] Test canonical inbound envelope mapping and provider event deduplication.
- [ ] Test echo suppression and outbound message correlation.
- [ ] Test Core delivery dispatch for Facebook, Instagram, WhatsApp, Website, and unsupported
      channels.
- [ ] Test policy-window, token, permission, rate-limit, and provider error classification.
- [ ] Test organization/installation authorization and personal-agent rejection.
- [ ] Test analytics payload redaction and bounded reason codes.

### Core and Agent integration tests

- [ ] Fixture: Facebook customer message → Core Inbox conversation → Agent Platform route → agent
      run → Core Meta send → echo/status reconciliation.
- [ ] Fixture: Instagram customer message through Facebook Login → same lifecycle.
- [ ] Fixture: Instagram customer message through Instagram Login → same lifecycle.
- [ ] Fixture: duplicate webhook delivery does not duplicate the message or agent run.
- [ ] Fixture: unassigned Page/Instagram message remains in Inbox and does not invoke an agent.
- [ ] Fixture: assigned route removed while a message is in flight has deterministic behavior.
- [ ] Fixture: agent paused for human handoff blocks automatic provider delivery.
- [ ] Fixture: provider rejects an outbound reply and the Inbox/Agent transcript shows failure and
      retry state.
- [ ] Fixture: Agent Platform unavailable during webhook processing preserves Inbox durability and
      produces a retryable forwarding record.

### Real Meta test acceptance

Use only a dedicated test Page, Professional Instagram account, test user, and non-customer
conversation.

- [ ] Connect/reconnect the Page and Instagram account through the supported KasiTek flow.
- [ ] Confirm readiness checks show the actual permissions and webhook state.
- [ ] Assign each asset to a customer-service test agent from the `Use` modal.
- [ ] Send a Messenger message and confirm it reaches the correct agent once.
- [ ] Send an Instagram Direct message and confirm it reaches the correct agent once.
- [ ] Confirm agent text replies arrive in the correct Meta conversation.
- [ ] Confirm Core Inbox and Agent transcript show the same provider message correlation.
- [ ] Confirm delivery/read updates do not create duplicate messages.
- [ ] Remove the assignment and confirm new messages remain in Inbox without invoking the agent.
- [ ] Reassign the asset according to the approved conflict policy.
- [ ] Revoke/expire a token or webhook subscription in the test setup and confirm the modal gives a
      useful recovery action.
- [ ] Test a customer outside app roles after the required advanced access is approved, if this is
      part of the production launch scope.

### Frontend verification

- [ ] Run client lint and typecheck.
- [ ] Build the client application.
- [ ] Verify agent detail behavior at desktop, tablet, and mobile widths.
- [ ] Verify modal focus, Escape close, keyboard activation, loading, error, success, and stale
      state behavior.
- [ ] Verify no `Manage` action for Facebook/Instagram silently redirects when a route action is
      expected.
- [ ] Verify no unsupported media or interaction controls are shown for the first release.

## Migration and rollout

- [ ] Treat existing Facebook/Instagram workspace connections as unassigned until an explicit
      agent route is created.
- [ ] Do not auto-assign current social accounts based on the existing `agents` consumer metadata.
- [ ] Add a feature flag for Meta agent routing, separately controllable for Facebook and
      Instagram if operationally useful.
- [ ] Keep the existing Inbox path active while Agent routing is enabled; an Agent failure must not
      drop the Inbox event.
- [ ] Roll out first to the dedicated internal/test organization and test assets.
- [ ] Promote the exact tested Core and Agent artifacts together; the client must not enable the
      controls before the backend route and delivery contract are live.
- [ ] Monitor ingress acceptance, model invocation, provider delivery, webhook lag, duplicate rate,
      and support errors before expanding access.
- [ ] Define rollback as disabling Meta agent routing and reverting the UI assignment actions while
      preserving workspace connections, Inbox history, and route records for audit.
- [ ] Remove temporary compatibility code and flags only after the post-release review confirms
      stable routing and delivery.

## Release record

Change: Facebook Page and Instagram Professional account assignment and AI-agent messaging
transport.

Owner: Product and Engineering.

Risk: high — external provider permissions, customer messages, routing, and outbound delivery.

Affected services and user surfaces: `kasitek-core`, Agent Platform, Meta webhook endpoints,
`client/apps/client` agent details and Connections, Inbox, Agent Conversations, Analytics, and
operations/runbooks.

Platform release version or release ID: source commit to be recorded at release time; local
implementation commit is recorded in the handoff.

API/schema/migration changes: Core internal agent delivery and webhook-forwarding contracts, plus
the Agent Platform channel enum/catalog. No database migration was required; existing unique route
constraints and connection status fields are used.

Feature flag or rollout method: explicit agent-detail assignment and existing hosted
customer-service/connected-connection guards; controlled production enablement is still required
after Meta acceptance.

Analytics events and success metrics: existing Inbox/Agent lifecycle events and delivery records
cover assignment-adjacent routing, inbound acceptance, response delivery, duplicate prevention,
provider rejection, and route removal. A dedicated readiness event/metric remains follow-up work.

Logs, metrics, dashboards, and alerts: Core logs Meta-to-Agent forwarding failures and Agent
delivery outcomes; the connection-failure runbook was updated. Durable forwarding retry/dead-letter
inspection and dedicated dashboards remain follow-up work.

User, API, internal, and operational documentation: update the supported Connections/Agents and
Meta setup documentation, the internal integration runbook, and the Agent Platform channel
contract.

Validation evidence: Core and Agent Platform builds/tests, client lint/typecheck/webpack build, and
the contract checks below are complete. Real dedicated Meta test-account acceptance remains a
release gate.

Rollback or disable plan: disable the feature flag and route assignment UI, leave existing
workspace connections and Inbox history intact, and preserve route/audit records; do not delete
provider data or destructive migrations during rollback.

Post-release review date: schedule seven days after the first controlled production enablement.

## Open decisions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Agent audience | Only customer-service agents may receive Facebook/Instagram customer traffic. | Product/Engineering | Decided |
| First message scope | Text receive/send first; richer capabilities follow the capability matrix. | Product/Engineering | Decided |
| Instagram auth paths | Support Facebook Login, Instagram Login, or both in the first release? | Product/Engineering | Open |
| Route ownership | One active customer-service agent per Page/Instagram asset, or intentional fan-out? | Product/Engineering | Open; default one |
| Meta app access | Which permissions are approved in production, and which remain test-only? | Meta/App owner | Open |
| Reassignment | Can an authorized user move an asset from another agent, or must it be removed first? | Product/Engineering | Open |
| Delivery policy | How should messages outside Meta's response window be surfaced and recovered? | Product/Engineering | Open |
| Rich messages | Which media/reaction/button capabilities are approved after text transport? | Product/Engineering | Deferred |

## Definition of done

- [ ] Facebook and Instagram rows show truthful connection and agent-route states.
- [ ] `Use` opens a real status-aware modal and can create an authorized idempotent route.
- [ ] `Manage` shows route health and actions instead of redirecting by default.
- [ ] `Remove` stops agent routing without deleting the workspace Meta connection.
- [ ] Facebook Messenger and Instagram customer messages reach the assigned customer-service
      agent exactly once.
- [ ] Agent text replies reach the correct Page or Instagram account and appear in Core Inbox and
      Agent Platform history with delivery state.
- [ ] Unassigned messages remain available in Inbox without invoking an agent.
- [ ] Provider permissions, webhooks, tokens, policy windows, retries, and failures are visible and
      recoverable.
- [ ] Personal agents and unauthorized users cannot receive or configure these routes.
- [ ] Analytics, audit, logs, metrics, documentation, release identity, rollout, and rollback
      evidence are complete.
- [ ] All required verification and real test-account acceptance checks pass.
