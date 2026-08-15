# Agent connection guide

KasiTek has three agent modes. Choose the setup flow that matches who runs the reasoning runtime.

| Mode | Who runs it | Where it is configured | How it reaches KasiTek |
| --- | --- | --- | --- |
| KasiAi (`system_hosted`) | KasiTek | KasiAi details | KasiTek platform conversations and managed channels |
| Hosted user agent (`kasitek_hosted`) | KasiTek on the customer’s behalf | Create hosted agent and its details | Platform chat, supported channels, schedules, and hosted runtime |
| External agent (`external_connected`) | The customer’s runtime | Connect external agent | Dedicated MCP or REST installation credential |

## Connect an external agent

Use **Agents → Connect external agent** when an agent already runs in Codex, Claude Code, n8n, or
another customer-controlled runtime and needs to call KasiTek capabilities.

1. Identify the external runtime and choose MCP, REST, or both.
2. Review the live service catalog and select only registered, currently available capabilities;
   apply optional resource or connector narrowing.
3. Create a read-only credential by default. Add write scope only when the runtime is approved for
   changes.
4. Copy the one-time installation secret. It is never shown again.
5. Exchange the secret for a short-lived audience-bound MCP or REST token. Do not use the installation
   secret as a long-lived bearer token.
6. Use discovery to confirm the exact grants and effective-access reason codes, then invoke through
   the dedicated installation. Pause, rotate, or revoke from the external installation details.

This flow creates a new `external_connected` identity. It never selects, modifies, or creates a
KasiAi or hosted user-agent installation.

## Configure KasiAi channels

Open the protected KasiAi details page and configure the workspace’s optional Telegram, Discord, or
WhatsApp connection there. Channel provider credentials remain in the connection vault. KasiAi does
not receive MCP/REST installation credentials and does not appear in the external-agent wizard.

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
