---
title: Agent Media Harness
owner: agent-platform
last_reviewed: 2026-08-31
---

# Agent Media Harness

The Agent Platform uses one media contract for hosted agents and channel gateways. Core owns
workspace media bytes, authorization, scanning, processing state, and storage. Agent Platform owns
agent reasoning, durable run output, and delivery orchestration. A gateway owns only the final
provider-specific rendering.

## Durable contract

`AgentMediaReference@1` contains a stable Core `assetId`, `kind`, optional `mimeType`, `fileName`,
`altText`, `caption`, and `disposition`. It never contains provider URLs, storage keys, or bytes.
`AgentResponse@1` contains `version`, `text`, `media[]`, and optional trusted authorization
remediation metadata. The authorization metadata contains only normalized capability keys and a
Connections deep-link intent; it never contains provider scopes or credentials.

The envelope is stored in run output and conversation message JSONB. Older `{ text }` records remain
valid through the compatibility parser. Inbound channel attachments are normalized to the same
stable `media[]` projection while retaining the legacy single-attachment fields for existing
transcription and UI consumers. Provider adapters may omit optional metadata or encode it as `null`;
the canonical channel boundary accepts both forms and emits the normalized optional representation.

## Request and delivery flow

```text
provider or web input
        |
        v
Core / channel adapter stores asset and stable assetId
        |
        v
Agent Platform context + authorized media metadata
        |
        v
kasitek.agent.respond { text, media[] }
        |
        v
durable run/message envelope (URL-free)
        |
        +--> platform web: authenticated asset route
        +--> website: session-authorized short-lived preview URL
        +--> Telegram: native media method or link fallback
        +--> WhatsApp: Core-owned upload and native Cloud API method
        `--> Discord: image embed or authorized link fallback
```

`kasitek.core.content_media_get` returns organization-scoped metadata. The separate
`kasitek.core.content_media_preview` capability returns a short-lived preview URL when a model or
gateway needs one. The harness final-response capability validates asset ownership, media kind, and
ready/clean state before completing the run.

Provider publishing is also asynchronous at the adapter boundary. Instagram media containers are
polled until the provider reports `FINISHED` before `media_publish` is called. A bounded timeout or
terminal provider state completes the action with an error; it must not be converted into a local
success or an unbounded gateway wait. The Agent/Core client gives publishing a separate bounded
response deadline because provider media processing can outlast ordinary Core reads. If the
provider effect and local persistence complete but a readback or usage-recording step degrades,
Core returns the successful publish result and emits a bounded diagnostic instead of reporting a
false publish failure. A true response timeout remains an indeterminate result: callers check the
durable publish job before retrying, and idempotency prevents duplicate execution.

For multi-destination publishing, Core performs one media and content preflight per target before
queueing any provider job. The approved snapshot names the concrete account, selected variant,
media identity, and required capability; the client and gateways receive only the normalized
target state and remediation mode. A media or permission failure blocks the complete batch before
external effects. After admission, each target keeps its own job and receipt state so a successful
provider publication is preserved when another target fails or becomes indeterminate.

## Gateway profiles

Profiles are explicit in the
[Agents media profile registry](https://github.com/Kasitek-Labs/kasitek-agents/blob/main/src/media/profiles.ts)
and are evaluated before delivery:

| Gateway | Native handling | Fallback |
| --- | --- | --- |
| Platform web | Authenticated image, video, audio, and file rendering | None |
| Website widget | Session-authorized image, video, audio, and file rendering | None |
| Telegram | `sendPhoto`, `sendVideo`, `sendAudio`, or `sendDocument` | Text/link delivery |
| WhatsApp | Core uploads workspace bytes and sends Cloud API media | Authorized link text for unsupported kinds |
| Discord | Image embeds | Authorized links for other kinds |
| Facebook / Instagram | Text only | Explicit text fallback |

The profile is not permission. Core and Agent Platform still recheck organization ownership,
processing state, scanning state, installation grants, and provider connection status.

## Security and reliability

- Signed URLs are minted only at read or delivery time and are not stored in responses, messages,
  memory, summaries, or delivery events.
- WhatsApp delivery reads bytes through Core and never passes provider credentials to the agent
  worker.
- Website delivery stores typed content and hydrates previews only after validating the active
  visitor session and deployment organization.
- Delivery retries reuse stable asset IDs and mint fresh transport resources.
- A rejected channel-ingest request or failed run reaches a terminal state and attempts one bounded
  user-facing text response; it must not leave the gateway waiting without an outcome.
- If a preview cannot be resolved or a provider rejects a native remote media reference, delivery
  records a bounded media-resolution event and preserves the text reply with a link or unavailable
  attachment notice where the channel supports it.
- Channel UI fallbacks render a list's configured empty state without emitting an orphan list title.
- Idempotency remains at the delivery-attempt boundary. A provider failure is recorded with a
  bounded error; a text fallback is used only when the adapter can send it as a separate bounded
  transport attempt.
- Delivery lifecycle events include channel, media count, media kinds, and outcome; they exclude
  URLs, bytes, credentials, captions, and message bodies.

## Operational checklist

Before broad rollout, verify the agents worker, agents API, Core, database migration, website
widget, and each configured provider with one non-sensitive image and one text-only reply. Telegram,
WhatsApp, and Discord inbound supported media are stored as Core-owned assets before the agent run;
unsupported or failed downloads receive an explicit channel response. Monitor media resolve failures,
native delivery failures, fallback count, delivery latency, and provider authentication failures.
Disable native media per gateway and continue text delivery if a provider regression appears.

The compatibility Markdown adapter remains for older agent versions. New agent runs should use
`kasitek.agent.respond`; remove the adapter only after its usage and fallback metrics remain zero for
the agreed compatibility window.
