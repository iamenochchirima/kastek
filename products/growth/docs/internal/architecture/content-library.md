---
title: Content media and templates
owner: engineering
last_reviewed: 2026-11-03
---

# Content media and templates

Growth retains uploaded content images and videos in `ContentMediaAsset`. `/content/media`
browses those records; uploading, attaching or duplicating content reuses the same asset identity
and bytes. This library does not import provider posts, Inbox attachments, audio or other products.
Provider format support remains defined by publishing adapters.

## Media lifecycle

The additive media migration adds display name, tags, default alt text, archive timestamp and an
integer revision. Original file names, checksums, processing and scan state remain authoritative.
`content.media.list` uses bounded search, tag/kind/archive filters and keyset pagination.
`content.media.get` includes library metadata for images/videos and preserves the existing audio
metadata contract. `content.media.preview` issues an expiring URL after checking availability.
Storage paths and provider credentials are not returned.

Metadata updates require `expectedRevision`. Default alt text becomes a snapshot when an asset
is attached; changing the default does not rewrite existing posts. New draft attachments take a
shared asset lock before insertion and reject archived, foreign or unready assets. Existing
attachments remain usable after archive. Archive/restore require `growth:manage` and current
workspace administration, retain bytes and references, and never delete provider posts.
`content.media.usage` returns scoped post/template references with bounded pagination.

`ContentMediaLibraryMutation` stores immutable per-operation results in the same transaction as
metadata/archive changes. A lost acknowledgement can recover the earlier result even after
another edit. Reusing an operation identity with different input fails.

## Social templates

`ContentTemplate` is workspace-owned and separate from WhatsApp templates at `/templates`.
It stores reusable copy, selected platforms, platform copy versions, declared fields, media
references, creator/updater, archive state and revision. `ContentTemplateMedia` references retained
assets with restrictive deletion. Literal fields use `{{key}}`; expressions are rejected.
Missing required or unknown values fail. Substitution uses literal strings, including dollar signs
and braces, and never evaluates code. Rendered content is bounded again after substitution.
Caption fields cannot alter lettering embedded in an uploaded image.

`content.templates.render` is read-only. Its validation covers template fields, retained file availability and existing static platform text/media limits;
it is not account permission or provider publication preflight. `content.templates.instantiate` holds the selected template
revision and asset admission locks while the existing content draft service creates an independent,
unscheduled draft. The draft records template ID, revision and a values digest, not raw field values
in provenance. Later template edits do not change that draft. Explicit common-media replacement
also clears retained platform media overrides for that materialization.

Save as template copies reusable source content only. Existing platform media associations retain
asset identity, ordering, alt text and crop. Template mutation receipts preserve exact earlier results
through subsequent edits. Templates with archived/missing/unready media must be restored or have
those references explicitly removed/replaced before reuse. Archive does not rewrite older drafts.

## Duplicate and transport parity

`content.posts.duplicate` uses the existing draft service with a fresh draft ID, draft versions and
pending jobs. It reuses media references and copies legacy platform media associations atomically,
while preserving source history. Preflight, exact action previews and the publisher resolve the same
per-platform delivery selection. Explicit empty selections stay empty; malformed or foreign
references fail closed. Unrecognized legacy snapshots fall back to common attachments, and
published historical snapshots do not reinstate removed attachments. It does not copy schedule, provider IDs, delivery attempts,
mutation intents, previous approvals, private idempotency metadata or TikTok consent. Account
choices remain subject to current account validation. Retained unavailable accounts produce an
explicit error rather than inventing permission.

The new tools publish typed result envelopes, domain records, continuation chunks and error codes
through shared JSON schemas; generated OpenAPI uses those same contracts.
All operations are defined in `packages/contracts/src/growth-operations.ts` and invoke the same
handlers through browser session REST, scoped Developer API keys, OAuth MCP and signed internal
agent execution. Reads require `growth:read`; private saves and metadata edits require
`growth:draft`; archive/restore require `growth:manage` and workspace administration. Writes use
stable request identities and durable operation receipts. Current credentials and membership are
rechecked before execution and receipt observation. Large observations use the existing bounded
JSON continuation contract.

New internal agent configurations use publication revision 11 and runtime adapter release 8.
Retained publication 10/runtime 7 keep their original identities and tool sets. Existing pinned
agents receive the new tools through the existing explicit defaults-upgrade action.

## Verification and release

Real PostgreSQL checks live in `content-media-library.test.ts`, `content-templates.test.ts` and
`content-library-operations.test.ts` and `content-library-video.test.ts`. Existing social CRUD/publishing, media transfer, content chat,
MCP transport and internal publication tests remain relevant. UI verification uses an owned fixture
schema and temporary content storage, with no social-provider writes.

Apply `20261103110000_content_media_library` before `20261103111000_content_templates` using the
normal migration ledger. Prisma migrations mirror API SQL; apply one copy only. See the
[release record](../operations/content-library-release.md) for rollout and rollback decisions.
