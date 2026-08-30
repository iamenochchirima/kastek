# Agent connection guide

KasiTek has three agent modes. Choose the setup flow that matches who runs the reasoning runtime.

| Mode | Who runs it | Where it is configured | How it reaches KasiTek |
| --- | --- | --- | --- |
| KasiAi (`system_hosted`) | KasiTek | KasiAi details | KasiTek platform conversations and managed channels |
| Hosted user agent (`kasitek_hosted`) | KasiTek on the customer’s behalf | Create hosted agent and its details | Platform chat, supported channels, schedules, and hosted runtime |
| External agent (`external_connected`) | The customer’s runtime | Developers | Workspace Developer API key for MCP or REST |

## Connect an external agent

Use **Developers** when an agent already runs in Codex, Claude Code, n8n, or another
customer-controlled runtime and needs to call KasiTek capabilities.

1. Create a named Developer API key in Developers → API Keys.
2. Configure that key in the client as a Bearer credential. The same key works for MCP and REST.
3. Use discovery to confirm the effective capabilities and access reason codes, then begin with a
   safe read. Higher-risk actions may still require approval.
4. Rotate or revoke the key from Developers when it is no longer trusted.

The first MCP request resolves an internal `external_connected` identity for the key. Users do not
configure that identity or a second credential. The flow never selects, modifies, or creates a
KasiAi or hosted user-agent installation.

## Configure KasiAi channels

Open the protected KasiAi details page and configure the workspace’s optional Telegram, Discord, or
WhatsApp connection there. Channel provider credentials remain in the connection vault. KasiAi does
not receive MCP/REST installation credentials and does not appear in the external-agent wizard.

### Telegram setup

Telegram uses two intentional modes:

- Personal (`system_hosted`): the workspace user enters a BotFather bot token, requests a pairing
  code, and sends `/start <code>` to the bot. Only that Telegram identity is bound to the personal
  agent.
- Business (`kasitek_hosted`): the workspace user enters a BotFather bot token. Customers can
  message the bot without pairing; each Telegram identity and chat becomes its own customer
  conversation.

The user provides only the bot token. KasiTek validates it with Telegram, encrypts it, creates the
webhook secret, and registers the webhook. The platform must provide:

```text
AGENTS_CREDENTIAL_ENCRYPTION_KEY=<32-byte key, base64 or 64-character hex>
TELEGRAM_WEBHOOK_BASE_URL=https://<public-core-origin>
```

`TELEGRAM_WEBHOOK_BASE_URL` must be reachable by Telegram and must route to `kasitek-core`. The
Agent Platform and core still share their existing `INTERNAL_AUTH_SECRET` /
`AGENTS_INTERNAL_AUTH_SECRET` bridge secret. Users should never be asked for a Telegram webhook
secret, Telegram API URL, or Telegram user ID.

## Create a hosted user agent

Use **Agents → Create hosted agent** when KasiTek should run the agent. Define its instructions,
model, runtime limits, workflows, capabilities, knowledge, schedules, and supported channels from
the hosted-agent details page. Hosted installations do not receive MCP/REST machine credentials;
external runtimes use the separate external-agent flow above.

## Access and health

Installation mode, grants, transport scopes, resource/connector constraints, provider readiness, and
approval requirements are rechecked by the Agent API. The preflight catalog and post-creation
discovery use the same projection. Discovery reports stable reason codes such as
`not_granted`, `credential_denied`, `provider_not_configured`, `provider_unhealthy`, and
`approval_required`. External health reports KasiTek-side installation and credential readiness; it
does not pretend to prove that the customer’s remote runtime is reachable.

The `kasitek.core.connections_list` capability is organization-scoped. Omit `provider` and `status`
to list every workspace connection; provide the actual provider or status only when filtering is
needed. Empty or `all` filter values are treated as omitted for compatibility.
