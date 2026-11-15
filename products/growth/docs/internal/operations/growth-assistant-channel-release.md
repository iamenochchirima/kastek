---
title: Growth assistant channel release record
owner: engineering
last_reviewed: 2026-11-15
---

# Growth assistant channel release record

```text
Change: Growth-native Telegram connection and assistant channel link/manage flow for Telegram and WhatsApp.
Owner: iamenochchirima
Risk: standard
Affected services and user surfaces: Agents API, Growth API, Growth web Connections and Agents hub, Telegram provider setup, Growth-managed WhatsApp link.
Platform release version or release ID: pending production deployment.
API/schema/migration changes: Agents schema 150 (growth-assistant offering) and 151 (unique assistant per workspace, product request results); no Growth schema change.
Feature flag or rollout method: deploy Agents API/worker before Growth API/web; set AGENTS_CHANNEL_WEBHOOK_ORIGIN on the Agents API and worker.
Analytics events and success metrics: existing Agents channel lifecycle telemetry plus bounded `growth.channel.admin` structured logs; success is an active Telegram connection, a bound assistant deployment and a provider-confirmed reply.
Logs, metrics, dashboards, and alerts: structured operation, actor issuer/subject, workspace, connection and outcome fields; no bot token or message content. Existing Agents channel connection and delivery metrics cover health.
User, API, internal, and operational documentation: growth-integration, private-assistant, this record, the Growth feature map and the public social connections page.
Validation evidence: 6 Agents channel admin tests, 27 focused Agents channel tests, 15 Growth channel tests, 3 contract tests, typechecks and production builds for Contracts, Agents API, Growth API and Growth web, and import boundaries for 2,803 files passed locally.
Rollback or disable plan: redeploy the previous Agents and Growth artifacts together; keep the additive tables; remove Telegram webhooks with the bot owner's token if a connection must be retired.
Post-release review date: 14 days after deployment.
```

## What changed

- Telegram is now a Growth connection. Growth admins connect a bot from **Connections** without an
  Agents account. Agents owns the bot token and verifies the bot through the existing
  `TelegramSetupService`.
- The Growth assistant card in **Agents** has a **Channels** dialog. Owners and admins can link or
  unlink a connected Telegram bot or an eligible WhatsApp number; members can view the list.
- Linking shows a routing warning: inbound messages move from the Growth Inbox to the Growth
  assistant. Unlinking Telegram revokes the Agents deployment.
- WhatsApp keeps the existing Growth-managed grant path. The new `growth.link` operation runs the
  same pending/active store transition, grant row, deployment and provider routing as the existing
  channel link.
- The Growth assistant is an explicit `growth-assistant` target, not an organization assistant.
  Schema 151 allows one active assistant per workspace.
- Growth projects Telegram connections into `ExternalConnection` with display, health and
  capability metadata only.

## Security and boundaries

- Growth signs channel requests with its existing product-service key. Agents verifies the request
  digest and records each request in `product_service_assertions`.
- Agents resolves the target assistant from the Growth tenant mapping. Callers cannot choose an
  Agents agent ID.
- Agents acts through one product-owned service principal per workspace
  (`https://growth.kasitek.co.za/products/channel-admin`). A Growth user is never created as an
  Agents account or workspace owner by this route.
- A reused request ID returns the stored response. The same ID with different input returns 409. A
  Telegram bot already connected to the workspace is rejected before a second webhook can replace
  the first.
- Bot tokens never appear in Responses, Growth projections, logs or the request results table.

## Validation

Run on Node 23.11.1 with the local PostgreSQL fixture (the repository requires Node 24; the
toolchain reported an engine warning but all checks completed):

```text
pnpm --filter @kasitek-labs/contracts build
node --test packages/contracts/tests/growth-channel-admin.test.mjs
  tests 3, pass 3

products/agents/api: pnpm exec vitest run test/growth-channel-admin.test.ts test/channel-store.test.ts test/channel-routes.test.ts test/telegram-setup.test.ts
  test files 4, tests 27, pass 27

products/growth/api: pnpm exec tsx --test tests/assistant-channels.test.ts tests/telegram-projection.test.ts tests/channel-admin-client.test.ts tests/growth-agent-channel-links.test.ts
  tests 15, pass 15

pnpm --dir products/agents/api build
pnpm --dir products/growth/api build
pnpm --dir products/growth/web build
  all passed

pnpm verify:boundaries
  Product import boundaries passed for 2803 source and script files.
```

Local HTTP verification with the running stack:

- Admin `POST /api/telegram/connections` created a Telegram connection; a fake token produced
  `needs_attention` and no credential appeared in the response.
- `GET /api/assistant/channels` listed the connection against the local Growth assistant
  (`2bb1f17d-016b-4435-bcfc-ea00699a213b`); a simulated active connection linked and unlinked.
- A Growth-managed WhatsApp connection linked to the assistant and the projection/grant became
  active, then unlinked and revoked.
- A member session received `canManage=false` with HTTP 200 for both list routes and HTTP 403 for
  link and connect.
- A stale revision returned `409 agent_channel_conflict`; a duplicate bot returned
  `409 telegram_bot_already_connected`; a cross-workspace connection returned 403/404 without
  crossing tenants.

`member-channels.test.ts` has two pre-existing failures on the current `main` checkout
(`2 failed | 42 passed`). They reproduce with the channel-store change stashed and are unrelated to
this release.

## Known gaps

- Live Telegram acceptance needs a real BotFather token. The owner must supply it and send a
  message to the connected bot in production.
- WhatsApp inbound/outbound acceptance needs the production KasiAI number and a real message.
- `AGENTS_CHANNEL_WEBHOOK_ORIGIN` must exist on the production Agents API before Telegram setup is
  available.
- Browser-level responsive checks for the new dialog were reviewed in source; a full Playwright
  visual pass is not part of this record.

## Rollout

1. Apply Agents schema 150 and 151 through `setup:db` against the intended database.
2. Set `AGENTS_CHANNEL_WEBHOOK_ORIGIN` on the Agents API and worker.
3. Deploy Agents API and worker from the reviewed commit.
4. Deploy the Growth API and Growth web from the same commit.
5. Connect a real Telegram bot, link it to the Growth assistant, send a message and confirm the
   reply. Link and unlink the KasiAI WhatsApp number and confirm routing.

Deployment IDs, commit identity and production health results are appended after the release.

## Rollback

Deploy the previous Agents API/worker and Growth API/web artifacts together. The additive schema
remains, so a previous Agents build ignores the new offering and request table. Existing Telegram
deployments continue to route until they are unbound or the bot webhook is removed with the bot
owner's token. Existing WhatsApp grants continue to use the previous Growth-managed path. No
destructive data migration is required.
