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
- The current slice performs transcription synchronously before dispatch. A durable transcription
  job, lease, retry queue, and operator retry state remain required before production rollout.

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

All paths must stream bytes, enforce limits before persistence, sniff the file type rather than
trusting only the filename or client MIME type, calculate a checksum, scan the object, and reject
quarantined media before transcription.

### 3. Transcription provider boundary

Define an internal interface similar to:

```text
AudioTranscriptionProvider
├── submit(audio_reference, language_hint, key_terms) -> provider_job
├── poll(provider_job) -> pending | completed(transcript) | failed(error)
└── cancel/delete(provider_job) where supported
```

The worker owns provider calls. The browser, external channel adapters, and agent prompt never
call ElevenLabs directly. Provider responses are normalized into a bounded internal result; raw
provider payloads are not retained by default.

### 4. Durable worker flow

```text
attachment received
  → validate and store
  → enqueue transcription job
  → claim job with lease/idempotency key
  → submit or poll ElevenLabs
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

The current slice has the provider interface, server-side ElevenLabs adapter, audio media support,
and synchronous channel/KasIAI/widget wiring. It deliberately does not mark the durable worker or
transcription table complete.

### Phase 2 — external channel ingestion

1. Add WhatsApp audio/voice-note normalization and authenticated media download.
2. Add Telegram voice/audio normalization and file retrieval.
3. Add Discord audio attachment normalization and controlled copying.
4. Ensure the transcript is placed into the existing agent context and the existing run path is
   invoked exactly once.
5. Add safe external-channel failure replies and operator visibility.

### Phase 3 — KasIAI and website widget

1. Add in-app recording/upload and attachment status UI.
2. Add widget upload/finalize/message APIs with session and origin enforcement.
3. Add widget recording/upload controls and processing states.
4. Add transcript/audio rendering to KasIAI and widget conversations.
5. Verify mobile, tablet, desktop, keyboard, focus, permission denial, cancellation, and retry.

### Phase 4 — operations, usage, and rollout

1. Add structured logs, metrics, analytics registry events, dashboards, and alerts.
2. Add admin tools for failed jobs, retry, quarantine, deletion, retention, and provider status.
3. Decide whether audio minutes consume credits and implement metering only after approval.
4. Roll out behind per-channel/per-organization flags, beginning with internal and beta workspaces.
5. Run staged external-provider tests and promote the exact tested artifact.

## Release record for current implementation slice

Change: Add server-side audio media validation/storage, ElevenLabs transcription integration, and
audio ingestion paths for WhatsApp, Telegram, Discord, KasIAI, and the website widget.

Owner: Agent Platform and Core Engineering.

Risk: high until the durable worker, abuse limits, retention controls, and provider acceptance tests
are complete; this slice is not production-ready.

Affected services and user surfaces: `agents`, `kasitek-core`, Core content media storage, the
KasIAI composer, and the public website chat widget.

Platform release version or release ID: not assigned; unreleased working-tree implementation.

API/schema/migration changes: additive `ContentMediaKind.AUDIO` migration; authenticated Agent
Platform audio/transcription endpoints; public widget session-scoped `/audio` endpoint; audio
message content fields described above. No destructive migration.

Feature flag or rollout method: not yet implemented. Keep audio entry points disabled in deployed
clients until the worker, abuse controls, provider key, and staging smoke checks are complete.

Analytics events and success metrics: not applicable to this implementation slice; the final
release must register received, transcribed, failed, retried, and dispatched events with duration
and status buckets and no transcript/audio payloads.

Logs, metrics, dashboards, and alerts: bounded provider error codes and correlation IDs are logged;
durable queue metrics, provider dashboards, and alerts remain pending. Collector configuration
revision and hosted retention are not applicable until release deployment is defined.

User, API, internal, and operational documentation: this active plan and checklist are updated;
public audio support documentation and the provider-failure runbook remain pending.

Validation evidence: Agent Platform build and transcription tests pass; Core formatting/check and
client TypeScript checks pass. Real ElevenLabs, channel-provider, widget browser, migration, and
staging tests remain pending.

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

## Release record

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

**Platform release version or release ID:** assign the platform version, commit SHA, service
artifact versions, configuration revision, and migration versions before staging. `not applicable`
until a release artifact is selected.

**API/schema/migration changes:** additive audio attachment/transcription fields or a dedicated
transcription table; authenticated upload/finalize APIs; widget attachment/message contract;
provider-neutral transcript response; queue/job state. Exact migration versions are `not applicable`
until the schema design is approved.

**Feature flag or rollout method:** per-channel and per-organization `audio_transcription` flags;
start with internal workspaces, then beta customers. Disable new jobs without deleting existing
media or transcripts if rollback is needed.

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

**User, API, internal, and operational documentation:** update public channel/widget help,
internal message/media architecture, provider configuration, data-retention/privacy, support
runbook, API contract, and release notes when the feature is available.

**Validation evidence:** unit and provider contract tests, database migration test, recorded channel
fixtures, widget/KasIAI browser tests, mocked provider failure/retry tests, manual ElevenLabs
staging smoke, and full multi-surface acceptance evidence.

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
2. Confirm object-storage authority and whether current media helpers support audio streaming and
   deletion.
3. Confirm the queue/worker owner and whether Core or Agent Platform owns transcription jobs.
4. Confirm initial duration/size/format limits and language expectations.
5. Confirm whether audio transcription is free during beta or consumes credits.
6. Confirm the first supported external channel for a real-provider staging test.
7. Assign release owner, analytics owner, privacy reviewer, and support owner.
