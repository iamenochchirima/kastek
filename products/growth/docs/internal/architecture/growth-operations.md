---
title: Growth operation coverage
owner: engineering
last_reviewed: 2026-11-01
---

# Growth operation coverage

The executable source of truth is `packages/contracts/src/growth-operations.ts`. It currently
defines 45 version-1 operations. MCP tools and signed internal descriptors use those exact
identities and schemas; REST exposes `POST /v1/operations/{operation}`. `GET /v1/operations`
filters discovery by the current credential, workspace membership and entitlements. Typed REST
aliases delegate to the same handlers. There are no additional internal business operations in
the current publication (manifest/policy revision 8, adapter release 5).

This table accounts for the historical tool families without reinstating their removed gateway,
installation credentials or executor. Historical names are not compatibility aliases.

| UI or historical family | Current canonical operations | Owning services | Engineering evidence |
| --- | --- | --- | --- |
| Workspace business context | `workspace.read` | `services/orgs`, onboarding profile | SDK/REST/signed internal result parity and full shared-worker fixtures |
| Connected account inventory and local status | `connections.list`, `connections.status.update`, `content.accounts.list` | `services/connections`, `services/social/channels` | Canonical authority/schema checks; account revision and reconnect fences |
| Content inventory, activity and reuse | `content.posts.list/get/activity/duplicate` | `services/social/posts`, content adapter | Real scoped reads; retained delivery history and idempotent new-draft tests |
| Draft create/edit | `content.posts.draft.create/update` | Content adapter, social post transactions | Real OAuth SDK and typed REST exact approval/replay; actual shared worker and lost acknowledgement recovery |
| Media metadata/preview and ingestion | `content.media.get/preview/upload/transfer.prepare` | Social media service, owned media transfers | Real authenticated binary upload, checksum/finalization/replay, workspace/principal isolation |
| Preflight and publication | `content.posts.publish`, `content.posts.publish_batch`, `content.posts.publish_batch.preflight/status/retry` | Content batch service and Growth social worker | Database/provider fixtures, common admission locks, immutable account identity, delegated authority and unknown-outcome fences |
| Published Facebook text edits | `content.posts.update_published` | Shared published-edit capability and Facebook provider adapter | Exact content/account review, revision checks, durable intent and provider readback; media and destination remain unchanged |
| Schedule and cancellation | `content.posts.schedule/reschedule/unschedule`, `content.jobs.cancel/retry` | Content adapter, social jobs | Timezone/future-time and browser fixtures; claim/edit/retry/cancel races; queued grant revocation |
| Deletion | `content.posts.delete/delete_published` | Content adapter, provider deletion ports | Durable target/receipt fixtures and no blind repeat of ambiguous provider effects |
| Contact/customer records | `contacts.list/update`, `customers.get` | WhatsApp contacts and customers | Scoped typed read fixtures; atomic membership/contact review revisions and replay |
| Human Inbox | `inbox.conversations.list/update/mark_read`, `inbox.messages.list/send` | Existing provider-neutral and WhatsApp Inbox services | Scoped message read fixtures, denied stale-revision effects and shared review admission; provider-specific live delivery remains unverified |
| Booking reads | `bookings.services.list`, `bookings.list/get` | Existing booking service | Catalogue/schema/authority binding; existing booking service verification; no booking mutation tool |
| Campaign and template reads | `campaigns.list/get`, `templates.list` | Existing WhatsApp campaign/template services | Real typed read fixtures use canonical handlers and preserve authorized content/filtering |
| Reporting and post insights | `analytics.read`, `content.posts.insights`, `content.insights.report` | Scoped reporting gateway and content insights | Explicit range/timezone validation, reporting gateway fixtures, existing insight service checks |
| Review status | `operations.reviews.get` | Growth operation review store | Credential/user/workspace-bound status; exact digest, expiry, continuation and recovery fixtures |

## Authority and effect boundary

`growth:read` permits reads. `growth:draft` permits reviewed record/draft edits.
`growth:publish` permits reviewed publication, scheduling and message delivery.
`growth:manage` permits reviewed destructive/management operations, with current workspace
administrator checks for destructive actions. Legacy `api:read` and `api:write` remain read and
draft equivalents. Developer key creation selects explicit scopes, and rotation preserves them.
Each descriptor also declares its actual entitlement and resource requirements.

All non-read business changes require an exact persisted review. The sole staging exception is
`content.media.transfer.prepare`: it creates private temporary storage and cannot create a
content asset or publish. Finalization requires its own review. Continuations only retrieve an
unchanged observation; they never approve or commit a change. A succeeded scheduling or batch
admission receipt is not a confirmed provider publication.

Human UI commands retain their existing explicit-action flow and use the same domain guards.
Presentation controls, navigation, draft editor state and OAuth browser consent are not model
business tools. Provider credential setup/reconnection remains an authenticated human flow.

## Draft destinations

A draft requires at least one platform, but it can be created and edited before connecting an
account. The manual composer offers **Draft for Facebook** (and the equivalent platform action)
when no account is selected. Its platform copy survives saving, reopening and editing the same
record. An unassigned draft has a pending delivery record with no account connection; it is not
queued for publication. Draft saves, including reviewed agent saves, use the shared social post
transactions.

The human `/api/social/posts` responses map database row names to the Content UI's camelCase
fields, including `createdAt`, `updatedAt`, `scheduledFor`, media identifiers and delivery account
identifiers. The manual channel list and identity-refresh routes use the same camelCase
account fields, including `displayName` and `externalAccountId`. Metadata keys remain unchanged. Domain rows and canonical agent operation contracts
retain their own field names; this response mapping does not add a separate business handler.

The human composer submits an empty JSON object with its idempotent publish-batch request.
An empty body with a JSON content type fails request parsing before batch admission. A
non-JSON publish response shows a readable error and retains the saved draft and publish
idempotency key; it does not establish a provider delivery result.

The Posts library refreshes post status every three seconds while work is queued or
processing and every thirty seconds for scheduled posts. It pauses in hidden tabs and
refreshes on return. Terminal results stop periodic reads; unknown outcomes remain subject
to reconciliation. Status refreshes update the library and selected post without replacing
composer input. Post details refresh the post, batch and activity together while processing.
Failed reads preserve the last result and retry on the next active poll.

Any account supplied with a draft must still belong to the workspace, match the platform and
be connected. A partial social-post update that omits `channelSelections` retains saved
selections; an explicit empty map removes them from a draft. Scheduling requires an account for
every selected platform. The manual composer disables scheduling and immediate publication
until accounts are selected; server scheduling and publication guards remain authoritative.

The `social-posts.test.ts` database regression covers unassigned Facebook draft creation,
readback, editing, account retention, scheduling rejection and invalid account isolation.
The `growth-migration.spec.ts` unconnected Facebook journeys exercise the production UI bundle
against a controlled API at 390, 768 and 1440 pixels in both themes. These browser fixtures do
not prove live Facebook delivery or provider authorization.

## Direct editing

The Content library opens a focused editor for saved drafts and scheduled posts. Saving edits
uses the existing draft mutation guards and preserves their destinations and schedule. Creating
new posts retains the four-step composer.

Published Facebook-only posts with a confirmed external ID use a separate text/caption editor.
`POST /api/social/posts/:id/update-published` accepts `content` and `expectedUpdatedAt` and
returns the updated manual post representation. Account selection is read-only. A single published image can be detached with `removePhoto: true`; replacement and additional media are not supported.
The canonical `content.posts.update_published` operation uses the same shared capability with
`postId`, `content`, `expectedUpdatedAt` and optional `removePhoto`, a stable request identity, `growth:publish`, content
management/publication entitlements and exact review. Internal agents call the same handler.

The update retains the original external receipt and checks the current account, grant and
post revision. For image posts, the provider adapter resolves the stored photo to its Page
story before updating its message. Local copy changes only after confirmed provider readback.
An uncertain update requires reconciliation and cannot be treated as permission to publish a
replacement post. Photo removal is persisted only after provider readback confirms no attachments. Growth removes post/variant media associations while retaining the media asset and original delivery snapshot. A durable Page-story identity directs subsequent edits, deletion and insight reads to the remaining post instead of the detached photo. This path does not enable other platforms, replacement media or destination changes.

## Explicit exclusions and verification limits

Campaign launch, booking creation, call controls, new social formats, media-library organization,
reusable template editing and automatic customer-service deployment are not restored operations.
Human Inbox access does not create a second automatic responder. Customer-service execution stays
in standalone Agents.

The local tests establish controlled engineering behavior. Hosted OAuth clients and live social
platform formats, comments, messaging and analytics require their own provider acceptance. The
per-platform checklist remains separate from connection success. Some list services load the
workspace collection before taking a bounded page; pagination bounds the returned observation,
not the database work. Use [agent access operations](../operations/growth-agent-access.md) for
rollout flags, migrations, status-only recovery, evidence and rollback.
