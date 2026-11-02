# Agent connection guide

For an OAuth-capable MCP client, add the endpoint shown in **Developers → MCP**, sign in and
approve a workspace and permissions. See [MCP integration](./mcp-integration.md) for token
lifecycle, scopes and exact-review execution.

For REST automation, use the same Growth OAuth connection or create a workspace Developer API
key in **Developers → API Keys**. See [Agent REST](./agent-rest.md) and [Public API v1](./public-v1.md).
All transports share canonical operation schemas, authorization and review policy. Internal
Growth agents call those operations directly without an MCP network hop.

Connections remain scoped to Growth. A standalone Agents account is not required for embedded
Growth agents. Standalone Agents retains its separate workspace, configuration and deployment
journey, documented in `products/agents/README.md` in the repository. Retired installation,
local bridge and Studio callback instructions are unsupported.
