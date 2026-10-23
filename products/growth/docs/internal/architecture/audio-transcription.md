---
title: Audio input support
owner: engineering
last_reviewed: 2026-10-23
---

# Audio input support

Growth's embedded assistant currently accepts text and authorized typed product context.
The retired installation-based audio upload/transcription job API is removed. Do not configure
ElevenLabs credentials or advertise that old audio workflow as part of Growth agent chat.

Normal human Inbox media attachments and provider downloads remain Growth-owned. Their storage
and provider permissions do not authorize a model to read them. Standalone Agents channel media
support is documented in its [source boundary](../../../../agents/docs/source-boundary.md).
