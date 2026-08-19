# KasiTek MCP integration

For the product-level choice between KasiAi, hosted user agents, and external runtimes, see the
[agent connection guide](./agent-connection-guide.md).

The hosted endpoint is `https://agents.kasitek.co.za/mcp`. It is a Streamable HTTP JSON-RPC
transport backed by the stateless gateway. The gateway forwards no credentials into prompts and has
no database or Temporal ownership.

The supported MCP protocol revision is `2025-06-18`. Send it in the `MCP-Protocol-Version` header
when the client supports negotiation. The gateway rejects unsupported revisions and advertises the
supported revision in the response header. The initial deployment supports POST JSON-RPC requests;
GET streaming and resumable sessions are intentionally not advertised yet.

1. Create a named Developer API key in Developers → API Keys.
2. Send it as `Authorization: Bearer <developer-api-key>` with every JSON-RPC request, including
   `initialize`. For local stdio clients, set `KASITEK_API_KEY` and let `@kasitek/mcp` forward it.
3. Use the returned manifest schemas to build arguments. The key's workspace access, capability
   grants, availability, and approval policy filter discovery and calls; denied or unavailable
   tools return a structured JSON-RPC error.

The Agent Platform owns runs, approvals, effects, and audit records. A tool call never receives
direct database access. External-effect calls require their declared approval and are represented by
an idempotent effect receipt; ambiguous provider outcomes are surfaced for reconciliation rather
than blindly retried.

For clients that support it, `/.well-known/oauth-protected-resource` and
`/.well-known/agent-installation-jwks.json` publish protected-resource and signing-key metadata.
The local stdio bridge should forward the same JSON-RPC messages to the hosted endpoint rather than
implementing a second capability registry.

The standalone `@kasitek/mcp` package follows the same boundary for MCP clients that require a
local command-launched server. It accepts `KASITEK_MCP_URL` and `KASITEK_API_KEY`, forwards bounded
JSON-RPC traffic, and does not contain KasiTek tools, policy, product data, or REST client logic.
Clients that support remote Streamable HTTP do not need the package. REST remains a separate API
and SDK/CLI surface.

## Installation identity

The Developer API key is the only user-facing MCP credential. On first use, the Agent Platform
creates a workspace-scoped internal `external_connected` installation for the key. This preserves
installation-level capability, approval, audit, and activity records without requiring the user to
manage a second secret or token. This flow never selects KasiAi or a KasiTek-hosted user agent.
