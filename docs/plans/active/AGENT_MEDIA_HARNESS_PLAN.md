# Agent Media Harness Plan

**Status:** Active until the staged release and compatibility review are complete
**Owner:** Agent Platform
**Last updated:** 2026-08-31

## Objective

Make media discovery, preview, and delivery a built-in Agent Platform capability. Every hosted
agent can reference workspace-owned media, and every supported gateway renders the same response
contract according to its provider limits. Durable records contain stable asset references rather
than expiring provider URLs.

## Scope and ownership

- Core owns media bytes, workspace authorization, processing and scan state, storage, and provider
  credentials for Core-owned channels.
- Agent Platform owns reasoning, capability discovery, durable run output, response validation, and
  delivery orchestration.
- Gateway adapters own only provider-specific rendering and fallback behavior.
- Included gateways: platform web, website widget, Telegram, WhatsApp, Discord, Facebook, and
  Instagram. Media generation and new providers are out of scope.

## Contract

`AgentMediaReference@1` contains `assetId`, `kind`, optional `mimeType`, `fileName`, `altText`,
`caption`, and `disposition`. `AgentResponse@1` contains `version`, `text`, and `media[]`.
Neither contract contains URLs, storage keys, credentials, or bytes.

The harness-owned `kasitek.agent.respond` capability validates the response and Core asset
ownership, kind, readiness, and scan status before completing the run. The read capabilities
`kasitek.core.content_media_get` and `kasitek.core.content_media_preview` expose safe metadata and,
only when required, a short-lived preview URL.

## Gateway decisions

| Gateway | Native media | Fallback |
| --- | --- | --- |
| Platform web | Authenticated image/video/audio/file rendering | none |
| Website widget | Session-authorized image/video/audio/file rendering | none |
| Telegram | Native photo/video/audio/document methods | text/link |
| WhatsApp | Core byte read, upload, and Cloud API media methods | authorized link text |
| Discord | Image embeds | authorized links |
| Facebook / Instagram | text only | explicit text notice |

Delivery resolves transport URLs or bytes at the last responsible moment. Retries reuse stable
asset IDs and mint fresh transport resources. Markdown image extraction remains a compatibility
adapter for older text-only runs; new hosted runs use the typed response capability.

## Checklist

- [x] Add versioned shared media and response schemas with legacy parsing.
- [x] Add Core workspace-scoped metadata, preview, and byte-read boundaries.
- [x] Add the harness final-response capability and typed loop/workflow completion.
- [x] Persist typed responses in run output and conversation messages without provider URLs.
- [x] Add gateway profiles and native/fallback delivery for supported channels.
- [x] Normalize inbound attachments to stable `media[]` references while retaining legacy fields.
- [x] Render typed media in platform chat and website widget; add Telegram/Discord/WhatsApp tests.
- [x] Update internal architecture, REST/MCP documentation, and generated capability docs.
- [ ] Run staged production smoke tests and complete the compatibility-window review.

## Verification

- Agent tests: `pnpm exec vitest run test/media-contracts.test.ts test/runtime.test.ts test/core-client.test.ts test/telegram-client.test.ts test/discord-client.test.ts`
- Agent build: `pnpm run build`
- Core: `cargo fmt --all -- --check && cargo check -p kasitek-core`
- Database: apply `20260831120000_add_agent_website_delivery_content` before enabling website typed
  deliveries.
- Staging smoke: one non-sensitive image, one video/audio or document where supported, and one
  text-only response on each configured gateway. Verify retries, provider failure, authorization,
  expired URL renewal, and UI previews.

## Release record

Change: shared media viewing, preview, and delivery in the Agent Platform harness.
Risk: high; affects agents API/worker, Core, database, MCP/REST discovery, web chat, website
widget, and provider gateways.
API/schema/migration: additive `AgentResponse@1`, two Core internal read routes, typed channel
delivery input, and one additive website delivery JSONB column.
Rollout: apply the additive migration, deploy the exact tested artifacts, then enable gateway media
delivery in stages. Keep text and Markdown compatibility available during the review window.
Analytics/logging: reuse message lifecycle contracts; include bounded media count/kinds and outcome
in delivery events/logs. Never log URLs, bytes, credentials, captions, or message bodies.
Documentation: internal harness architecture plus public Agent REST and MCP media contract docs are
updated in this change.
Analytics success signal: `agent.reply.delivered` with a bounded media count/kind dimension; failure
signal: `agent.reply.delivery_failed` and provider authentication/delivery error rates. No new
analytics event name is introduced.
Logs, metrics, dashboards, and alerts: existing message lifecycle and provider delivery telemetry
is extended with media count/kinds and bounded outcome fields; no new dashboard or alert is added in
this implementation, so hosted rollout must verify the existing delivery views and alert thresholds.

Platform release version or release ID: no SemVer platform tag exists in this repository yet; the
production Railway deployment IDs are recorded below. The API contract version (`AgentResponse@1`)
and migration version remain separate.
Implementation commit: `c24dfdff59a8bfd9f4ac6009be539eb78d6a1a4c` (integrated with the current `main`
live-chat base and pushed to `main`).
Validation: local and production evidence is recorded below. Provider-specific smoke and
compatibility-window evidence remain open before closing this plan.
Rollback: disable native media per gateway and continue text delivery; roll back artifacts only
after confirming the additive column and stable references remain readable.
Post-release review: pending deployment; schedule one business day after each gateway enablement
and after the compatibility window.

Local validation evidence (2026-08-31):

- `agents`: 60 targeted Vitest tests passed and `pnpm run build` passed.
- `client`: `pnpm --filter client lint` passed with two pre-existing/non-blocking warnings and
  `pnpm --filter client build` passed.
- `server`: `cargo fmt --all -- --check`, `cargo check -p kasitek-core`, and `cargo test -p
  kasitek-core` passed (214 passed, 3 database-dependent tests skipped).
- `database`: Prisma generation and schema validation passed. Migration
  `20260831120000_add_agent_website_delivery_content` was applied successfully to the production
  Core database through the documented Railway SSH tunnel on 2026-08-31.
- Production Railway deployments from this commit: Core
  `619dc31f-19dd-4486-9f63-7989d1d3fa7e`, Agents API
  `e1c8e6da-24d0-4b3c-86fc-35c26b3db74a`, Agents worker
  `50435708-1e17-46eb-a761-a5d6fe1ebc32`, and MCP Gateway
  `7906a81f-a2e8-4b32-b967-d22543c5c49b`; all report `SUCCESS` and `RUNNING`.
- Production health smoke: `https://api.kasitek.co.za/health` and
  `https://agents.kasitek.co.za/health/ready` returned HTTP 200; Core reported `status: ok`, the
  gateway reported `status: ready`, and the Agents worker logged `state: RUNNING` for
  `kasitek-agents-production`. No error-level logs were returned for the four services during the
  post-deploy sweep.
- The pushed `main` commit triggered the connected Vercel frontend automation; both
  `https://kasitek.co.za` and `https://app.kasitek.co.za` returned HTTP 200. Vercel CLI deployment
  inspection was unavailable because this environment is not authenticated to Vercel.
- Provider-specific media send/retry smoke and fallback-rate evidence: pending a safe, non-customer
  test message on each configured gateway; do not close the compatibility window until that smoke
  is recorded.
