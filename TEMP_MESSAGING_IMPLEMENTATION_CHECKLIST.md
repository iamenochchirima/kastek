# Messaging completeness implementation checklist

Status: temporary implementation plan  
Scope: direct KasiTek Inbox in `kasitek-core` and `client/apps/client`  
Channels in scope: WhatsApp Cloud API, Facebook Messenger, Instagram Messaging

## Outcome

The Inbox must preserve and show a conversation as the customer sees it on the
source channel: text, replies, reactions, stickers, media, delivery and read
state, and provider errors. A user must never see a successful-looking message
when the provider rejected it, or a generic attachment placeholder when the
message can be retrieved and displayed safely.

This is a shared Inbox contract with channel adapters. It is not three copies of
the same implementation: capability and policy differences must be explicit.

## Refactor policy

This project is not in production. Implement the new message model as a clean
cutover, not a compatibility layer:

- [x] Replace the current text-envelope approach with one canonical structured
      message model; do not add new envelope variants or dual-write paths.
- [x] Remove superseded parsers, temporary fields, and UI branches in the same
      change once the replacement is wired and tested.
- [ ] Use a development database migration/reset and fresh provider test data
      where that is clearer than a historic-data backfill.
- [x] Keep only the migration code needed to reach the new schema. Do not retain
      runtime backward-compatibility code for obsolete local data.
- [x] Use Git commits as the rollback mechanism while the work is under active
      development.

## Current baseline and gaps

- [x] Text conversations, connection filters, realtime events, and basic
      delivery/read updates are present.
- [x] WhatsApp has initial support for media, stickers, reactions, and reply
      context.
- [x] Messenger and Instagram messages can be received and sent as text.
- [x] Messenger and Instagram reply context is now persisted when a provider
      message ID is available.
- [x] Meta inbound attachments are normalized into durable attachment records
      and served through an org-scoped media proxy.
- [ ] Meta reactions are modeled as first-class Inbox events. Edits, deletes,
      and unsend events still need provider fixtures before being enabled.
- [ ] Meta reply support must be exercised against real Messenger and Instagram
      accounts, including a provider rejection path. The Inbox must retain the
      local reply relationship even where the provider does not render a native
      thread.
- [ ] Media sending is WhatsApp-only. Messenger and Instagram must not expose an
      enabled attachment control until their adapter supports the selected media
      type.
- [x] Magic `content` envelopes are removed; rich message state has one durable
      contract.

## Non-negotiable design rules

- [ ] Keep tenant/org scoping on every message, attachment, reaction, query,
      media download, and realtime event.
- [ ] Treat provider webhook delivery as at-least-once and out of order.
      Deduplicate by a stable provider event/message identifier and make all
      handlers idempotent.
- [ ] Preserve the raw, signed provider payload only in protected metadata with
      access controls and a retention policy; do not render it directly.
- [ ] Persist a normalized Inbox representation before broadcasting a realtime
      event. The UI may be optimistic, but server state remains authoritative.
- [ ] Never use a provider URL as a public permanent media URL. Retrieve media
      server-side, validate it, store/proxy it safely, and authorize every view
      or download request.
- [ ] Surface actual provider failures, policy-window failures, unsupported
      message types, and retry state in the composer and message timeline.
- [ ] Keep external platform capabilities server-owned. The client receives a
      per-conversation capability object; it must not guess based on a channel
      label alone.

## Phase 0 — capability contract and audit

Current server-enforced capability matrix (version 1):

| Channel | Send text/reply | Send media | Send reaction | Receive media | Receive reactions | Provider delete |
| --- | --- | --- | --- | --- | --- | --- |
| WhatsApp Cloud API | yes | image, video, audio, document, sticker | yes | yes | yes | yes |
| Facebook Messenger | yes | not enabled yet | not enabled yet | yes | yes | not enabled yet |
| Instagram Messaging | yes | not enabled yet | not enabled yet | yes | yes | not enabled yet |

The Inbox consumes this server-owned matrix from each timeline response. It does
not infer capability from a channel label. Meta outbound media/reactions remain
disabled until the exact connection mode, permissions, send endpoint, and
provider fixtures are verified.

- [x] Create a versioned `ChannelCapabilities` contract returned with every
      connection/conversation. Include:
      - text send
      - images, video, audio, documents, stickers
      - replies, reactions, edits, deletes/unsend
      - delivery/read receipts, typing indicators
      - supported inbound event types
      - size/MIME limits and policy-window state when known
- [ ] Build a capability matrix for WhatsApp, Facebook Messenger, and both
      Instagram connection paths (Facebook Login and Instagram Login).
- [ ] Verify every matrix entry against the exact currently configured provider
      API/version and app permissions. Record the documentation link, webhook
      field, send endpoint, token type, and app-review requirement.
- [x] Mark unsupported or unapproved features as unavailable in the UI; do not
      use disabled controls with hidden fallback behaviour.
- [ ] Add a small provider test workspace/account matrix so every supported
      event can be generated deliberately without using customer conversations.

## Phase 1 — durable message domain model

- [x] Replace magic text prefixes with structured message records in one schema
      cutover. Remove the corresponding runtime envelope parsing and writes.
- [x] Define a `MessageAttachment` record with message ID, provider attachment
      ID, provider media ID/URL reference, type, MIME type, file name, byte
      size, checksum, dimensions/duration, storage key, scan state, download
      state, and sanitized preview metadata.
- [x] Define a `MessageReference` record for replies/quotes with source message
      ID, source provider message ID, relationship type, and immutable preview
      snapshot. It must remain usable if the source message is removed.
- [x] Define a `MessageReaction` record keyed by message, actor/provider actor
      ID, emoji, action timestamp, provider event ID, and active state. Support
      add, replace, and remove without manufacturing duplicate timeline items.
- [x] Define a `MessageEvent`/audit record for provider events that affect a
      message but are not messages themselves: delivery, read, edit, delete,
      unsend, reaction, referral, and policy failure.
- [ ] Keep `providerMessageId` unique per conversation/provider and add the
      indexes needed for provider event lookup, attachment lookup, and ordered
      conversation rendering.
- [ ] Reset/reseed development message data where needed rather than carrying
      uncertain historic attachment or reaction content into the new model.
- [x] Publish typed realtime payloads for message created/updated, attachment
      ready/failed, reaction changed, receipt changed, and message deleted.
- [x] Delete obsolete schema fields, helper functions, endpoint branches, and
      client types before closing this phase; no dead compatibility code remains.

## Phase 2 — adapter boundary and webhook ingestion

- [ ] Introduce a shared provider adapter interface for:
      - normalize inbound webhook event
      - send text/reply/media/reaction where supported
      - fetch attachment metadata/content
      - translate provider receipts and errors
      - capability discovery/configuration
- [ ] Keep WhatsApp, Messenger, Instagram-via-Facebook-Login, and
      Instagram-Login implementations separate behind that interface.
- [x] Validate Meta webhook signatures before JSON processing and retain
      signature/processing diagnostics without leaking tokens or content.
- [ ] Parse all relevant webhook variants before creating records:
      - ordinary text and echo/self messages
      - attachments, stickers, shares, and unsupported message notices
      - reply context (`reply_to`) and story context where supplied
      - reactions and removals
      - delivery/read receipts, edits, deletes/unsends, referrals, and postbacks
- [ ] Queue slow media retrieval, metadata fetches, virus scanning, thumbnails,
      and retry work outside the webhook request. Acknowledge valid provider
      webhooks quickly.
- [ ] Add retry with exponential backoff and a dead-letter/inspection path for
      failed background processing. Retries must use idempotency keys.
- [ ] Emit structured logs and metrics for received, ignored, deduplicated,
      failed, and delayed events by platform and event type.

## Phase 3 — attachments, media, and stickers

- [x] Implement inbound attachment normalization for each channel: image,
      video, audio/voice, document, sticker, location/contact/share where the
      provider exposes them.
- [ ] Fetch attachment metadata/content with the connection token on the server.
      Validate allowlisted MIME types, file signature, configured size limits,
      checksum, and decompression/image safety before storage.
- [ ] Store source media in private object storage (or an equivalent protected
      backend), generate thumbnails/previews asynchronously, and serve through
      an org-authorized media endpoint.
- [x] Render states distinctly: ready, unavailable, and download failure; upload,
      processing, scan, and provider-expiry states remain pending.
      expired-at-provider, failed scan, and download failed. Do not render an
      unknown file as `[attachment]` when useful metadata exists.
- [ ] Implement outbound media per capability, beginning with the most common
      safe types: image, document, audio, and video. Add stickers only after
      provider-specific format/size requirements are tested.
- [ ] Preserve caption, original filename, alt text where available, dimensions,
      duration, and reply context for media messages.
- [ ] Add downloadable document UX, accessible media labels, lightbox controls,
      keyboard navigation, and a no-preview fallback.
- [ ] Enforce upload size/type limits client-side for feedback and server-side
      for security. Never trust client MIME metadata.

## Phase 4 — replies, reactions, and message actions

- [ ] Complete reply support with both a stable local reference and the provider
      message ID required by the channel adapter.
- [ ] Test outbound and inbound replies for WhatsApp, Messenger, and Instagram.
      Verify native provider rendering where available; retain KasiTek quote UI
      even if the provider does not offer native threaded rendering.
- [ ] Render reply previews using the source message kind (text, image, sticker,
      document, deleted/unavailable), sender label, and immutable fallback text.
- [ ] Implement inbound and outbound reactions using `MessageReaction` records.
      Group reactions by emoji and count, show the current actor's reaction, and
      support unreact/replace where the provider allows it.
- [ ] Do not represent reactions as normal messages in the conversation list.
- [ ] Add channel-aware message actions: reply, react, copy, retry, delete from
      KasiTek, provider unsend/delete where supported, download media, and open
      source context. Hide unsupported actions.
- [ ] Add edit/delete/unsend handling to preserve the event history while making
      the latest visible message state accurate.
- [ ] Treat provider moderation, policy, and 24-hour conversation-window errors
      as a clear blocked state with an actionable explanation.

## Phase 5 — receipts, sync, and reconciliation

- [ ] Normalize outgoing lifecycle states across channels:
      `queued → processing → sent → delivered → read`, plus `failed`, `blocked`,
      `unknown`, and `expired` where applicable.
- [ ] Store provider receipt timestamps and payload references; do not infer a
      precise receipt from a coarse watermark when a provider ID is available.
- [ ] Reconcile only on targeted triggers (webhook retry, reconnect, user
      refresh, or recovery job), not an aggressive browser polling loop.
- [ ] Add a bounded background reconciliation job for missed/out-of-order
      receipts and outbound echoes, with metrics for eventual consistency lag.
- [ ] Ensure a duplicate echo or delivery event updates the existing message and
      never creates a second bubble.
- [ ] Keep read state separate from conversation assignment/visibility state.

## Phase 6 — Inbox UX and operational controls

- [ ] Give the composer a capability-aware attachment menu, reply strip,
      reaction picker, cancellation, retry, upload progress, and clear error
      messaging.
- [ ] Maintain account/page/account switchers for every multi-account channel
      and scope messages, composer availability, and connection health to the
      selected source account.
- [ ] Make message grouping, timestamps, delivery indicators, quoted previews,
      attachment cards, and reaction chips consistent across channels without
      pretending their semantics are identical.
- [ ] Add an explicit connection-health panel: permissions, webhook
      subscription, token expiry, last received event, last send failure, and
      required recovery action.
- [ ] Add internal support diagnostics that expose provider request IDs and safe
      error detail to staff only, never to normal workspace users.
- [ ] Add keyboard and screen-reader support for all message actions and media.

## Phase 7 — security, compliance, and reliability

- [ ] Define attachment and raw-webhook retention periods, deletion workflows,
      and data-export behaviour.
- [ ] Scan uploaded/downloaded files before making them available. Quarantine
      unsafe files and show a safe explanation to the user.
- [ ] Encrypt provider tokens and private media at rest; restrict decryption and
      signed download generation to server-side code.
- [ ] Add authorization tests proving one org cannot query another org's
      conversations, media, reactions, references, raw payloads, or diagnostics.
- [ ] Rate-limit outbound sends, uploads, retries, and webhook processing per
      connection/account.
- [ ] Add observability dashboards/alerts for webhook signature failures,
      processing latency, deduplication rate, send failure rate, media failures,
      and receipt lag.

## Test and release gates

- [ ] Unit tests for each provider payload normalizer and capability decision.
- [ ] Database tests for idempotency, ordering, org isolation, reply references,
      reactions, attachment lifecycle, and receipt transitions.
- [ ] Contract fixtures captured from real sandbox/test accounts for WhatsApp,
      Messenger, Instagram-via-Page, and Instagram Login.
- [ ] End-to-end tests for text, reply, reaction, attachment, sticker, delivery,
      read, failure, reconnect, and duplicate/out-of-order webhook cases.
- [ ] Manual device/browser matrix for large media, downloads, slow networks,
      reconnects, and multiple simultaneously connected accounts.
- [ ] Feature flags for each newly enabled outbound capability. Enable for the
      internal test workspace first, then selected test organizations.
- [ ] Production readiness review: app permissions/access, webhook field
      subscriptions, storage lifecycle, monitoring, support runbook, and rollback
      plan.

## Suggested delivery order

1. Phase 0 capability matrix and Phase 1 structured data migration.
2. Messenger + Instagram inbound attachment ingestion and safe media delivery.
3. Cross-channel replies and reactions, including provider-specific tests.
4. Outbound media/stickers only for validated capabilities.
5. Receipt reconciliation, diagnostics, and phased rollout.

No channel capability should be marked complete until the real provider webhook,
the persisted Inbox state, realtime update, and rendered UI have all been
verified together.
