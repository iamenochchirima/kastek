---
title: Audio input and transcription
sidebar_position: 4
owner: agent-platform
last_reviewed: 2026-08-27
---

# Audio input and transcription

This document records the current ownership and processing contract for audio input. It covers
transcription only; it does not add voice agents, text-to-speech, or phone support.

## Ownership

- Core owns provider-facing message attachments and controlled `ContentMediaAsset` bytes.
- Agent Platform owns canonical conversation messages, `audio_transcription_jobs`, transcription
  retries, and the single agent dispatch after transcription.
- Channel adapters normalize audio into the same attachment content shape. WhatsApp media is
  retrieved by Core; Telegram and Discord media are retrieved by Agent Platform.
- KasIAI uses the authenticated Agent Platform audio boundary. The website widget uses the Core
  session/origin boundary and receives only opaque job and playback references.
- ElevenLabs is called only by the Agent Platform worker. API keys and raw provider responses never
  cross into browsers, channel messages, or prompts.

## Processing contract

```text
validated audio asset
  -> queued audio_transcription_jobs row
  -> leased worker claim
  -> ElevenLabs batch transcription
  -> bounded transcript on the job
  -> one idempotent platform/external message acceptance
  -> normal text agent run and reply
```

The job is unique by organization and idempotency key. A worker lease, attempt count, bounded
backoff, and terminal failure state make provider and delivery failures recoverable. If a dispatch
fails after transcription, the job remains in `dispatching` and is retried without calling the
provider again.

## Security and retention

Agent Platform validates the supported audio MIME type, maximum size, and file signature before
transcription. Core owns the media authorization boundary and generates short-lived playback URLs
for the website widget. The current implementation does not yet perform duration inspection or a
malware scan; these are rollout gates, not assumptions.

Audio retention is governed by the organization attachment policy. Retention candidates exclude
active organization, installation, and conversation legal holds. A dual-approved operator delete
removes the Core audio asset and clears the derived transcript/result fields from the job while
retaining the audit record.

## Rollout and failure behavior

The `audio_transcription_enabled` operator flag can be scoped globally, to an organization, or to
an installation. Disabling it stops new jobs and leaves existing text conversations available.
External channels receive a short provider-neutral failure message after a terminal failure;
KasIAI and the widget expose retry state. Operators can inspect safe job fields, retry retryable
failures, apply audio retention, and delete terminal audio jobs through dual-control commands.

## Known release gates

- Confirm product limits, supported languages, credit treatment, privacy notice, and retention
  periods.
- Add duration validation and a real scanner/quarantine boundary before general availability.
- Complete isolated migration, channel-fixture, browser, and real-provider staging evidence.
- Add queue/provider dashboards and alert ownership in the deployment environment.
