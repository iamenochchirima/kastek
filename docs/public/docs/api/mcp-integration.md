---
title: MCP Integration
owner: engineering
last_reviewed: 2026-08-25
---

# KasiTek MCP Integration

For the product-level choice between KasiAi, hosted user agents, and external runtimes, see the
[agent connection guide](./agent-connection-guide.md).

The hosted endpoint is `https://agents.kasitek.co.za/mcp`. It is a Streamable HTTP JSON-RPC
transport backed by the stateless gateway. The gateway forwards no credentials into prompts and has
no database or Temporal ownership.

Modern clients use the stateless MCP protocol revision `2026-07-28`. KasiTek retains the
initialize-based `2025-06-18` compatibility path during migration. The gateway rejects unsupported
revisions and advertises supported revisions in the response. Both paths use POST JSON-RPC requests;
standalone GET streaming, resumable sessions, and `Mcp-Session-Id` are not advertised.

1. Create a named Developer API key in Developers → API Keys.
2. Send it as `Authorization: Bearer <developer-api-key>` with every JSON-RPC request. For local
   stdio clients, set `KASITEK_API_KEY` and let the bridge forward it.
3. Use the returned manifest schemas to build arguments. The key's workspace access, capability
   grants, availability, and approval policy filter discovery and calls; denied or unavailable
   tools return a structured JSON-RPC error.

For the 2026 stateless path, include the protocol revision and method metadata in the request:

```http
POST /mcp HTTP/1.1
MCP-Protocol-Version: 2026-07-28
Mcp-Method: tools/call
Mcp-Name: platform.current_time
Accept: application/json, text/event-stream
Authorization: Bearer <developer-api-key>
```

The JSON-RPC `_meta` object carries the client protocol version and capabilities. The gateway and
Agent API validate mirrored transport metadata and reject mismatches. The 2025 compatibility path
continues to use `initialize`, `tools/list`, and `tools/call` for clients that have not migrated.

The 2026 path exposes `server/discover`; tool discovery is installation-filtered and deterministic.
The gateway may return durable task handles for clients that advertise the Tasks extension. Clients
that do not advertise it receive the structured KasiTek operation result and status reference.

The stateless rollout is controlled independently in the Agent API and gateway with
`MCP_STATELESS_ENABLED` and `MCP_GATEWAY_STATELESS_ENABLED`. They default on in development and
test and off in production unless explicitly enabled. Disabling the stateless path preserves the
2025 compatibility path.

The Agent Platform owns runs, approvals, effects, and audit records. A tool call never receives
direct database access. External-effect calls require their declared approval and are represented by
an idempotent effect receipt; ambiguous provider outcomes are surfaced for reconciliation rather
than blindly retried.

For clients that support it, `/.well-known/oauth-protected-resource` and
`/.well-known/agent-installation-jwks.json` publish protected-resource and signing-key metadata.
The local stdio bridge should forward the same JSON-RPC messages to the hosted endpoint rather than
implementing a second capability registry.

## Agent Studio MCP directory

Hosted agent configuration exposes a reviewed MCP directory under **Capabilities → Connections**.
The directory is metadata only until the user selects an entry. HTTP servers can be connected from
the directory; entries that require OAuth use protected-resource metadata, authorization-server
discovery, PKCE, and the provider's dynamic client registration when available. API-key servers
store the key in the encrypted credential vault. After connection, KasiTek discovers and publishes
an immutable provider revision before it can be pinned to an agent version.

If a provider does not support dynamic registration, Studio exposes an OAuth client ID and
optional client secret and continues the same PKCE flow with those credentials. Client secrets
remain in encrypted one-use OAuth state until the token exchange completes.

Set `MCP_OAUTH_REDIRECT_URI` to the public Core callback URL
(`/api/agents/integrations/mcp/oauth/callback`) and register that exact URL with the provider.
Core forwards the one-use callback to the private Agents API and returns the browser to Studio.
`AGENT_INTEGRATIONS_RETURN_URL` is only needed when calling the private Agents callback directly.

The directory also accepts a custom HTTPS MCP endpoint for providers that are not in the reviewed
catalogue. Stdio manifests are shown for discovery but are unavailable until a managed stdio
execution adapter is registered. Browsing or connecting a server does not grant every discovered
tool; the agent version still selects the pinned revision and its grants.

The standalone `@kasitek/mcp` package follows the same boundary for MCP clients that require a
local command-launched server. It accepts `KASITEK_MCP_URL` and `KASITEK_API_KEY`, forwards bounded
JSON-RPC traffic, and does not contain KasiTek tools, policy, product data, or REST client logic.
Clients that support remote Streamable HTTP do not need the package. REST remains a separate API
and SDK/CLI surface.

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

## Installation identity

The Developer API key is the only user-facing MCP credential. On first use, the Agent Platform
creates a workspace-scoped internal `external_connected` installation for the key. This preserves
installation-level capability, approval, audit, and activity records without requiring the user to
manage a second secret or token. This flow never selects KasiAi or a KasiTek-hosted user agent.
