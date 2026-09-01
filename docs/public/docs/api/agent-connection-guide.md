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

Open the agent details page and configure the workspace’s optional Telegram, Discord, WhatsApp,
Facebook, or Instagram connection there. Channel provider credentials remain in the connection
vault. Hosted customer-service agents receive explicitly assigned workspace channels; personal
agents cannot receive customer channels.

### Facebook and Instagram messaging

Connect the Page or Instagram Professional account from **Connections** first. On a hosted
customer-service agent, open **Integrations**, select **Use** beside the connected account, review
the connection and webhook status, then select **Use for agent**. The assignment uses the internal
workspace connection and does not copy a Meta access token into Agent Platform.

Inbound text messages are persisted in Inbox and routed to the assigned agent. Agent text replies
are delivered by Core using the existing Meta connection. The first release supports text replies;
media, reactions, and approval buttons remain on their provider-specific Inbox paths.

If the account is not connected or needs attention, use **Open connections** in the access dialog,
restore the Meta connection, and return to the agent details page. Only one active customer-service
agent may own a Page or Instagram account route at a time.

### Telegram setup

Telegram uses two intentional modes:

- Personal (`system_hosted`): the workspace user enters a BotFather bot token, requests a pairing
  code, and sends `/start <code>` to the bot, or configures one or more numeric Telegram user IDs
  as the allowlist. Only those Telegram identities are bound to the personal agent.
- Business (`kasitek_hosted`): the workspace user enters a BotFather bot token. Customers can
  message the bot without pairing; each Telegram identity and chat becomes its own customer
  conversation.

The user provides only the bot token. KasiTek validates it with Telegram, encrypts it, creates the
webhook secret, and registers the webhook. The platform must provide:

```text
AGENTS_CREDENTIAL_ENCRYPTION_KEY=<32-byte key, base64 or 64-character hex>
TELEGRAM_WEBHOOK_BASE_URL=https://<public-core-origin>
```

`TELEGRAM_WEBHOOK_BASE_URL` must be reachable by Telegram and must route to `kasitek-core`; in
production this is the public Core origin, not the client application origin. For personal
WhatsApp connections, allowed phone values use international digits without `+`; if no allowlist
is configured, the one-time pairing flow remains available. The Agent Platform and Core still
share their existing `INTERNAL_AUTH_SECRET` / `AGENTS_INTERNAL_AUTH_SECRET` bridge secret. Users
should never be asked for a Telegram webhook secret or Telegram API URL.

### Inbound attachments

Telegram and WhatsApp agent channels accept image, video, and audio attachments. Telegram files
sent with a generic MIME type are identified from their filename when possible. Unsupported
document types receive an explicit response instead of being passed to the agent as an incomplete
attachment. Media downloads are time-limited and size-bounded.

### Agent reply formatting

Agent replies are rendered for each channel at delivery time. Telegram uses its native rich-message
format when available, including headings, lists, links, blockquotes, code, tables, and supported
rich media references, with an HTML fallback for older or incompatible API responses. WhatsApp
renders the formatting supported by text messages, including bold, italic, strikethrough, code,
lists, links, and readable table rows. Image references remain links in a text reply; sending an
actual image requires a media delivery path.

## Create a hosted user agent

Use **Agents → Create hosted agent** when KasiTek should run the agent. Define its instructions,
model, runtime limits, workflows, capabilities, knowledge, schedules, and supported channels from
the hosted-agent details page. Hosted installations do not receive MCP/REST machine credentials;
external runtimes use the separate external-agent flow above.

Hosted user installations follow the published version by default. Publishing and deployment are
separate states: a pinned installation stays on its selected version until an explicit deployment,
while a follow-published installation moves when a new version is published or rolled back. Runs
already admitted keep the version they started with.

Management clients can deploy a hosted installation explicitly with `POST
/v1/installations/{installationId}/deploy` and `{ "versionId": "...", "expectedVersionId": "..." }`.
The expected version is optional, but prevents overwriting a concurrent deployment when supplied.

### Workflow agent loops

Version 1 workflow graphs support `agent_loop` nodes. The node runs within the hosted agent's
scoped context and uses the installation's model, granted capabilities, approval policy, run
budget, and effect controls. Set `maxIterations` on the node to bound its loop and list the state
path that should receive its result in `writes` (the workflow editor defaults this to `output`).

```json
{
  "id": "draft",
  "type": "agent_loop",
  "config": { "instruction": "Draft the response from the supplied context." },
  "maxIterations": 3,
  "reads": ["input"],
  "writes": ["output"]
}
```

Approval, human handoff, and external-event pauses are stored in the workflow checkpoint and
resume at the same node. The enclosing graph limits still apply to model calls, tool calls,
tokens, estimated cost, and wall time.

## Access and health

Installation mode, grants, transport scopes, resource/connector constraints, provider readiness, and
approval requirements are rechecked by the Agent API. The preflight catalog and post-creation
discovery use the same projection. Discovery reports stable reason codes such as
`not_granted`, `credential_denied`, `provider_not_configured`, `provider_unhealthy`, and
`approval_required`. External health reports KasiTek-side installation and credential readiness; it
does not pretend to prove that the customer’s remote runtime is reachable.

Workspace connection discovery also includes a safe, provider-neutral permission summary. It may
report access as granted, requestable, unsupported, provider approval required, or unknown. Agents
must explain a missing capability and direct the user to the Connections access flow; they must not
request tokens, expose raw provider scopes, or instruct the user to disconnect by default.
Authorization-required tool results include the provider, required capability keys, and the stable
`remediation: "connections_access"` intent. When available, `connectionId` is a workspace-scoped
UI reference for opening the exact connection; it is not a provider identifier and must not be
quoted to end users. Web clients can open the connection-access experience from this contract.
WhatsApp, Telegram, Discord, and Core-backed channel adapters keep their native text, media, and
link behavior while adding the same bounded recovery action. No adapter may request tokens or
bypass provider consent or the existing approval flow.

The `kasitek.core.connections_list` capability is organization-scoped. Omit `provider` and `status`
to list every workspace connection; provide the actual provider or status only when filtering is
needed. Empty or `all` filter values are treated as omitted for compatibility.

The browser access surface is provider-neutral:

```text
GET /api/connections/{connectionId}/access
GET /api/connections/{connectionId}/access/request?capabilities=SOCIAL_PUBLISH,MEDIA_PUBLISH
```

The first route returns the safe capability inventory. The second validates product capability keys,
records a short-lived authorization attempt, and redirects to the provider's consent or setup flow.
The client does not choose provider OAuth routes for an existing connection. WhatsApp redirects to
the Connections setup surface because Embedded Signup uses a fixed provider configuration rather
than arbitrary scope checkboxes. A callback updates the existing logical connection and preserves
its local content and agent assignments.
