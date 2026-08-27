---
title: Audio input
---

# Audio input

When audio input is enabled for a workspace or connection, KasiTek accepts audio messages and
turns them into text for the existing agent conversation. The agent sends its normal text reply.

## Supported surfaces

Audio input is available, when enabled, through:

- WhatsApp voice notes and audio files
- Telegram voice messages and audio files
- Discord audio attachments
- KasIAI audio recording or file upload
- Website Chat recording or file upload

The original audio stays attached to the conversation. KasIAI and Website Chat can show a player
and transcript after processing. External channels receive the normal text response and a short
retry message if transcription fails.

## File limits

- Maximum file size: 25 MB
- Supported formats: AAC, FLAC, M4A/MP4, MP3, Ogg/Opus, WAV, and WebM audio
- One audio attachment is processed per message

Files are validated on the server. Duration limits, availability, and supported language behavior
may vary while audio input is in beta.

## Processing states

Audio can be queued, transcribing, ready, or failed. A failed transcription can be retried from
KasIAI or Website Chat where the control is shown. Text-only messaging continues to work when
audio input is disabled or the transcription provider is unavailable.

## Website Chat contract

Website Chat sends the audio bytes to:

```text
POST /api/widget/v1/sessions/{sessionId}/audio
```

The request uses the audio MIME type as `Content-Type`, the approved page origin as `Origin`, and
an `X-Audio-Idempotency-Key` between 8 and 240 characters. `X-Audio-File-Name` is optional. A
successful response returns `202` with a `jobId`, `assetId`, and queued status.

Poll the job at:

```text
GET /api/widget/v1/sessions/{sessionId}/audio/{jobId}
```

Retry a failed job at:

```text
POST /api/widget/v1/sessions/{sessionId}/audio/{jobId}/retry
```

The browser keeps the idempotency key until the upload is accepted, so a refresh or lost response
can safely repeat the request. Reusing a key with different audio is rejected. The same session and
origin checks apply to status and retry.

Audio input sends media to the configured transcription provider. Do not include confidential
information in a recording unless the workspace administrator has approved that processing path.
