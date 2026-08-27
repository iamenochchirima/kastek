# Audio Input and Transcription Implementation Plan

**Status:** In progress

**Owner:** Product, Agent Platform, and Core Engineering

**Last updated:** 2026-08-27

## Objective

Allow a customer to send an audio message through WhatsApp, Telegram, Discord, in-app KasIAI,
or the website chat widget and receive the same reliable KasiTek agent experience as a text
message:

`audio received → audio stored safely → transcript created → existing agent runs once → text reply`

The first release is audio input and transcription. It is not a phone agent, a voice persona, or
text-to-speech. Success means the original audio remains available, the transcript is attached to
the same conversation, the agent can use it as context, failures are retryable, and duplicate
provider requests cannot create duplicate agent runs.

## Scope

### Included

- Audio-message ingestion for WhatsApp, Telegram, and Discord.
- Audio recording or upload in in-app KasIAI.
- Audio recording or upload in the public website chat widget.
- ElevenLabs Speech-to-Text as the first provider, behind a KasiTek provider interface.
- Batch transcription for the first release; real-time partial transcription is a later phase.
- Secure media download, validation, storage, scanning, retention, and deletion.
- A durable asynchronous transcription job with retries, backoff, and a terminal failure state.
- A transcript derived from the original attachment and linked to the same message/conversation.
- Agent dispatch only after successful transcription, with message-level idempotency.
- Transcript and audio playback visibility in Inbox, KasIAI, and the website widget where supported.
- Usage measurement, provider-cost tracking, structured logs, metrics, operational controls, and
  privacy documentation.
- Unit, provider-contract, database integration, channel-fixture, browser, and staging smoke tests.

### Excluded

- Full voice agents or phone receptionist flows.
- Inbound or outbound telephony changes.
- Text-to-speech or audio replies in the first release.
- Voice cloning, voice design, or per-customer voice personas.
- Real-time streaming transcription with partial words in the first release.
- Replacing KasiTek’s agent model, tool registry, permissions, credits, or conversation authority.
- Sending raw audio or provider API keys to an LLM or browser client.
- Automatic transcript translation or speaker diarization unless a later use case requires it.

## Context and constraints

- The Agent Platform already has canonical `text` and `attachment` message types. Audio should be
  represented as an attachment with a declared MIME type and a derived transcription, rather than
  inventing a second conversation model.
- The Core database already models message attachments with provider IDs, MIME type, byte size,
  duration, storage keys, download state, and scan state. The implementation must determine which
  Core or Agent Platform attachment table is authoritative for each channel before adding fields.
- WhatsApp client types already include audio attachments. Telegram currently normalizes documents
  and photos but needs explicit voice/audio handling. Discord exposes attachments but needs an
  audio-specific canonical mapping.
- The website widget currently accepts a JSON text message. Audio needs a secure upload boundary
  and a message reference to the stored attachment.
- Existing agent execution, tool authorization, conversation ordering, and delivery systems remain
  authoritative. Transcription is a prerequisite to an existing agent run, not a second agent.
- Provider audio URLs and credentials are short-lived or secret. Store provider media IDs and
  internal storage keys where possible; do not persist raw authenticated download URLs.
- Anonymous widget traffic needs separate abuse controls from authenticated workspace traffic.
- ElevenLabs documentation: [Speech-to-Text](https://elevenlabs.io/docs/overview/capabilities/speech-to-text)
  and [Speech-to-Text API](https://elevenlabs.io/docs/api-reference/speech-to-text/convert).

## Boundary inventory evidence

The first implementation slice confirms these ownership boundaries:

- Core `MessageAttachment` remains the provider-facing inbox attachment record. Core
  `ContentMediaAsset` is the controlled byte store and now supports additive `AUDIO` assets.
- Agent Platform messages remain the conversation authority. Audio messages are stored as
  `attachment` messages with `assetId`, `mimeType`, `mediaKind`, `transcript`, and bounded
  transcription metadata in message content.
- WhatsApp media is downloaded by Core; Telegram and Discord provider media is downloaded by Agent
  Platform. Provider URLs are not persisted as canonical message content.
- Authenticated KasIAI audio uses the Core media upload boundary and Agent Platform's existing
  platform-message/run path. The website widget uses its session/origin boundary, stores audio in
  Core, then forwards only the normalized attachment reference and transcript to Agent Platform.
- The current slice queues transcription durably. Agent Platform owns the job lease, bounded retry,
  terminal failure, operator retry/delete, and the single dispatch after transcription. ElevenLabs
  is currently called as one bounded batch request; provider-side polling is not used.

## Product and technical decisions

| Topic | Decision | Status |
| --- | --- | --- |
| First outcome | Audio input becomes a transcript and follows the existing text-agent path. | Decided |
| Output | Text reply only in the first release. | Decided |
| Provider | ElevenLabs Scribe v2 through a provider abstraction. | Decided |
| Processing | Batch transcription first; real-time transcription is deferred. | Decided |
| Original audio | Preserve it as an attachment and make deletion/retention explicit. | Decided |
| Agent context | Pass the transcript as untrusted message context; never pass raw audio to the LLM. | Decided |
| Duplicate handling | One transcription job and one agent dispatch per message/attachment identity. | Decided |
| Limits | Proposed maximum: one audio attachment, 25 MB, three minutes per message. | Needs confirmation |
| Supported formats | Proposed allowlist: `audio/ogg`, `audio/mpeg`, `audio/mp4`, `audio/wav`, `audio/webm`, and provider-specific voice-note variants. | Needs confirmation |
| Credits | Measure duration and provider cost first; do not deduct customer credits until pricing is approved. | Needs confirmation |
| Customer transcript visibility | Show it in KasIAI/widget and operator Inbox; do not automatically echo a full transcript back over external channels. | Needs confirmation |
| Retention | Audio and transcript must share an owner, retention period, deletion action, and audit record. | Needs Product/Privacy decision |
| Data processing | Confirm that sending customer audio to ElevenLabs is acceptable for each deployment and document consent/notice requirements. | Needs Product/Privacy decision |

## Target architecture

### 1. Canonical message and attachment

Each channel adapter produces the same logical shape:

```text
Message
├── id, organization, conversation, sender, provider identity
├── contentType = attachment
└── Attachment
    ├── kind = audio
    ├── mimeType, byteSize, durationMs, checksum
    ├── providerMediaId or upload reference
    ├── storageKey, downloadStatus, scanStatus
    └── transcription reference
        ├── status, provider, providerJobId
        ├── transcript, language, duration
        └── attempt/error/completion metadata
```

The source audio is immutable for the lifecycle of the message. A corrected or retried transcript
updates the derived transcription record, not the original attachment.

### 2. Ingestion and normalization

- WhatsApp: resolve the provider media ID, download through the existing authenticated provider
  path, and map voice notes and audio files to `kind = audio`.
- Telegram: handle `message.voice` and `message.audio`; resolve the file through Telegram’s file
  API and retain the provider file ID for retry.
- Discord: inspect attachment MIME type and extension, allow only validated audio, and retain the
  attachment URL/reference until the server has copied it to controlled storage.
- KasIAI: record or select a local file, upload it through an authenticated workspace endpoint,
  and create the attachment before enqueueing transcription.
- Website widget: add a short-lived session upload endpoint or a server-mediated upload. The
  browser receives only an attachment ID and upload state, never a provider credential.

The current implementation enforces a 25 MB limit, supported MIME types, and known file signatures
before transcription. Core owns organization/session media authorization and short-lived playback
URLs, stores a SHA-256 checksum, and returns it on internal reads; Agent Platform verifies the
checksum before sending bytes to ElevenLabs. Streaming, duration inspection, and malware
scanning/quarantine remain release gates because the current upload paths still buffer request
bytes and Core marks uploaded media ready.

### 3. Transcription provider boundary

The current provider boundary is intentionally batch-oriented:

```text
AudioTranscriptionProvider
└── transcribe(audio_bytes, mime_type, file_name, language_hint)
    -> completed(transcript, language) | bounded failure
```

The worker owns provider calls. The browser, external channel adapters, and agent prompt never call
ElevenLabs directly. Provider responses are normalized into a bounded internal result; raw provider
payloads are not retained by default. A submit/poll interface can be added if a future provider
requires asynchronous provider jobs.

### 4. Durable worker flow

```text
attachment received
  → validate and store
  → enqueue transcription job
  → claim job with lease/idempotency key
  → batch transcribe with ElevenLabs
  → persist transcript or bounded failure
  → enqueue one agent run
  → deliver normal text response
```

Provider timeouts and 5xx responses retry with bounded exponential backoff. Invalid media,
unsupported format, limit violations, and provider policy errors become terminal failures with a
user-safe message and an operator-visible error code. A duplicate webhook, worker retry, or page
refresh must not create a second transcript or agent run.

### 5. User experience

- In-app KasIAI and the website widget receive a microphone button, upload option, recording timer,
  cancel action, upload progress, `Transcribing` state, retry action, and concise failure state.
- Render the original audio with a play control and the transcript below it.
- Preserve the user’s typed message composer and text flow unchanged.
- External channels receive the normal text response after transcription. If transcription fails,
  send a short retry request without exposing provider details.
- Admin/Inbox views expose source type, duration, transcription state, and safe error status;
  raw signed URLs and provider credentials are never shown.

## API and data contract

### Internal and authenticated upload boundary

Choose one of these patterns after the storage inventory:

1. `POST /api/.../audio-attachments` with streamed multipart upload, or
2. create-upload → signed upload → finalize-attachment.

The second pattern is preferred for the widget and larger files because Core does not have to hold
the entire upload in an API request. Both patterns must return an opaque attachment ID and current
processing state.

### Website widget boundary

- Add an upload endpoint scoped to an active visitor session and deployment origin.
- Require the same origin/session checks as text messages.
- Bind the uploaded attachment to the session’s external conversation only after validation.
- Accept a message request containing `attachmentId` and optional caption; retain the existing
  idempotency key contract.
- Deliver processing and agent-response events through the existing widget delivery mechanism.

### Transcript contract

Expose a stable, provider-neutral shape:

```json
{
  "status": "completed",
  "text": "...",
  "language": "en",
  "durationMs": 4200,
  "provider": "elevenlabs",
  "completedAt": "..."
}
```

Do not expose provider job IDs, internal storage keys, raw provider responses, or credentials to
anonymous clients. Error responses should use stable codes such as `AUDIO_TOO_LARGE`,
`AUDIO_UNSUPPORTED_FORMAT`, `AUDIO_TRANSCRIPTION_FAILED`, and `AUDIO_TRANSCRIPTION_PENDING`.

## Implementation phases

### Phase 0 — decisions and boundary inventory

1. Confirm limits, supported formats, retention, external processing notice, credit treatment, and
   transcript visibility.
2. Trace WhatsApp, Telegram, Discord, KasIAI, widget, Core, Agent Platform, object storage, and
   queue boundaries.
3. Identify the authoritative message/attachment table and existing media download/scan helpers.
4. Define the provider-neutral transcript contract and release analytics events.

### Phase 1 — storage, schema, and provider foundation

1. Add additive schema fields or a dedicated transcription table with a unique attachment key,
   status, provider metadata, attempts, timestamps, safe error code, and bounded transcript.
2. Add indexes for queued/failed work, organization, conversation, and retention expiry.
3. Add the ElevenLabs configuration boundary; require the key server-side and fail readiness only
   if the selected deployment has audio transcription enabled but no usable key.
4. Implement the provider adapter with timeouts, response validation, redaction, and error mapping.
5. Add a durable transcription queue/worker and idempotent job lease.

The current slice has the provider interface, server-side ElevenLabs batch adapter, audio media
support, durable `audio_transcription_jobs`, worker leases/retries, idempotent dispatch, channel /
KasIAI/widget wiring, lifecycle analytics, operator retry/delete, and retention cleanup. Polling is
not applicable to the current ElevenLabs batch endpoint.

### Phase 2 — external channel ingestion

1. WhatsApp audio/voice-note normalization and authenticated media download are implemented.
2. Telegram voice/audio normalization and file retrieval are implemented.
3. Discord audio attachment normalization and controlled copying are implemented.
4. The worker places the bounded transcript into the existing agent context and uses the existing
   idempotent message/run path exactly once.
5. External-channel failure replies, lifecycle events, and operator visibility are implemented;
   recorded provider fixtures and real-channel acceptance remain pending.

### Phase 3 — KasIAI and website widget

1. KasIAI recording/file selection, durable upload, processing states, retry, audio playback, and
   transcript rendering are implemented.
2. Widget upload/message/status/retry APIs enforce session and origin ownership.
3. Widget recording/file upload, polling status, failure, retry, audio playback, and transcript
   rendering are implemented.
4. Text composition and text-only paths remain separate from audio submission.
5. Mobile, tablet, desktop, keyboard, focus, permission denial, cancellation, and accessibility
   browser evidence remains pending.

### Phase 4 — operations, usage, and rollout

1. Lifecycle analytics, bounded structured logs, queue/provider spans, and the operator health
   projection are implemented. Hosted dashboards and alerts remain deployment work.
2. Admin tools for safe job inspection, retry, deletion, retention, and provider configuration
   status are implemented. Quarantine/release is not implemented because scanning is not yet real.
3. Audio minutes are not metered or deducted from credits pending product approval.
4. `audio_transcription_enabled` is available at global, organization, and installation scope;
   direct transcription checks global/organization scope, while platform and channel ingestion
   checks installation scope. Rollout and beta workspace selection remain release work.
5. Real ElevenLabs, channel-provider, migration, browser, and staging acceptance remain pending.

## Release record for current implementation slice

Change: Add server-side audio media validation/storage, ElevenLabs transcription integration, and
audio ingestion paths for WhatsApp, Telegram, Discord, KasIAI, and the website widget.

Owner: Agent Platform and Core Engineering.

Risk: high until streaming, duration validation, malware scanning, provider acceptance, and rollout
evidence are complete; this slice is not production-ready.

Affected services and user surfaces: `agents`, `kasitek-core`, Core content media storage, the
KasIAI composer, and the public website chat widget.

Platform release version or release ID: not assigned; implementation commits are available in the
repository, but no staging artifact has been selected.

API/schema/migration changes: Core migration `20260827120000_add_audio_content_media`; Agent
Platform migrations `073_audio_transcription_jobs` and `075_audio_transcription_retention`;
authenticated audio upload/status/retry endpoints; public widget session-scoped `/audio` and
status/retry endpoints; operator job and command contracts. No destructive migration.

Feature flag or rollout method: `audio_transcription_enabled` is enforced for direct transcription
at global/organization scope and for platform/channel ingestion at global, organization, and
installation scope. Keep it disabled outside approved internal/beta workspaces until the release
gates below pass.

Analytics events and success metrics: versioned lifecycle contracts are registered for received,
started, completed, failed, dispatched, and user/operator retry. Events contain bounded channel,
provider, status, duration/latency buckets, attempt, and safe error code fields; transcript/audio
payloads are excluded. Hosted dashboards and metric ownership are not assigned yet.

Logs, metrics, dashboards, and alerts: bounded provider error codes, correlation IDs, lifecycle
logs, queue age/retry metrics, and provider spans are implemented. Hosted dashboards, alert
thresholds/owners, Collector configuration revision, and hosted retention are not applicable until
the release environment is selected.

User, API, internal, and operational documentation: public audio input documentation, the internal
ownership reference, this plan/checklist, and the provider-failure runbook are present. API
reference publication and privacy/legal approval remain pending.

Validation evidence: Agent build and TypeScript checks pass; the full Agent suite passes with 78
test files passing and 18 integration files skipped by environment (443 tests passed, 45 skipped);
focused Agent tests include
authenticated HTTP contract tests for direct multipart transcription, Core media acceptance,
durable platform enqueue, organization-scoped job status, WhatsApp canonical inbound enqueue,
Telegram voice/audio-file download/enqueue, malformed Telegram audio rejection, and Discord
attachment download/enqueue; the
database-backed Agent integration suite passes 15/15 tests for retention, operator commands,
platform chat, durable audio enqueue/deduplication, worker completion, retry recovery, and one
agent dispatch; Core formatting/check passes and the Core library suite passes 193 tests with 3
environment-gated tests ignored; client and Admin TypeScript checks pass, the client build passes,
and the public documentation build passes. Admin lint passes with 29 pre-existing warnings and
the client build reports the existing Geist Pixel fallback-font warning. Core checksum verification
and deletion-retry behavior are covered by targeted tests/checks. Real ElevenLabs, channel-provider,
widget browser, clean-install migration, and staging tests remain pending.

Rollback or disable plan: do not enable client entry points; if enabled during development, disable
the audio controls and remove the ElevenLabs key/configuration. The additive audio enum migration
is retained; text paths are unchanged.

Post-release review date: not assigned until staging rollout is approved.

## Reliability and security requirements

- Enforce organization/session ownership on every upload, attachment read, transcript read, retry,
  and delete operation.
- Validate file size, duration, MIME type, magic bytes, checksum, and scan status server-side.
- Never log audio URLs with credentials, API keys, raw transcripts, full message bodies, or signed
  storage URLs.
- Treat transcript text as untrusted user input and preserve existing prompt-injection/tool policy
  boundaries.
- Use idempotency keys for upload finalization, transcription submission, completion handling, and
  agent dispatch.
- Use bounded retries and a dead-letter/operator-review state; do not retry permanent media errors.
- Delete or anonymize both source audio and derived transcript according to the same retention rule.
- Provide a provider-disable switch that stops new transcription jobs while preserving text and
  existing conversations.
- Keep a text fallback for provider outage; the platform must remain usable for text messages.

## Release record for production rollout

**Change:** Add audio input and ElevenLabs-backed transcription to WhatsApp, Telegram, Discord,
KasIAI, and the website chat widget.

**Owner:** Product, Agent Platform, and Core Engineering; release owner to be assigned before
staging.

**Risk:** standard to high, depending on storage and external-provider data handling. The change
adds new media ingress, personal-data processing, background work, and a third-party integration.

**Affected services and user surfaces:** Agent Platform channel adapters and workers, Core message
and media APIs, PostgreSQL, object storage, queue/worker infrastructure, WhatsApp/Telegram/Discord
connectors, KasIAI, website widget, Inbox/Admin operations, analytics, billing/credits, and privacy
documentation.

**Platform release version or release ID:** not assigned. Before staging, record the platform
version, commit SHA, service artifact versions, configuration revision, and migration versions.

**API/schema/migration changes:** Core migration `20260827120000_add_audio_content_media`; Agent
Platform migrations `073_audio_transcription_jobs` and `075_audio_transcription_retention`;
authenticated upload/status/retry APIs; widget upload/status/retry contract; provider-neutral job
response; queue/job state. No destructive migration.

**Feature flag or rollout method:** `audio_transcription_enabled` at global, organization, and
installation scope; start with internal workspaces, then beta customers. Disable new jobs without
deleting existing media or transcripts if rollback is needed.

**Analytics events and success metrics:** register `audio_message_received`,
`audio_transcription_started`, `audio_transcription_completed`, `audio_transcription_failed`,
`audio_agent_dispatched`, and `audio_user_retry` in the Analytics registry. Record only bounded
metadata such as channel, duration bucket, file type, status, provider, latency bucket, and error
code. Success metrics are transcription completion rate, p50/p95 transcription latency, agent
dispatch success, duplicate-dispatch rate, retry rate, text-response delivery rate, and weekly
active audio senders.

**Logs, metrics, dashboards, and alerts:** add structured lifecycle/provider/worker logs with
organization and message identifiers where permitted, environment, release, outcome, attempt,
latency, and bounded error code. Redact transcripts, message bodies, URLs with credentials, and
provider secrets. Add dashboards for queue depth, stale jobs, provider failures, latency, and
storage/retention failures. Add alerts for sustained provider failure and stuck jobs.

**User, API, internal, and operational documentation:** public audio input help, internal
message/media architecture, provider configuration and failure runbook, and active plan/checklist
are present. API reference, privacy/legal approval, and release notes remain pending.

**Validation evidence:** Agent build/typecheck and focused worker/provider/HTTP/channel tests pass;
the full Agent suite passes 443 tests with 45 environment-gated tests skipped; Core
format/check and focused website/media tests pass; client/Admin TypeScript checks pass; the
database-backed Agent integration suite passes 15/15 tests, including durable audio completion,
deduplication, retry recovery, and normal text response insertion. Recorded channel fixtures,
browser E2E, manual ElevenLabs staging smoke, clean-install migration evidence, and full
multi-surface acceptance remain pending.

**Rollback or disable plan:** turn off the audio flag, stop new transcription submissions, allow or
cancel in-flight jobs according to the provider policy, retain conversation integrity, and keep
text-only agent behavior available. Delete test media and transcripts from isolated environments.

**Post-release review date:** seven days after the first enabled workspace, then after the first
1,000 audio messages or thirty days, whichever comes first.

## Verification strategy

- Lint and type-check all changed TypeScript packages.
- Run Rust formatting, Core/Agent Platform compilation, and worker tests.
- Validate Prisma/schema migration and clean install generation.
- Test provider success, timeout, 4xx, 5xx, malformed response, and rate-limit behavior with a
  mock server.
- Test every channel adapter using recorded audio fixtures and provider IDs.
- Test duplicate delivery, worker retry, job lease expiry, and agent-dispatch idempotency.
- Test unauthorized attachment access, origin/session violations, invalid MIME, oversize files,
  overlong audio, malicious files, and retention deletion.
- Run browser E2E for KasIAI and widget recording/upload/transcription/text response at supported
  breakpoints.
- Run a staging test with a real ElevenLabs key, an isolated organization, a short synthetic
  fixture, and a provider-cost/retention review.

## Open questions and blockers

1. Confirm whether ElevenLabs processing is permitted for customer audio under the planned privacy
   and data-retention policy.
2. Add streaming, duration inspection, checksum validation, and a real malware scanner/quarantine
   boundary before general availability.
3. Confirm initial duration and language expectations; the current enforced size ceiling is 25 MB
   and the supported MIME allowlist is documented.
4. Confirm whether audio transcription is free during beta or consumes credits.
5. Complete isolated migration, channel-fixture, browser, and real-provider staging acceptance.
6. Assign release owner, analytics owner, privacy reviewer, support owner, dashboard/alert owners,
   and a post-release review date.
