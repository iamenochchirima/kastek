# Agent Media Harness Plan

**Status:** Active

**Owner:** Agent Platform

**Last updated:** 2026-08-31

## Objective

Make media discovery, preview, and delivery a built-in Agent Platform capability. Every hosted
agent should be able to reference workspace-owned media without agent-specific prompt changes, and
every channel gateway should render the same canonical response according to its provider limits.
External agents should discover the same media contracts through the generated MCP and REST
surfaces.

Success means an agent can retrieve a content object, select one of its assets, and return it in a
later reply through the web client, Telegram, WhatsApp, or Discord. Durable records contain stable
asset references rather than expiring provider URLs. Unsupported media has an explicit fallback and
does not silently disappear or fail the whole reply.

## Scope

### Included

- A versioned, channel-independent media descriptor and assistant response envelope.
- Workspace-scoped media metadata/read capabilities generated through the shared registry.
- A harness-owned final-response capability for text plus media references.
- Automatic availability of harness response capabilities for all hosted agent installations.
- Gateway capability profiles and renderers for platform web, Telegram, WhatsApp, and Discord.
- Delivery-time resolution of stable asset IDs to bounded, short-lived URLs or bytes.
- Persistence, retries, approvals, logging, analytics decisions, tests, and compatibility fallbacks.

### Excluded

- Media generation or editing.
- Provider-specific post publishing, which remains in the content capabilities.
- Public anonymous asset URLs or storage credentials in model context.
- A redesign of the web conversation UI beyond consuming the canonical attachment projection.
- Adding channel providers that do not currently exist in the Agent Platform.

## Context and constraints

- Core owns media bytes, workspace authorization, scan/processing status, and asset lifecycle.
- Agent Platform owns reasoning, capability discovery, durable run output, and channel delivery.
- Gateways must remain thin and provider-specific; they must not infer business resources.
- Current replies are persisted as `{ text }`, and Telegram/WhatsApp infer images from Markdown.
  That behavior remains temporarily as a compatibility adapter, not the canonical contract.
- Signed URLs are transport material. They must be resolved at read or delivery time and must not be
  persisted in messages, run output, memory, summaries, or long-lived tool results.
- An agent may only attach assets returned by an authorized capability or explicitly resolved by a
  workspace-scoped media capability.

## Architecture decisions

### Canonical media descriptor

The shared contract is `AgentMediaReference@1`:

```text
assetId       stable Core asset identity
kind          image | video | audio | document | file
mimeType      bounded media type when known
fileName      safe display name when known
altText       accessibility/fallback text when supplied
caption       optional channel caption selected by the agent
disposition   inline | attachment
```

URLs and bytes are deliberately absent from the durable descriptor. Core resolves an authorized
asset into a delivery resource only when the gateway needs it.

### Canonical response envelope

`AgentResponse@1` contains `text` and `media[]`. It is stored in the existing JSONB message content
column, so the first release needs no database migration. Run output and conversation messages use
the same envelope.

### Agent-facing capabilities

- `kasitek.core.content_media_get` returns safe asset metadata and a short-lived preview only for
  the current invocation. It is read-only and workspace scoped.
- `kasitek.agent.respond` is harness owned. The model uses it to finish a response with text and
  stable media references. The harness validates that every asset is authorized and deliverable,
  then completes the loop with a typed response envelope.
- Domain tools return `AgentMediaReference@1` wherever they expose media. They do not invent a
  separate media shape.

The response capability is injected by execution mode, not copied into individual agent prompts or
versions. MCP and REST expose media read/metadata contracts to external agents; the harness response
capability is only meaningful to hosted runs.

### Gateway negotiation and delivery

Each adapter publishes a `ChannelMediaProfile`: supported kinds, maximum item and byte counts,
caption limits, album support, and fallback behavior. Delivery receives `AgentResponse@1`, resolves
assets at the last responsible moment, and returns per-part receipts.

- Platform web stores and returns typed media; the client requests previews through an authenticated
  media endpoint.
- Telegram maps image/video/audio/document to native Bot API methods and uses text links only when
  the provider rejects an otherwise valid attachment.
- WhatsApp maps the same kinds to Core-owned Cloud API delivery and keeps provider credentials in
  Core.
- Discord maps supported kinds to native attachments/embeds and falls back to an authorized link.

Markdown image extraction remains accepted for old agent versions during a compatibility period.
New runs should not depend on it.

### Security and lifecycle

- Core rechecks organization ownership, processing state, scan state, and asset existence for every
  resolve/download request.
- The model sees bounded metadata and, only when needed for visual reasoning, a short-lived preview.
- Delivery logs include asset count, kind, byte size, channel, outcome, and bounded error code; they
  never include signed URLs, bytes, captions, or message bodies.
- Delivery retries reuse the stable envelope and mint fresh transport URLs.
- Removing an asset makes later delivery fail with `MEDIA_NOT_AVAILABLE`; it never reuses unrelated
  bytes or a stale URL.

## Implementation plan

1. [x] Add shared media/response contracts, schemas, validation, and compatibility parsing.
2. [x] Add Core media metadata projection with workspace authorization. Delivery-time byte/URL resolution remains in the gateway slice.
3. [x] Add the harness final-response capability and typed loop/workflow completion.
4. [x] Persist typed responses. Authenticated web preview rendering remains in the web gateway slice.
5. [x] Add gateway profiles and native renderers for Telegram, WhatsApp, Discord, and platform web.
6. [x] Normalize inbound attachments to the same stable media descriptor. Telegram, WhatsApp, and
   Discord supported inbound media now pass through Core-owned storage before agent execution;
   legacy provider fields remain only for controlled ingestion/transcription compatibility.
7. [x] Add contract, authorization, retry, fallback, gateway, and platform integration tests for
   the implemented paths. Controlled production E2E smoke remains a release gate.
8. [ ] Remove prompt-only media instructions after compatibility telemetry shows no legacy use.

## Compatibility and rollout

1. Add contracts and readers while continuing to accept `{ text }` messages.
2. Enable typed response composition for internal test agents, then all hosted agents.
3. Enable native media delivery per gateway behind a gateway-level configuration switch.
4. Verify web, Telegram, WhatsApp, and Discord independently before enabling the next gateway.
5. Retain Markdown extraction for one compatibility window, then remove it in a separate release.

## Verification

- [x] Type check and build Agent Platform and Core.
- [x] Contract tests for `AgentMediaReference@1`, `AgentResponse@1`, MCP, REST, and Core projection.
- [x] Runtime tests for final-response control, unauthorized assets, stale URLs, retries, and limits.
- [x] Gateway tests for image, document, unsupported kind, provider failure, and text-only fallback.
- [x] Integration tests proving the same response envelope reaches platform web, Telegram,
      WhatsApp, and Discord.
- [ ] Production smoke test with a non-sensitive workspace asset on each configured gateway.

## Release record

Change: Shared media viewing, preview, and delivery in the Agent Platform harness.

Owner: Agent Platform.

Risk: High. This changes run completion and all channel delivery paths.

Affected services and user surfaces: agents-api, agents-worker, MCP Gateway, kasitek-core, web agent
chat, Telegram, WhatsApp, Discord, MCP, and Agent REST.

Platform release version or release ID: Assign when the first deployable slice is complete.

API/schema/migration changes: Compatible JSON response-envelope and capability additions. No
database migration is required for the first slice because message and run content are JSONB.

Feature flag or rollout method: Gateway-level media delivery switches and staged hosted-agent
enablement. No all-at-once production rollout.

Analytics events and success metrics: Reuse `agent.conversation.message@1` for message outcomes;
add bounded media count/kind fields in a versioned contract revision if the registry permits it.
Success is a native-media delivery rate above 99% excluding unsupported/removed assets, with no
increase in text delivery failures.

Logs, metrics, dashboards, and alerts: Structured resolve and delivery lifecycle logs; media resolve
failure count, gateway media delivery failure count, fallback count, and latency. Dashboard/alert
work is required before broad production rollout. Collector configuration change: not applicable
for the contract slice; existing OTLP endpoint and release identity apply.

User, API, internal, and operational documentation: This plan, current internal Agent Platform
architecture, MCP/REST media capability docs, and gateway runbook must be updated with each slice.

Validation evidence: 2026-08-31 implementation slice: focused Agent Platform contract, runtime,
workflow, SSE, channel adapter, gateway, and HTTP attachment tests passed (82 tests in the final
focused run); `pnpm run build` in `agents`, client type check, targeted client lint, client
`next build --webpack`, Prisma validation, `cargo fmt --all -- --check`, `cargo check -p kasitek-core`,
and the Core permission tests passed. A browser session was unavailable for visual verification.
Record deployment IDs, provider smoke results, and the remaining gateway telemetry evidence before
moving this document to `docs/plans/completed/`.

Rollback or disable plan: Disable media delivery per gateway, continue text delivery, and roll back
agents/core artifacts. Stored stable asset references remain backward compatible. Do not delete
media metadata during rollback.

Post-release review date: One business day after each gateway production enablement and again after
the compatibility window.

## Decisions and open questions

| Topic | Decision or question | Owner | Status |
| --- | --- | --- | --- |
| Durable identity | Persist Core asset IDs, never signed URLs | Agent Platform + Core | Decided |
| Final response | Use a typed harness response capability | Agent Platform | Decided |
| Gateway support | Capability profile plus explicit fallback | Integrations | Decided |
| Web previews | Use authenticated read-time resolution | Core + Client | Decided |
| Multiple media | Define per-part receipts before enabling albums | Agent Platform | In progress |
| Visual model input | Define when previews may be sent to multimodal models | AI Platform | Open |
| Public API | Decide whether external REST callers receive URLs or a download endpoint | API | Open |

## Notes and blockers

- The current branch has unrelated work. Implementation must use an isolated worktree and avoid
  modifying or staging those files.
- Broad rollout is blocked until per-gateway failure metrics exist. Contract and adapter work can
  proceed independently.
