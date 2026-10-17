---
title: MCP Integration
owner: engineering
last_reviewed: 2026-10-17
---

# MCP integration

Growth MCP access is unavailable. The standalone Agents MCP gateway, local stdio bridge, and
package have been removed. Their old endpoint and setup commands are no longer supported.
Developer API keys remain available for the Growth REST API. See the [public API overview](./public-v1.md).

The target distinguishes external agents calling product MCP with OAuth or deliberately scoped
keys, product backends calling shared execution, and executing agents calling typed delegated
product APIs. Growth product OAuth MCP is not implemented. The target reference is
`products/agents/docs/architecture/agent-platform-architecture.md` in the repository.

## Current outbound MCP provider connections

Hosted agent configuration exposes a reviewed MCP directory under **Capabilities → Connections**.
The directory is metadata only until the user selects an entry. HTTP servers can be connected from
the directory; entries that require OAuth use protected-resource metadata, authorization-server
discovery, PKCE, and the provider's dynamic client registration when available. API-key servers
store the key in the encrypted credential vault. After connection, KasiTek discovers and publishes
an immutable provider revision before it can be pinned to an agent version.

Native service bindings use the same connection cards and activation flow. Platform-owned OAuth
clients are configured by the deployment; Studio starts the provider flow and does not ask users
for client IDs or secrets.

If a provider does not support dynamic registration, Studio exposes an OAuth client ID and
optional client secret and continues the same PKCE flow with those credentials. Client secrets
remain in encrypted one-use OAuth state until the token exchange completes.

Set `MCP_OAUTH_REDIRECT_URI` to the public Core callback URL
(`/api/agents/integrations/mcp/oauth/callback`) for the environment running Agents. Use a
separate value for local/tunnel, staging, and production. The production value is
`https://api.kasitek.co.za/api/agents/integrations/mcp/oauth/callback`; local development must use
the public tunnel or proxy URL, not `127.0.0.1`, when the provider requires an HTTPS callback.
Core forwards the one-use callback to the private Agents API and returns the browser to Studio.
`AGENT_INTEGRATIONS_RETURN_URL` is only needed when calling the private Agents callback directly.

The directory also accepts a custom HTTPS MCP endpoint for providers that are not in the reviewed
catalogue. Stdio manifests are shown for discovery but are unavailable until a managed stdio
execution adapter is registered. Browsing or connecting a server does not grant every discovered
tool; the agent version still selects the pinned revision and its grants.

## Workspace media

Granted installations can discover `kasitek.core.content_media_get` for organization-scoped media
metadata and `kasitek.core.content_media_preview` for a short-lived preview URL. Media returned by
content tools is identified by a stable `assetId`; preview URLs are transport values and must not be
stored in agent state, messages, or external caches.

Hosted-agent replies use the shared `AgentResponse@1` envelope:

```json
{
  "version": "1",
  "text": "Here is the image.",
  "media": [{ "assetId": "core-asset-id", "kind": "image", "disposition": "inline" }]
}
```

The hosted harness validates the asset against the current workspace before completing the run.
Channel gateways then select native media delivery or an explicit provider fallback. Older text-only
responses remain supported during the compatibility window.
