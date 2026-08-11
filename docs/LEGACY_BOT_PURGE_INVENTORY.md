# Legacy Bot Purge Inventory

**Recorded:** 2026-08-11  
**Scope:** Direct KasiTek product legacy `/api/bots` and n8n bot provisioning  
**Replacement:** `agents/` Agent Platform and the authenticated `kasitek-core` bridge

## Database state before cutover

Read-only counts from the configured `kasitek-core` database:

| Legacy table | Rows |
| --- | ---: |
| `BotConfiguration` | 0 |
| `BotDeployment` | 0 |
| `BotEvent` | 0 |

No legacy bot records need conversion into Agent Platform definitions. The cutover plan therefore
uses an explicit destructive migration instead of a data importer.

## Client callers to replace

- `client/apps/client/src/app/(dashboard)/agents/page.tsx`
  - lists agents through `GET /api/bots`;
  - also loads WhatsApp connections for the legacy creation form.
- `client/apps/client/src/components/dashboard/agents/agents-page-client.tsx`
  - creates bots through `POST /api/bots`;
  - deploys, pauses, resumes, and retries through `POST /api/bots/:id/actions`;
  - contains the legacy bot types, templates, creation form, and n8n deployment presentation.
- `client/apps/client/src/app/(dashboard)/agents/activity/page.tsx`
  - reads `GET /api/bots/activity`.
- `client/apps/client/src/app/(dashboard)/agents/analytics/page.tsx`
  - derives counts and status from `GET /api/bots`.

The route paths can remain as product URLs, but their implementations and contracts must be
replaced completely.

## `kasitek-core` routes and modules to remove

- `server/kasitek-core/src/routes.rs`
  - complete `/api/bots` route scope;
  - deployment callback and trusted event routes.
- `server/kasitek-core/src/controllers/bots.rs`
  - CRUD, actions, callback authentication, and event endpoints.
- `server/kasitek-core/src/services/bots.rs`
  - legacy persistence, deployment state, activity, and n8n dispatch.
- `server/kasitek-core/src/services/agents/client.rs`
  - n8n REST client.
- `server/kasitek-core/src/services/agents/provisioning.rs`
  - legacy bot-to-n8n provisioning and callback construction.
- `server/kasitek-core/src/services/agents/templates.rs`
  - n8n workflow JSON templates.
- `server/kasitek-core/src/services/agents/types.rs`
  - n8n dispatch and callback payloads.
- `server/kasitek-core/src/services/agents/mod.rs`
  - remove if empty after the old provisioning modules are deleted.
- `server/kasitek-core/src/controllers/mod.rs` and `server/kasitek-core/src/services/mod.rs`
  - remove legacy module exports.
- `server/kasitek-core/src/db/models.rs`
  - remove legacy bot request and database row types.

`server/kasitek-core/src/controllers/agent_internal.rs` is not legacy provisioning. It is the new
authenticated Tool Gateway boundary and must remain.

## Queries requiring replacement before table removal

- `server/kasitek-core/src/controllers/workspace.rs`
  - `BOT_COUNT_SQL` reads `BotConfiguration`;
  - attention metrics read `BotDeployment`.
- `server/kasitek-core/src/services/customers.rs`
  - customer activity joins `BotEvent` and `BotConfiguration`.
- Agent activity and analytics product pages depend on the old controller responses.

These reads must move to Agent Platform summaries/events or be removed before the database
migration drops the tables.

## Prisma schema and generated code

- Remove `BotConfiguration`, `BotEvent`, and `BotDeployment` from
  `client/packages/database/prisma/schema.prisma`.
- Remove their relations from `User`, `Organization`, and `Customer`.
- Add a new destructive migration; do not edit applied historical migrations.
- Regenerate the Prisma client so no live generated bot model remains.

Historical migrations that mention the old tables remain immutable and are excluded from the
post-cutover static source check.

## Configuration to remove after route deletion

- `N8N_API_URL`
- `N8N_API_KEY`
- `N8N_CALLBACK_TOKEN`
- their fields and loaders in `server/kasitek-core/src/config.rs`

`N8N_CHAT_WEBHOOK_URL` belongs to the separate legacy chat controller and requires its own caller
check before removal. It is not silently removed as part of the bot-table migration.

## No-fallback proof

The final cutover check must fail on these symbols in live client/core source:

- `/api/bots`
- `BotConfiguration`
- `BotDeployment`
- `BotEvent`
- the old `services::bots` module;
- the old n8n `services::agents` provisioning modules.

Allowed references after cutover are limited to historical migration files and engineering
documentation that records the removal.
