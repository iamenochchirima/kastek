# KasiAi Unified Conversations Implementation Checklist

**Status:** Unified platform and WhatsApp path implemented; Telegram/Discord and production operations remain
**Scope:** Direct KasiTek product (`agents`, `server/kasitek-core`, `client/apps/client`)  
**Last updated:** 2026-08-12

## 1. Outcome

KasiAi has one current, durable conversation for each authenticated KasiTek user. The dashboard
sidebar, WhatsApp, Telegram, Discord, and future verified personal channels append to that same
conversation. The sidebar is the canonical place where the user can observe the combined history.
Each message retains its origin, external identity, provider identifiers, delivery state, and reply
route.

The Agent Platform database remains the source of truth. Temporal owns individual durable runs; it
does not own the lifetime of a conversation. Channel providers remain transport adapters and do not
become separate KasiAi implementations.

## 2. Fixed product and architecture decisions

- [x] Use the shared Agent Platform for KasiAi conversations, memory, runs, and delivery.
- [x] Maintain one organization-scoped KasiAi installation and one current primary conversation
  per authenticated user inside it.
- [x] Resolve platform, WhatsApp, Telegram, Discord, and future verified personal channels into the
  current primary conversation.
- [x] Preserve `source_channel` and source-provider metadata on every message.
- [x] Send an automatic reply back through the channel that triggered the run.
- [x] Show the unified history in the sidebar with source-channel badges and filters.
- [x] Keep short-term conversation context separate from cross-conversation user memory.
- [x] Build model context from a bounded recent-message window plus a rolling summary.
- [x] Queue or reject overlapping runs for the same conversation so responses cannot cross.
- [x] Require verified channel bindings before an external identity can join a user's KasiAi
  conversation.
- [x] Treat reset as an explicit rotation: archive the current thread and create a new current
  thread; do not silently erase long-term memory.
- [x] Keep archived conversation records available for audit and retention until explicitly
  deleted under policy.
- [x] Do not merge the Agent Platform database with the direct product or white-label databases.

## 3. Canonical ownership and routing model

```text
organization-scoped KasiAi installation
        |
        v
authenticated KasiTek user (conversation owner)
        |
        v
current primary conversation
  |          |          |          |
sidebar   WhatsApp   Telegram    Discord
  |          |          |          |
  +----------+----------+----------+
             |
       ordered messages
             |
       one durable run queue
```

- The authenticated platform actor owns the primary conversation.
- A channel binding links a verified external identity to that actor and installation.
- A message's source does not determine its conversation.
- The triggering message determines the default outbound delivery route.
- Browser requests never provide organization or actor identity as authority.

## 4. Phase A — Data model and migrations

- [x] Add a stable conversation owner identifier and primary/current marker.
- [x] Add message transport fields for source channel, source connection/binding, external
  conversation identity, reply channel, and provider occurrence time.
- [x] Add a channel binding owner identifier so a verified external identity resolves to one user.
- [x] Add database constraints preventing two current primary conversations for the same
  installation and owner.
- [x] Add indexes for owner resolution, unified chronological history, provider deduplication, and
  active-run lookup.
- [x] Preserve all existing platform conversations through an additive migration and backfill the
  owner/source fields deterministically.
- [x] Add migration assertions and repository integration coverage.

## 5. Phase B — Unified conversation service

- [x] Replace channel-specific KasiAi conversation resolution with an owner-scoped primary
  conversation resolver.
- [x] Resolve both browser and bound external-channel messages to the same primary conversation.
- [x] Create user, agent, and external-channel participants idempotently.
- [x] Persist source metadata in typed columns while retaining sanitized provider metadata in
  canonical message content where needed.
- [x] Add current-conversation rotation that archives the previous thread atomically.
- [x] Add owner-scoped conversation listing and archived-history retrieval.
- [x] Add owner-scoped archive and soft-delete lifecycle operations; archived owner threads are
  intentionally not restorable as primary threads.
- [x] Ensure a disconnected channel cannot ingest new messages while its historical
  messages remain visible.
- [x] Add strict organization, installation, actor, and owner isolation tests.

## 6. Phase C — External channel ingestion and identity verification

- [x] Extend pairing so a channel binding records the authenticated KasiTek actor that owns it.
- [x] Add an internal canonical inbound-ingestion operation that accepts only events produced by a
  verified provider adapter.
- [x] Resolve active connection and binding before storing any external message.
- [x] Deduplicate webhook retries using provider event/message identities.
- [x] Reject duplicate/replayed, unsigned WhatsApp, unbound, inactive-connection, and revoked
  channel events. Provider-specific stale-event rules remain part of each additional adapter.
- [x] Persist the inbound message and run atomically before acknowledging the provider.
- [x] Record channel/provider source information without storing unnecessary raw webhook payloads.
- [ ] Keep provider signature verification in each provider-facing adapter.
- [x] Document the adapter contract for WhatsApp, Telegram, Discord, and future media.

## 7. Phase D — Concurrency, context, summary, and memory

- [x] Enforce at most one non-terminal message run per conversation by returning a typed busy
  response. Durable queued follow-up messages remain a later enhancement.
- [x] Preserve idempotency across client retries, webhook retries, Temporal activity retries, and
  provider delivery retries.
- [x] Include messages from every source channel in chronological context.
- [x] Keep context bounded by both message count and token budget.
- [x] Include the rolling conversation summary before the recent-message window.
- [x] Rebuild summaries only after a durable assistant reply and track the summarized sequence.
- [x] Keep conversation memory scoped to the conversation; keep durable preferences scoped to the
  owning user/installation.
- [x] Ensure reset rotates short-term context without silently deleting durable preferences.
- [x] Add tests for simultaneous browser/external messages and ordering across channels.

## 8. Phase E — Reply routing and delivery state

- [x] Record the triggering message's reply route on the run.
- [x] Persist the assistant response once in the canonical conversation before delivery begins.
- [x] Deliver external-triggered replies through the same active channel binding by default.
- [x] Keep sidebar-triggered replies in the sidebar unless the user explicitly chooses another
  connected channel.
- [x] Persist queued, sending, sent, delivered, read, failed, and unknown delivery states.
- [x] Apply provider status webhooks idempotently and monotonically to the matching delivery
  attempt/message so out-of-order receipts cannot regress state.
- [ ] Retry only provider-safe failures and surface terminal delivery failures in the sidebar.
- [x] Never regenerate an assistant response merely because channel delivery failed.

## 9. Phase F — Authenticated core bridge and realtime

- [x] Add typed `kasitek-core` bridge methods for current unified conversation, paginated history,
  rotation, lifecycle changes, channel filters, and connected-channel state.
- [ ] Extend internal signed claims only where an installation/conversation audience is required.
- [x] Add user-scoped polling of durable unified conversation history while the sidebar is open.
- [ ] Emit durable message-created, run-status, and delivery-status events.
- [ ] Sanitize all browser-facing event payloads and exclude prompts, secrets, and raw provider data.
- [x] Re-authorize every browser conversation operation from the authenticated core session and
  enforce conversation ownership inside the Agent Platform.
- [ ] Add bridge contract and authorization tests.

## 10. Phase G — KasiAi sidebar experience

- [x] Load the user's current primary conversation rather than a platform-only conversation.
- [x] Render all channel messages in one ordered timeline.
- [x] Show compact source badges for Sidebar, WhatsApp, Telegram, Discord, and unknown adapters.
- [x] Add All/Sidebar/WhatsApp/Telegram/Discord filtering without changing model context.
- [x] Show delivery state on outbound external-channel replies.
- [x] Update the open sidebar when another verified channel receives or sends a durable message.
- [x] Preserve pagination and scroll position while polled durable messages arrive.
- [x] Replace ambiguous “new conversation” behaviour with an explicit reset confirmation explaining
  the effect on thread history and long-term memory.
- [x] Add an archived-conversation/history selector appropriate for the narrow sidebar layout.
- [ ] Add empty, disconnected-channel, reconnecting, queued, running, failed, and disabled states.
- [ ] Complete keyboard navigation, focus management, screen-reader announcements, responsive
  layout, and reduced-motion handling.
- [ ] Add component and interaction tests for filtering, reset, realtime updates, pagination, and
  mixed-channel rendering.

## 11. Phase H — Provider adapters

- [x] Integrate verified KasiAi pairing, ingestion, receipts, and same-channel reply delivery with
  the existing signed WhatsApp webhook and send pipeline.
- [ ] Implement Telegram webhook verification/normalization/delivery and secure account pairing.
- [ ] Implement Discord interaction/event verification/normalization/delivery and secure account
  pairing.
- [ ] Ensure every adapter returns the provider response quickly and dispatches durable work
  asynchronously.
- [ ] Add adapter contract tests and recorded sanitized webhook fixtures.
- [ ] Run provider sandbox smoke tests once credentials and public callback URLs are configured.

## 12. Phase I — Retention, observability, and operations

- [ ] Define configurable retention for raw messages, archived conversations, summaries, run
  events, and delivery attempts.
- [x] Implement owner-authorized conversation soft deletion and derived-summary/conversation-memory
  cleanup while retaining separately scoped user preferences.
- [ ] Keep security/audit records according to the separate compliance retention policy.
- [ ] Add metrics for ingest latency, queue time, run duration, context size, duplicate events,
  delivery latency/failure, and active conversation backlog.
- [ ] Add structured correlation across provider event, message, conversation, run, and delivery.
- [ ] Add admin diagnostics without exposing message contents or credentials by default.
- [ ] Add alerts for webhook rejection spikes, stuck conversation queues, summary failures, and
  provider delivery failures.

## 13. Verification gates

- [x] Database migrations apply cleanly to an existing local Agent Platform database.
- [x] Existing conversations remain readable after migration.
- [x] Sidebar and a simulated verified external channel append to the same conversation.
- [ ] Mixed-channel history survives API, worker, browser, and database restarts.
- [x] Two users in one organization cannot read or route into each other's
  KasiAi conversations.
- [x] Concurrent browser/external inbound events are serialized and cannot produce crossed replies.
- [x] Duplicate inbound/provider events create no duplicate message, run, or reply.
- [x] Long histories remain within configured context limits and use the rolling summary.
- [x] Reset archives the old thread, creates exactly one new current thread, and retains explicitly
  permitted user memory.
- [x] Channel disconnect blocks new traffic while preserving historical observability.
- [x] Agent Platform typecheck/build and database-backed tests pass (85 tests).
- [x] `kasitek-core` formatting, `cargo check`, and package tests pass (58 passed; 2 database-only
  tests intentionally ignored).
- [x] Client production build passes; focused interaction tests are still pending.
- [ ] Credential-dependent WhatsApp/Telegram/Discord sandbox checks are recorded separately.

## 14. Completion rule

The implementation is complete when the sidebar is a durable unified view of the authenticated
user's KasiAi conversation, verified external channels route into it safely, replies return through
the triggering channel, context remains bounded, concurrency cannot cross responses, and the
verification gates pass. Provider sandbox checks may remain credential-dependent, but no provider-
independent storage, routing, security, API, UI, or test work may remain unfinished.
