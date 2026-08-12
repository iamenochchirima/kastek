# KasiAi Workspace Implementation Checklist

**Status:** Complete  
**Scope:** Direct KasiTek KasiAi workspace (`agents`, `server/kasitek-core`, `client/apps/client`)  
**Last updated:** 2026-08-12

## Product outcome

KasiAi opens as a complete assistant workspace rather than an automatically-created single chat.
Users can start and manage named conversations, reopen prior chats, set safe preferences and models,
manage channel connections, and see external-channel activity in the same durable history.

## Fixed implementation decisions

- [x] Keep one protected KasiAi installation per organization; do not create an agent per chat.
- [x] Allow multiple active conversations per authenticated user.
- [x] Treat the currently viewed chat, a draft new chat, and the external-channel default chat as
  separate concepts.
- [x] Create a database conversation only when the user sends the first message from a draft chat.
- [x] Keep WhatsApp and future external messages routed to an explicit channel-default conversation.
- [x] Generate a concise AI title after the first completed assistant response; manual titles win.
- [x] Keep model/provider choices server-controlled and entitlement-checked.
- [x] Store user preferences separately from organization-wide protected agent configuration.

## Phase A — Data and migration

- [x] Add conversation metadata: title source, title generation state, pinned, last opened/read, and
  channel-default marker.
- [x] Replace the single-current-conversation constraint with a single active channel-default
  conversation per installation and user.
- [x] Add a user-scoped KasiAi preference record.
- [x] Backfill legacy primary conversations into active channel-default conversations.
- [x] Add indexes and migration assertions.

## Phase B — Conversation and preference APIs

- [x] Resolve a home payload without creating a conversation.
- [x] Create a conversation only on first message submission.
- [x] Add owner-scoped list, search, rename, pin, archive, unarchive, delete, and channel-default APIs.
- [x] Add user-scoped settings and a server-managed model catalog API.
- [x] Enforce model entitlement, provider credentials, and safe defaults at the API boundary.
- [x] Preserve idempotency, channel routing, ownership, and memory lifecycle behavior.

## Phase C — Runs, titles, and model policy

- [x] Persist the selected model target on each conversation and exact resolved model on each run.
- [x] Resolve model precedence: platform policy → allowed catalog → user default → conversation override.
- [x] Generate fallback titles immediately and durable AI titles after the first completed reply.
- [x] Prevent a title activity retry from replacing a manual title.
- [x] Keep title failure independent from answer completion.

## Phase D — Core bridge

- [x] Bridge the new home, conversation, preference, model-catalog, and channel-default contracts.
- [x] Re-authorize every operation through the authenticated KasiTek session.
- [x] Retain the existing WhatsApp pairing, inbound routing, delivery, and disconnect contracts.

## Phase E — KasiAi workspace UI

- [x] Replace the conversation dropdown with a ChatGPT-style conversation library.
- [x] Add new-chat home with route/tool-aware suggestions and no persisted conversation until send.
- [x] Add title, rename, pin, archive, delete, search, date groups, and channel/unread indicators.
- [x] Add dedicated General, Model, Connections, and Memory & privacy settings views.
- [x] Move WhatsApp pairing/disconnect management out of the message timeline.
- [x] Add current-conversation model selection and clear scope labels for defaults vs per-chat overrides.
- [x] Preserve drafts, scroll position, keyboard navigation, focus, and responsive narrow-panel behavior.

## Phase F — Verification and release readiness

- [x] Add database-backed tests for multiple conversations, title lifecycle, channel-default routing,
  preferences, model authorization, and user isolation.
- [x] Add HTTP and core bridge authorization tests.
- [x] Add focused client interaction tests where the existing test setup supports them.
- [x] Apply migrations locally and verify Agent Platform build/tests, core checks/tests, and client build.
- [x] Commit coherent implementation sections without including unrelated worktree changes.

## Completion rule

The feature is complete when opening KasiAi is non-mutating, users can manage multiple named chats
like a modern assistant product, external messages route predictably, settings do not affect another
user unintentionally, and every model/title/conversation action is durable and tested.
