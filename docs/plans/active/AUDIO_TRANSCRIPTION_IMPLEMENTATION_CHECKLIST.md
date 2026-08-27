# Audio Input and Transcription Implementation Checklist

Use this checklist with [the Audio Input and Transcription Implementation Plan](AUDIO_TRANSCRIPTION_IMPLEMENTATION_PLAN.md).
Mark an item complete only when the implementation and its required evidence exist.

Status markers: `[ ]` not started · `[-]` in progress · `[x]` verified complete · `[?]` requires a
product, provider, privacy, or deployment decision.

## 0. Product, privacy, and boundary decisions

- [x] Confirm the first release is audio input/transcription with text replies only.
- [x] Confirm supported channels: WhatsApp, Telegram, Discord, KasIAI, and website widget.
- [ ] Confirm maximum audio duration, byte size, attachment count, and accepted MIME formats.
- [ ] Confirm target languages and whether language detection or an explicit language hint is used.
- [ ] Confirm ElevenLabs data-processing, retention, regional, and customer-notice requirements.
- [ ] Confirm audio and transcript retention periods and deletion behavior.
- [ ] Confirm whether users see transcripts on external channels, or only in KasIAI/widget/Inbox.
- [ ] Confirm whether transcription is free during beta or metered/deducted from credits.
- [ ] Assign engineering, product, privacy, analytics, operations, and support owners.
- [x] Record current decisions and unresolved decisions in the plan, release record, and supported documentation.

## 1. Current-system inventory

- [x] Trace the canonical Agent Platform message and attachment contracts.
- [x] Trace Core message, attachment, media storage, download, scan, and deletion helpers.
- [x] Confirm Core `MessageAttachment`/`ContentMediaAsset` and Agent Platform messages/jobs as the authoritative channel boundaries.
- [x] Trace WhatsApp provider media retrieval and voice-note handling.
- [x] Trace Telegram update parsing, file retrieval, and outbound message delivery.
- [x] Trace Discord attachment parsing, download, and outbound response delivery.
- [x] Trace KasIAI composer, upload, conversation persistence, and agent dispatch.
- [x] Trace website widget session, origin, upload, message, delivery, and retry flows.
- [x] Trace queue/worker ownership, leases, retry conventions, terminal handling, and metrics.
- [x] Trace existing organization permissions, attachment access, retention, and audit conventions.
- [x] Record the boundary map and unresolved dependencies in the implementation plan.

## 2. Data model and migration

- [x] Choose a dedicated `audio_transcription_jobs` table keyed by organization/idempotency identity.
- [x] Make the attachment/transcription relationship unique and organization-scoped.
- [x] Add status, provider, attempts, timestamps, safe error code, result IDs, and bounded text.
- [ ] Add language, duration, checksum, and provider-cost/duration metadata where appropriate.
- [x] Add indexes for queued work, retryable failures, organization/asset, and retention.
- [x] Preserve existing text messages, attachments, provider IDs, and old clients.
- [x] Ensure the migration is additive, repeatable, and safe with partially processed jobs.
- [x] Add a migration rollback/disable note; migrations do not delete audio data.
- [-] Run Prisma/schema validation and generation; the Core enum migration is present and Agent SQL has contract coverage, but an isolated database run remains pending.
- [ ] Run the migration against an isolated database and verify clean-install behavior.
- [x] Record migration versions in the release record.

## 3. Provider and worker foundation

- [x] Add a server-side ElevenLabs configuration boundary with secret validation.
- [x] Add an `AudioTranscriptionProvider` interface independent of ElevenLabs response shapes.
- [x] Implement Scribe v2 batch submission with request timeouts; provider polling is not applicable to the current endpoint.
- [x] Validate provider responses and normalize bounded transcript and language fields; duration is not yet returned by the adapter.
- [x] Add redaction so keys, signed URLs, raw transcripts, and provider payloads do not enter logs.
- [x] Add a durable transcription job with a lease, idempotency key, attempt count, and safe state.
- [x] Add bounded exponential retry for timeouts, 429s, and retryable 5xx responses.
- [x] Mark invalid media, unsupported formats, and permanent provider errors terminal.
- [x] Add terminal/operator-review state and dual-control retry action.
- [x] Enqueue exactly one agent dispatch after completed transcription.
- [x] Ensure duplicate worker claims and retries are safe; duplicate-completion integration evidence remains pending.
- [x] Add provider health and configuration diagnostics without exposing secrets.

## 4. Media security and privacy

- [x] Enforce authenticated organization ownership for workspace media operations.
- [x] Enforce visitor session and allowed-origin ownership for widget media operations.
- [-] Enforce byte limits before storing or sending to the provider; current paths buffer bytes and streaming remains pending.
- [-] Validate magic bytes, MIME type, and size server-side; duration, extension, and checksum remain pending.
- [ ] Scan audio objects and block quarantined or failed scans from transcription.
- [x] Keep provider keys server-side and store provider media IDs/internal asset references rather than authenticated URLs.
- [x] Use short-lived signed URLs for playback and never log them.
- [x] Treat transcripts as personal data and untrusted user input.
- [x] Define deletion of original audio and derived transcript/job fields; provider-side job deletion is not applicable to the batch endpoint.
- [-] Add audit evidence for operator retry, playback authorization, and delete; quarantine release is pending with scanning.
- [-] Add abuse limits for anonymous widget uploads; a 20-per-session-hour limit exists, while per-organization volume limits remain pending.

## 5. Channel ingestion

### WhatsApp

- [x] Recognize voice notes and audio messages as canonical audio attachments.
- [x] Resolve and download provider media through the authenticated WhatsApp path.
- [x] Preserve provider message/media IDs for retries and deduplication.
- [x] Handle missing media, expired media URLs, unsupported codecs, and provider errors with bounded user-safe replies.
- [ ] Verify transcript context reaches the existing agent exactly once.
- [ ] Verify the normal text reply is delivered in the same conversation.

### Telegram

- [x] Parse `message.voice` and `message.audio` in the channel adapter.
- [x] Resolve the Telegram file ID and copy the file into controlled storage.
- [x] Preserve caption text alongside the audio without losing either input.
- [ ] Handle malformed updates, missing files, unsupported formats, and expired retrieval.
- [ ] Verify transcript context and normal text response with recorded Telegram/provider fixtures.

### Discord

- [x] Detect audio attachments from MIME type and validated file metadata.
- [x] Copy attachments from Discord into controlled storage before the source URL expires.
- [x] Preserve caption/content and attachment identity.
- [x] Enforce server/channel permissions already required by the Discord adapter.
- [ ] Verify transcript context and normal text response.

## 6. KasIAI in-app experience

- [x] Add microphone recording with permission-denied handling.
- [x] Add audio-file selection with client-side hints but server-side validation.
- [-] Show recording timer, cancel, upload progress, and disabled duplicate-submit state; duplicate-submit is guarded, while timer/progress remain pending.
- [-] Show `Uploading`, `Transcribing`, `Ready`, and `Failed` states with retry; the current UI has transcribing/ready/failed and no upload progress indicator.
- [x] Render a compact audio player and transcript in the conversation.
- [x] Preserve text composition and existing send behavior.
- [x] Keep transcript/audio access scoped to the active organization and conversation.
- [ ] Verify keyboard, focus, screen-reader labels, reduced motion, and mobile layout.

## 7. Website chat-widget experience

- [x] Add a session-scoped upload/finalize API or secure signed-upload flow.
- [-] Preserve origin validation, session expiry, and idempotency. A 20-per-session-hour limit exists; per-organization anonymous volume controls remain pending.
- [x] Add a microphone button and file upload with concise processing states.
- [ ] Prevent sending the same attachment twice after refresh or retry.
- [-] Deliver transcription/agent progress through the current widget polling/delivery mechanism; a dedicated event channel is not yet implemented.
- [x] Render the audio player and transcript without exposing storage keys or provider details.
- [x] Provide a short user-safe error and retry action for provider/media failures.
- [ ] Test the widget on mobile, tablet, desktop, keyboard-only, and permission-denied paths.
- [x] Verify the widget text path remains unchanged by the audio boundary; browser regression evidence remains pending.

## 8. Agent execution and response behavior

- [x] Pass only the normalized transcript into the existing agent context.
- [x] Preserve original attachment metadata for Inbox and audit without adding raw audio to the prompt.
- [x] Ensure transcript content remains subject to existing tool authorization and approval policy.
- [x] Ensure exactly one durable job and one idempotent agent dispatch are created per accepted audio message.
- [x] Ensure agent retries do not re-transcribe or duplicate outbound replies.
- [x] Keep text-message processing independent when the transcription provider is unavailable.
- [x] Add a user-safe failure reply for channels that cannot show asynchronous UI state.
- [ ] Verify conversation ordering when transcription completes after later text messages.
- [?] Decide and test whether later text messages can overtake a pending audio job; the current system provides no cross-message ordering guarantee.

## 9. Usage, analytics, and observability

- [x] Register versioned analytics contracts for received, started, completed, failed, dispatched,
  and retried audio events.
- [x] Define privacy fields and prohibit transcript, audio URL, filename, and credential payloads.
- [x] Add duration/file-type/channel/status/latency buckets as bounded dimensions where source metadata exists.
- [x] Add structured logs for provider call, worker retry, completion, agent dispatch, failure delivery, and deletion.
- [x] Include environment/correlation context where available, outcome, attempt, latency, and bounded error code.
- [x] Add queue age/retry, provider dependency, lifecycle, and completion metrics.
- [ ] Add dashboards for provider health, queue health, channel breakdown, and retention failures.
- [ ] Add alerts for sustained provider failures, stuck jobs, storage failures, and abnormal cost.
- [ ] Track ElevenLabs duration/character cost without storing unnecessary audio content.
- [ ] Decide whether usage appears in customer billing/credits and document the decision.

## 10. Admin and operations

- [x] Add an Admin Operations view for audio source, transcription state, and safe error code.
- [x] Add retry for terminal retryable failures with authorization and audit logging.
- [ ] Add quarantine/release controls only for authorized operators.
- [x] Add retention/deletion controls that remove both source and derived transcript as required.
- [x] Add provider configuration and health status without exposing the API key.
- [x] Add a runbook for stuck jobs, provider outage, bad audio, storage failure, and privacy deletion.
- [x] Document the provider disable switch and text-only fallback.
- [x] Verify operator actions cannot access another organization’s audio or transcript through org-scoped job lookup and expected-resource checks.

## 11. Automated tests

### Unit and contract tests

- [-] Validate MIME, magic bytes, size, and format normalization; duration, filename, and checksum validation remain pending.
- [x] Validate the canonical audio attachment/job/transcript contract through route, repository, and worker tests.
- [x] Validate provider success, malformed, 4xx/429 mapping, and missing configuration.
- [-] Validate idempotency keys, lease expiry, and retry backoff in code; duplicate completion and full lease integration coverage remain pending.
- [x] Validate safe error codes and redaction.
- [x] Validate language hints, captions, and empty-transcript behavior; low-confidence handling is not applicable to the current provider response.

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

- [x] Update public docs for supported audio input and limitations.
- [-] Update widget/API integration docs with upload and transcript contracts; public behavior is documented, while a dedicated API reference page remains pending.
- [x] Update internal architecture docs with message/media/transcription ownership.
- [x] Add ElevenLabs configuration and provider-failure runbook.
- [ ] Add privacy/data-retention and deletion documentation.
- [ ] Add support guidance for failed, inaccurate, or delayed transcriptions.
- [ ] Add release notes/changelog entry.
- [x] Complete every release-process field in the plan, using `not applicable` where deployment identity is not assigned.
- [-] Record analytics registry revision and redaction evidence; hosted dashboards and alert ownership remain pending.
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
