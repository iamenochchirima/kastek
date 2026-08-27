# Audio Input and Transcription Implementation Checklist

Use this checklist with [the Audio Input and Transcription Implementation Plan](AUDIO_TRANSCRIPTION_IMPLEMENTATION_PLAN.md).
Mark an item complete only when the implementation and its required evidence exist.

Status markers: `[ ]` not started · `[-]` in progress · `[x]` verified complete · `[?]` requires a
product, provider, privacy, or deployment decision.

## 0. Product, privacy, and boundary decisions

- [ ] Confirm the first release is audio input/transcription with text replies only.
- [ ] Confirm supported channels: WhatsApp, Telegram, Discord, KasIAI, and website widget.
- [ ] Confirm maximum audio duration, byte size, attachment count, and accepted MIME formats.
- [ ] Confirm target languages and whether language detection or an explicit language hint is used.
- [ ] Confirm ElevenLabs data-processing, retention, regional, and customer-notice requirements.
- [ ] Confirm audio and transcript retention periods and deletion behavior.
- [ ] Confirm whether users see transcripts on external channels, or only in KasIAI/widget/Inbox.
- [ ] Confirm whether transcription is free during beta or metered/deducted from credits.
- [ ] Assign engineering, product, privacy, analytics, operations, and support owners.
- [ ] Record decisions in the plan, release record, and supported documentation.

## 1. Current-system inventory

- [ ] Trace the canonical Agent Platform message and attachment contracts.
- [ ] Trace Core message, attachment, media storage, download, scan, and deletion helpers.
- [ ] Confirm the authoritative attachment table for each channel and avoid duplicate media records.
- [ ] Trace WhatsApp provider media retrieval and voice-note handling.
- [ ] Trace Telegram update parsing, file retrieval, and outbound message delivery.
- [ ] Trace Discord attachment parsing, download, and outbound response delivery.
- [ ] Trace KasIAI composer, upload, conversation persistence, and agent dispatch.
- [ ] Trace website widget session, origin, upload, message, delivery, and retry flows.
- [ ] Trace queue/worker ownership, leases, retry conventions, dead-letter handling, and metrics.
- [ ] Trace existing organization permissions, attachment access, retention, and audit conventions.
- [ ] Record the boundary map and unresolved dependencies in the implementation plan.

## 2. Data model and migration

- [ ] Choose additive transcription fields or a dedicated `AudioTranscription` table.
- [ ] Make the attachment/transcription relationship unique and organization-scoped.
- [ ] Add status, provider, provider job ID, attempts, timestamps, safe error code, and bounded text.
- [ ] Add language, duration, checksum, and provider-cost/duration metadata where appropriate.
- [ ] Add indexes for queued work, retryable failures, organization/conversation, and retention.
- [ ] Preserve existing text messages, attachments, provider IDs, and old clients.
- [ ] Ensure the migration is additive, repeatable, and safe with partially processed jobs.
- [ ] Add a migration rollback/disable note; do not delete audio data in the first release migration.
- [ ] Run Prisma/schema validation and generation.
- [ ] Run the migration against an isolated database and verify clean-install behavior.
- [ ] Record migration versions in the release record.

## 3. Provider and worker foundation

- [ ] Add a server-side ElevenLabs configuration boundary with secret validation.
- [ ] Add an `AudioTranscriptionProvider` interface independent of ElevenLabs response shapes.
- [ ] Implement Scribe v2 batch submission and polling with request timeouts.
- [ ] Validate provider responses and normalize transcript, language, duration, and error fields.
- [ ] Add redaction so keys, signed URLs, raw transcripts, and provider payloads do not enter logs.
- [ ] Add a durable transcription job with a lease, idempotency key, attempt count, and safe state.
- [ ] Add bounded exponential retry for timeouts, 429s, and retryable 5xx responses.
- [ ] Mark invalid media, unsupported formats, and permanent provider errors terminal.
- [ ] Add a dead-letter/operator-review state and a retry action.
- [ ] Enqueue exactly one agent dispatch after completed transcription.
- [ ] Ensure duplicate worker claims, provider completion events, and retries are safe.
- [ ] Add provider health and configuration diagnostics without exposing secrets.

## 4. Media security and privacy

- [ ] Enforce authenticated organization ownership for workspace media operations.
- [ ] Enforce visitor session and allowed-origin ownership for widget media operations.
- [ ] Stream uploads/downloads and enforce byte limits before storing or sending to the provider.
- [ ] Validate magic bytes, MIME type, extension, duration, and checksum server-side.
- [ ] Scan audio objects and block quarantined or failed scans from transcription.
- [ ] Keep provider keys server-side and store provider media IDs rather than authenticated URLs.
- [ ] Use short-lived signed URLs for playback and never log them.
- [ ] Treat transcripts as personal data and untrusted user input.
- [ ] Define deletion of original audio, transcript, provider job data where supported, and indexes.
- [ ] Add audit evidence for operator retry, quarantine release, playback authorization, and delete.
- [ ] Add abuse limits for anonymous widget uploads and per-organization audio volume.

## 5. Channel ingestion

### WhatsApp

- [ ] Recognize voice notes and audio messages as canonical audio attachments.
- [ ] Resolve and download provider media through the authenticated WhatsApp path.
- [ ] Preserve provider message/media IDs for retries and deduplication.
- [ ] Handle missing media, expired media URLs, unsupported codecs, and provider errors.
- [ ] Verify transcript context reaches the existing agent exactly once.
- [ ] Verify the normal text reply is delivered in the same conversation.

### Telegram

- [ ] Parse `message.voice` and `message.audio` in the channel adapter.
- [ ] Resolve the Telegram file ID and copy the file into controlled storage.
- [ ] Preserve caption text alongside the audio without losing either input.
- [ ] Handle malformed updates, missing files, unsupported formats, and expired retrieval.
- [ ] Verify transcript context and normal text response.

### Discord

- [ ] Detect audio attachments from MIME type and validated file metadata.
- [ ] Copy attachments from Discord into controlled storage before the source URL expires.
- [ ] Preserve caption/content and attachment identity.
- [ ] Enforce server/channel permissions already required by the Discord adapter.
- [ ] Verify transcript context and normal text response.

## 6. KasIAI in-app experience

- [ ] Add microphone recording with permission-denied handling.
- [ ] Add audio-file selection with client-side hints but server-side validation.
- [ ] Show recording timer, cancel, upload progress, and disabled duplicate-submit state.
- [ ] Show `Uploading`, `Transcribing`, `Ready`, and `Failed` states with retry.
- [ ] Render a compact audio player and transcript in the conversation.
- [ ] Preserve text composition and existing send behavior.
- [ ] Keep transcript/audio access scoped to the active organization and conversation.
- [ ] Verify keyboard, focus, screen-reader labels, reduced motion, and mobile layout.

## 7. Website chat-widget experience

- [ ] Add a session-scoped upload/finalize API or secure signed-upload flow.
- [ ] Preserve origin validation, session expiry, anonymous rate limits, and idempotency.
- [ ] Add a microphone button and file upload with concise processing states.
- [ ] Prevent sending the same attachment twice after refresh or retry.
- [ ] Deliver transcription/agent progress through the existing widget event channel.
- [ ] Render the audio player and transcript without exposing storage keys or provider details.
- [ ] Provide a short user-safe error and retry action for provider/media failures.
- [ ] Test the widget on mobile, tablet, desktop, keyboard-only, and permission-denied paths.
- [ ] Verify the widget continues to support text-only visitors without regression.

## 8. Agent execution and response behavior

- [ ] Pass only the normalized transcript into the existing agent context.
- [ ] Preserve original attachment metadata for Inbox and audit without adding it to the prompt unnecessarily.
- [ ] Ensure transcript content remains subject to existing tool authorization and approval policy.
- [ ] Ensure exactly one run is created per accepted audio message.
- [ ] Ensure agent retries do not re-transcribe or duplicate outbound replies.
- [ ] Keep text-message processing independent when the transcription provider is unavailable.
- [ ] Add a user-safe failure reply for channels that cannot show asynchronous UI state.
- [ ] Verify conversation ordering when transcription completes after later text messages.
- [ ] Decide and test whether later text messages can overtake a pending audio job.

## 9. Usage, analytics, and observability

- [ ] Register versioned analytics contracts for received, started, completed, failed, dispatched,
  and retried audio events.
- [ ] Define privacy fields and prohibit transcript, audio URL, filename, and credential payloads.
- [ ] Add duration/file-type/channel/status/latency buckets as bounded dimensions.
- [ ] Add structured logs for ingestion, storage, scan, provider call, worker retry, completion,
  agent dispatch, delivery, and deletion.
- [ ] Include environment, release, correlation/request ID, organization/message/attachment IDs
  where allowed, outcome, attempt, latency, and bounded error code.
- [ ] Add metrics for accepted audio, queue depth, stale jobs, provider error rate, latency,
  completion rate, duplicate prevention, agent dispatch, and text delivery.
- [ ] Add dashboards for provider health, queue health, channel breakdown, and retention failures.
- [ ] Add alerts for sustained provider failures, stuck jobs, storage failures, and abnormal cost.
- [ ] Track ElevenLabs duration/character cost without storing unnecessary audio content.
- [ ] Decide whether usage appears in customer billing/credits and document the decision.

## 10. Admin and operations

- [ ] Add an Admin/Inbox view for audio source, duration, transcription state, and safe error code.
- [ ] Add retry for terminal retryable failures with authorization and audit logging.
- [ ] Add quarantine/release controls only for authorized operators.
- [ ] Add retention/deletion controls that remove both source and derived transcript as required.
- [ ] Add provider configuration and health status without exposing the API key.
- [ ] Add a runbook for stuck jobs, provider outage, bad audio, storage failure, and privacy deletion.
- [ ] Document the provider disable switch and text-only fallback.
- [ ] Verify operator actions cannot access another organization’s audio or transcript.

## 11. Automated tests

### Unit and contract tests

- [ ] Validate MIME, magic bytes, size, duration, filename, checksum, and format normalization.
- [ ] Validate canonical audio attachment and transcript schemas.
- [ ] Validate provider success, pending, malformed, 4xx, 429, 5xx, timeout, and retry mapping.
- [ ] Validate idempotency keys, duplicate completion, lease expiry, and retry backoff.
- [ ] Validate safe error codes and redaction.
- [ ] Validate language hints, captions, and empty/low-confidence transcript behavior.

### Database and service integration tests

- [ ] Create an audio attachment and verify durable job state.
- [ ] Complete a transcription and verify one normalized transcript.
- [ ] Verify one agent dispatch and one normal text response.
- [ ] Retry a provider failure and verify no duplicate transcript or agent run.
- [ ] Verify permanent media/provider failure becomes operator-visible and user-safe.
- [ ] Verify organization/session authorization on upload, read, retry, and delete.
- [ ] Verify retention deletion removes the source and derived transcript.
- [ ] Verify text messages continue while the provider is unavailable.

### Channel fixture tests

- [ ] WhatsApp voice note fixture.
- [ ] WhatsApp audio-file fixture.
- [ ] Telegram voice-message fixture.
- [ ] Telegram audio-file fixture with caption.
- [ ] Discord audio-attachment fixture.
- [ ] Unsupported/malicious/oversized fixture for each adapter.

### Browser E2E

- [ ] KasIAI record → upload → transcribe → agent reply → play audio → view transcript.
- [ ] KasIAI file upload → retry after provider failure.
- [ ] Widget record → upload → transcribe → response delivery → transcript display.
- [ ] Widget text-only flow remains green.
- [ ] Permission denied, cancel, refresh, duplicate click, retry, and offline/error states.
- [ ] Desktop, tablet, mobile, keyboard, and accessibility checks.

### Staging/provider acceptance

- [ ] Deploy additive migrations to an isolated staging database.
- [ ] Configure a real ElevenLabs key through the secret manager.
- [ ] Use a short synthetic audio fixture with no customer data.
- [ ] Run one journey for each enabled channel.
- [ ] Verify provider latency, usage/cost, logs, metrics, and redaction.
- [ ] Verify text fallback with provider disabled.
- [ ] Verify retention and cleanup of the staging fixture.
- [ ] Record commit SHA, release ID, artifact versions, configuration revision, and evidence.

## 12. Documentation and release closure

- [ ] Update public docs for supported audio input and limitations.
- [ ] Update widget/API integration docs with upload and transcript contracts.
- [ ] Update internal architecture docs with message/media/transcription ownership.
- [ ] Add ElevenLabs configuration and provider-failure runbook.
- [ ] Add privacy/data-retention and deletion documentation.
- [ ] Add support guidance for failed, inaccurate, or delayed transcriptions.
- [ ] Add release notes/changelog entry.
- [ ] Complete every release-process field in the plan.
- [ ] Record analytics registry revision, dashboards, alert ownership, and redaction evidence.
- [ ] Assign post-release review date and success-metric owner.
- [ ] Move the plan and checklist to `docs/plans/completed/` only after rollout and review.

## Definition of done

- [ ] A customer can send audio through every enabled channel.
- [ ] Audio is stored, scanned, retained, and deleted according to policy.
- [ ] A transcript is created by the configured provider and linked to the original message.
- [ ] The existing agent receives the transcript and runs exactly once.
- [ ] The customer receives the normal text response in the same conversation.
- [ ] KasIAI and the website widget show recording, processing, playback, transcript, retry, and
  failure states.
- [ ] Text-only conversations work when transcription is disabled or unavailable.
- [ ] Operators can inspect, retry, delete, and disable the feature safely.
- [ ] Privacy, analytics, observability, release, rollback, and documentation evidence is complete.
- [ ] Staging and provider acceptance tests pass on the exact artifact intended for production.
