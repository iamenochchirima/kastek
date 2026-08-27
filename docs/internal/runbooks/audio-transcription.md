---
title: Audio transcription runbook
owner: agent-platform
last_reviewed: 2026-08-27
---

# Audio transcription runbook

Use this when audio jobs are delayed, fail, or need to be removed. Do not copy API keys, signed
media URLs, raw transcripts, provider responses, or message bodies into tickets.

## First checks

1. Open Admin → Operations and check the audio transcription provider status and job list.
2. Confirm the provider reports `ready` and `credentialConfigured: true`. A missing or rejected
   key is reported as `AUDIO_TRANSCRIPTION_NOT_CONFIGURED` or
   `AUDIO_TRANSCRIPTION_PROVIDER_AUTH_FAILED`; replace the secret through the secret manager.
3. Check the worker logs using the job ID and correlation ID. Safe lifecycle events include the
   attempt, bounded error code, and dispatch kind.
4. Check the job state:
   - `queued`: waiting for a worker;
   - `processing`: provider call or media download in progress;
   - `retryable_failed`: scheduled for another attempt;
   - `dispatching`: transcript exists and agent acceptance is being retried;
   - `failed`: terminal failure requiring review;
   - `completed`: transcript and agent dispatch recorded;
   - `deleted`: audio and derived job content removed.

## Provider outage or rate limiting

1. Confirm whether failures are `AUDIO_TRANSCRIPTION_RATE_LIMITED` or
   `AUDIO_TRANSCRIPTION_PROVIDER_FAILED`.
2. Disable `audio_transcription_enabled` at the narrowest affected scope when the provider is
   persistently unavailable. This stops new audio jobs; text processing remains available.
3. Do not delete queued jobs during a transient outage. Re-enable the flag after provider health
   is restored and confirm the queue drains.
4. For a permanent credential failure, update the server-side secret and verify the health panel.
   Never test by pasting the key into an issue or chat.

## Retry and terminal failure

- Use **Retry transcription** only for `failed` or `retryable_failed` jobs. The command requires a
  second operator approval and writes an audit record.
- A retry resets the provider attempt state but keeps the original asset and idempotency identity.
- External WhatsApp, Telegram, and Discord jobs receive a provider-neutral retry message after a
  terminal failure. KasIAI and widget users can use their retry action.
- If a job is `dispatching`, do not manually re-send the channel message. The worker retries agent
  acceptance without submitting the audio again.

## Retention and deletion

1. Confirm the organization attachment policy and check active legal holds before applying it.
2. Use **Apply retention policy** for an organization to remove eligible terminal audio jobs. The
   retention query excludes active organization, installation, and conversation holds.
3. Use **Delete audio** for a specific completed or terminally failed job. It requires dual control,
   deletes the Core audio asset, clears the transcript/result fields, and preserves the audit event.
4. If storage deletion fails, retain the job audit record, record the asset ID and correlation ID,
   and escalate to Core/storage operations. Do not repeatedly submit transcription commands.

## Escalation evidence

Record only: environment, release/configuration revision, organization ID, job ID, correlation ID,
status, attempt count, bounded error code, first/last failure time, and the operator command ID.
Include provider usage/cost evidence only from the provider console or approved metrics system.
