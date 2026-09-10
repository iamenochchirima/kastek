# Shared workspace email connections

Google and Microsoft mailboxes use one workspace-owned connection record. Core stores encrypted
OAuth material in `EmailConnection` and projects a safe `ExternalConnection` record. Inbox and
Agent Platform keep product bindings only; neither service stores a second provider token.

## Entry points

- `GET /api/email/providers` returns Google, Microsoft, and Custom Email (`coming_soon`).
- `GET /api/email/connections` returns safe workspace mailbox summaries.
- `GET /api/email/oauth/{provider}/start` starts an authenticated workspace OAuth flow.
- `GET /api/email/oauth/{provider}/callback` completes the Core-owned Inbox flow.
- Agent OAuth callbacks are proxied through Core and call the internal email connection upsert
  boundary before creating the installation binding.
- The Studio Connections tab reads the same workspace mailbox list as Inbox. Visibility is
  discovery only; selecting a provider capability still creates the explicit Agent binding. When
  a mailbox already exists, Studio's `Use` action calls the workspace-email binding route and
  reuses the opaque Core connection ID without another OAuth exchange.

## Runtime contract

The model-facing tools are `kasitek.email.search`, `kasitek.email.read`,
`kasitek.email.send`, and `kasitek.email.reply`. They carry an optional provider/account selector.
Core resolves the canonical connection, refreshes its encrypted token when required, and dispatches
to the Google Gmail or Microsoft Graph adapter. Tool results retain provider and account labels;
credentials, raw provider IDs, and tokens are never returned to the model.

Sending and replying remain approval-gated. A workspace connection does not silently grant an agent;
the installation binding and its Playground-to-Live deployment still control Agent access.

The historical `google.gmail` capability remains as a compatibility alias for existing drafts, but
its new OAuth callback and runtime search route through the canonical Google workspace connection.
It does not create a second credential record. Inbox conversation synchronization and message-thread
projection are intentionally a separate adapter slice; until that slice is enabled, a connected
mailbox can be discovered and used by the Agent email tools but does not claim that Inbox has synced
all messages.

## Local rollout

Apply the Prisma migrations in `client/packages/database/prisma/migrations`, run Core and Agents
locally, and use the existing development proxy/tunnel for browser OAuth callbacks. Custom Email is
shown as Coming soon until an IMAP/SMTP adapter and its sync/reply contract exist.
